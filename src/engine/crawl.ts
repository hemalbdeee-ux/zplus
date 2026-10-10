// Downloads the site from the archive.
//
// 1. The CDX index tells us which URLs exist; for each URL we keep the one capture closest to the
//    target date inside the good window (earlier captures win ties: the site was healthier then).
// 2. Starting at the homepage we follow links breadth-first, so pages the site actually linked
//    come first. 3. Pages nobody linked any more ("orphans", often the ones with backlinks) are
//    added after that, until the URL budget is spent.
//
// Every response body is stored under work/raw so a stopped job resumes without refetching.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveClient, Capture } from './archive.ts';
import { decodeText } from './charset.ts';
import { collectUrls, cssUrls, loadHtml } from './html.ts';
import { isInternal, pathAndQuery, toUrl, tsSeconds, unwrapWayback, urlKey } from './url.ts';

export interface Resource {
  key: string;
  /** Absolute original URL as captured. */
  url: string;
  /** Path plus query exactly as the site served it. */
  path: string;
  timestamp: string;
  /** 200, or the redirect status the original site answered with. */
  status: number;
  contentType?: string;
  file?: string;
  size?: number;
  sha1?: string;
  /** Redirect target (absolute URL). */
  location?: string;
  via: 'seed' | 'link' | 'index';
}

export interface Missing {
  key: string;
  url: string;
  reason: string;
  referrer?: string;
}

export interface Manifest {
  version: 1;
  domain: string;
  target: string;
  window: { from?: string; to?: string };
  indexSize: number;
  truncated: boolean;
  resources: Resource[];
  missing: Missing[];
}

export interface CrawlOptions {
  domain: string;
  target: string;
  window: { from?: string; to?: string };
  workDir: string;
  maxUrls: number;
  /** Demo mode: stop after this many HTML pages (their images and CSS still come along). */
  maxPages?: number;
  orphans: boolean;
  workers?: number;
  log?: (msg: string) => void;
  progress?: (p: { done: number; queued: number; current: string }) => void;
}

const SKIP_PATH = /\/(wp-admin|wp-json|cgi-bin|trackback)(\/|$)|\/(wp-login|xmlrpc|wp-cron)\.php|[?&](replytocom|share|action=edit)=/i;
const GENERATED = new Set(['/robots.txt', '/sitemap.xml']);
const MAX_QUERY_VARIANTS = 200;

export function isHtmlType(contentType: string | undefined, mimetype?: string): boolean {
  const t = (contentType || mimetype || '').toLowerCase();
  return t.includes('text/html') || t.includes('application/xhtml');
}

export function isCssType(contentType: string | undefined, url: string): boolean {
  return (contentType ?? '').toLowerCase().includes('text/css') || /\.css(\?|$)/i.test(url);
}

function rank(c: Capture, targetSec: number): number {
  const d = tsSeconds(c.timestamp) - targetSec;
  let r = d > 0 ? d * 1.5 : -d;
  if (/^3/.test(c.statuscode)) r += 30 * 86_400;
  return r;
}

function inWindow(ts: string, w: { from?: string; to?: string }): boolean {
  return (!w.from || ts >= w.from) && (!w.to || ts <= w.to);
}

export async function buildIndex(client: ArchiveClient, opts: Pick<CrawlOptions, 'domain' | 'target' | 'window' | 'log'>): Promise<Map<string, Capture>> {
  const targetSec = tsSeconds(opts.target);
  const index = new Map<string, Capture>();
  let rows = 0;
  for await (const page of client.cdx({
    url: `${opts.domain}/`,
    matchType: 'prefix',
    from: opts.window.from,
    to: opts.window.to,
    filters: ['!statuscode:[45]..'],
  })) {
    for (const c of page) {
      rows++;
      if (c.statuscode !== '-' && !/^[23]\d\d$/.test(c.statuscode)) continue;
      if (!inWindow(c.timestamp, opts.window)) continue;
      const u = toUrl(c.original);
      if (!u || !isInternal(u, opts.domain)) continue;
      const key = urlKey(u);
      const cur = index.get(key);
      if (!cur || rank(c, targetSec) < rank(cur, targetSec)) index.set(key, c);
    }
    opts.log?.(`index: ${rows} captures read, ${index.size} distinct URLs`);
  }
  return index;
}

function hashKey(key: string): string {
  return createHash('sha1').update(key).digest('hex');
}

function normalizeRedirectStatus(s: number): number {
  return [301, 302, 303, 307, 308].includes(s) ? s : 302;
}

export async function crawl(client: ArchiveClient, index: Map<string, Capture>, opts: CrawlOptions): Promise<Manifest> {
  const log = opts.log ?? (() => {});
  const rawDir = path.join(opts.workDir, 'raw');
  await mkdir(rawDir, { recursive: true });
  const manifestPath = path.join(opts.workDir, 'manifest.json');

  // Resume: reuse bodies fetched by an earlier run with the same target and window.
  const previous = new Map<string, Resource>();
  if (existsSync(manifestPath)) {
    try {
      const old = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
      if (old.domain === opts.domain && old.target === opts.target && JSON.stringify(old.window) === JSON.stringify(opts.window)) {
        for (const r of old.resources) if (!r.file || existsSync(path.join(rawDir, r.file))) previous.set(r.key, r);
        log(`resuming: ${previous.size} URLs already downloaded`);
      }
    } catch {
      // A damaged manifest only costs a refetch.
    }
  }

  const manifest: Manifest = {
    version: 1,
    domain: opts.domain,
    target: opts.target,
    window: opts.window,
    indexSize: index.size,
    truncated: false,
    resources: [],
    missing: [],
  };

  type Item = { key: string; url: string; referrer?: string; via: Resource['via']; html?: boolean };
  const queues: Item[][] = [[], [], []];
  const seen = new Set<string>();
  const variants = new Map<string, number>();
  let processed = 0;
  let pages = 0;
  let inFlight = 0;
  let orphansAdded = !opts.orphans;
  let wake: (() => void) | null = null;

  const enqueue = (u: URL, prio: number, via: Item['via'], referrer?: string) => {
    if (!isInternal(u, opts.domain)) return;
    const key = urlKey(u);
    if (seen.has(key)) return;
    const pq = pathAndQuery(u);
    if (SKIP_PATH.test(pq) || GENERATED.has(u.pathname)) return;
    if (pq.includes('?')) {
      const n = (variants.get(u.pathname) ?? 0) + 1;
      if (n > MAX_QUERY_VARIANTS) return;
      variants.set(u.pathname, n);
    }
    seen.add(key);
    const cap = index.get(key);
    queues[prio].push({ key, url: cap?.original ?? u.toString(), referrer, via, html: cap ? isHtmlType(undefined, cap.mimetype) : undefined });
    wake?.();
  };

  const next = (): Item | undefined => {
    for (const q of queues) {
      while (q.length) {
        const item = q.shift()!;
        if (opts.maxPages !== undefined && pages >= opts.maxPages && item.html !== false) continue;
        return item;
      }
    }
    return undefined;
  };

  const save = async () => {
    const tmp = manifestPath + '.tmp';
    await writeFile(tmp, JSON.stringify(manifest));
    await rename(tmp, manifestPath);
  };

  const discover = (body: Buffer, contentType: string, pageUrl: string, key: string) => {
    let urls: string[] = [];
    let base = pageUrl;
    if (isHtmlType(contentType)) {
      const { text } = decodeText(body, contentType);
      const $ = loadHtml(text);
      const baseHref = $('base[href]').attr('href');
      if (baseHref) base = toUrl(unwrapWayback(baseHref), pageUrl)?.toString() ?? pageUrl;
      urls = collectUrls($);
    } else if (isCssType(contentType, pageUrl)) {
      urls = cssUrls(body.toString('latin1'));
    }
    for (const raw of urls) {
      const u = toUrl(unwrapWayback(raw.trim()), base);
      if (u) enqueue(u, 0, 'link', key);
    }
  };

  const handle = async (item: Item) => {
    const cap = index.get(item.key);
    const reuse = previous.get(item.key);
    const u = new URL(item.url);
    const base: Omit<Resource, 'timestamp' | 'status'> = { key: item.key, url: item.url, path: pathAndQuery(u), via: item.via };

    if (reuse) {
      manifest.resources.push(reuse);
      if (reuse.status === 200 && reuse.file) {
        if (isHtmlType(reuse.contentType)) pages++;
        discover(await readFile(path.join(rawDir, reuse.file)), reuse.contentType ?? '', reuse.url, reuse.key);
      } else if (reuse.location) {
        const t = toUrl(reuse.location);
        if (t) enqueue(t, 0, 'link', reuse.key);
      }
      return;
    }

    const res = await client.fetchCapture(cap?.timestamp ?? opts.target, item.url);
    if (res.kind !== 'missing' && !cap && !inWindow(res.timestamp, opts.window)) {
      manifest.missing.push({ key: item.key, url: item.url, reason: 'only archived outside the good period', referrer: item.referrer });
      return;
    }
    if (res.kind === 'ok') {
      const file = hashKey(item.key);
      await writeFile(path.join(rawDir, file), res.body);
      const sha1 = createHash('sha1').update(res.body).digest('hex');
      manifest.resources.push({ ...base, timestamp: res.timestamp, status: 200, contentType: res.contentType, file, size: res.body.length, sha1 });
      if (isHtmlType(res.contentType)) pages++;
      discover(res.body, res.contentType, item.url, item.key);
    } else if (res.kind === 'redirect') {
      const status = cap && /^3/.test(cap.statuscode) ? Number(cap.statuscode) : res.status;
      const target = toUrl(res.location, item.url);
      manifest.resources.push({ ...base, timestamp: res.timestamp, status: normalizeRedirectStatus(status), location: target?.toString() ?? res.location });
      if (target) enqueue(target, 0, 'link', item.key);
    } else {
      manifest.missing.push({ key: item.key, url: item.url, reason: res.reason, referrer: item.referrer });
    }
  };

  const home = toUrl(`http://${opts.domain}/`)!;
  enqueue(home, 0, 'seed');

  const worker = async () => {
    for (;;) {
      if (processed >= opts.maxUrls) return;
      let item = next();
      if (!item && !orphansAdded && inFlight === 0) {
        orphansAdded = true;
        const rest = [...index.entries()].filter(([k]) => !seen.has(k));
        for (const [, c] of rest) {
          const u = toUrl(c.original);
          if (u) enqueue(u, isHtmlType(undefined, c.mimetype) ? 1 : 2, 'index');
        }
        if (rest.length) log(`following ${rest.length} more URLs from the archive index that no page links to`);
        item = next();
      }
      if (!item) {
        if (inFlight === 0) return;
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 250);
        });
        wake = null;
        continue;
      }
      inFlight++;
      processed++;
      try {
        opts.progress?.({ done: processed, queued: queues.reduce((n, q) => n + q.length, 0), current: item.url });
        await handle(item);
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        manifest.missing.push({ key: item.key, url: item.url, reason: (err as Error).message, referrer: item.referrer });
      } finally {
        inFlight--;
        wake?.();
      }
      if (processed % 50 === 0) await save();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.workers ?? client.concurrency) }, worker));

  const left = queues.reduce((n, q) => n + q.length, 0);
  if (left > 0 || processed >= opts.maxUrls) {
    manifest.truncated = left > 0;
    if (left > 0) log(`URL limit reached: ${left} URLs were not downloaded`);
  }
  await save();
  return manifest;
}
