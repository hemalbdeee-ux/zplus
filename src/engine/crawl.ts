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
import type { ArchiveClient, Capture, CaptureResult } from './archive.ts';
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
  /** archive.org failed or refused the request (429, 5xx, network): a later run may get it. */
  transient?: boolean;
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

export interface IndexedCapture extends Capture {
  /**
   * When the chosen capture is a 3xx: the best in-window capture of the same URL that is not one.
   * Replay of a 3xx can land elsewhere (see crawl), and then this one is fetched instead.
   */
  alt?: Capture;
}

/** One capture per URL key; `truncated` is set when reading stopped at the size limit. */
export type CaptureIndex = Map<string, IndexedCapture> & { truncated?: boolean };

const SKIP_PATH = /\/(wp-admin|wp-json|cgi-bin|trackback)(\/|$)|\/(wp-login|xmlrpc|wp-cron)\.php|[?&](replytocom|share|action=edit)=/i;
const GENERATED = new Set(['/robots.txt', '/sitemap.xml']);
const MAX_QUERY_VARIANTS = 200;
/** This many archive failures in a row (429, 5xx, network) mean archive.org is refusing us. */
const MAX_FAILURE_STREAK = 20;
const REVISIT = 'warc/revisit';

export function isHtmlType(contentType: string | undefined, mimetype?: string): boolean {
  const t = (contentType || mimetype || '').toLowerCase();
  return t.includes('text/html') || t.includes('application/xhtml');
}

export function isCssType(contentType: string | undefined, url: string): boolean {
  return (contentType ?? '').toLowerCase().includes('text/css') || /\.css(\?|$)/i.test(url);
}

/**
 * Is a CDX row HTML? undefined when the row does not say: a deduplicated repeat capture is listed
 * as "warc/revisit" (status "-") whatever its content, and "unk" means the crawler did not know.
 */
export function cdxHtml(mimetype: string): boolean | undefined {
  const t = mimetype.trim().toLowerCase();
  if (!t || t === REVISIT || t === 'unk' || t === '-') return undefined;
  return isHtmlType(undefined, t);
}

const isRedirect = (c: Capture) => /^3/.test(c.statuscode);

function rank(c: Capture, targetSec: number): number {
  const d = tsSeconds(c.timestamp) - targetSec;
  let r = d > 0 ? d * 1.5 : -d;
  if (isRedirect(c)) r += 30 * 86_400;
  return r;
}

function inWindow(ts: string, w: { from?: string; to?: string }): boolean {
  return (!w.from || ts >= w.from) && (!w.to || ts <= w.to);
}

export async function buildIndex(
  client: ArchiveClient,
  opts: Pick<CrawlOptions, 'domain' | 'target' | 'window' | 'log'> & { maxIndexUrls?: number },
): Promise<CaptureIndex> {
  const targetSec = tsSeconds(opts.target);
  const index: CaptureIndex = new Map();
  // Mimetype of the latest non-revisit row per key, to tell what a revisit pick really is.
  const realType = new Map<string, string>();
  const limit = opts.maxIndexUrls ?? Infinity;
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
      if (cdxHtml(c.mimetype) !== undefined) realType.set(key, c.mimetype);
      const cur = index.get(key);
      if (!cur) {
        // A big domain lists millions of URLs; keeping them all would exhaust memory.
        if (index.size >= limit) {
          index.truncated = true;
          continue;
        }
        index.set(key, c);
        continue;
      }
      const r = rank(c, targetSec);
      if (r < rank(cur, targetSec)) {
        const entry: IndexedCapture = c;
        if (isRedirect(c)) entry.alt = isRedirect(cur) ? cur.alt : cur;
        index.set(key, entry);
      } else if (isRedirect(cur) && !isRedirect(c) && (!cur.alt || r < rank(cur.alt, targetSec))) {
        cur.alt = c;
      }
    }
    opts.log?.(`index: ${rows} captures read, ${index.size} distinct URLs`);
    if (index.truncated) {
      opts.log?.(`index: stopped reading at ${index.size} distinct URLs`);
      break;
    }
  }
  for (const [key, c] of index) {
    const t = cdxHtml(c.mimetype) === undefined ? realType.get(key) : undefined;
    if (t) index.set(key, Object.assign({}, c, { mimetype: t }));
  }
  return index;
}

function hashKey(key: string): string {
  return createHash('sha1').update(key).digest('hex');
}

function normalizeRedirectStatus(s: number): number {
  return [301, 302, 303, 307, 308].includes(s) ? s : 302;
}

const isTransient = (res: CaptureResult) => res.kind === 'missing' && res.transient === true;

export async function crawl(client: ArchiveClient, index: CaptureIndex, opts: CrawlOptions): Promise<Manifest> {
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
  // A read position instead of shift(): shift() is O(n) on big arrays, and a demo drops thousands.
  type Queue = { items: Item[]; head: number };
  const queues: Queue[] = [0, 1, 2].map(() => ({ items: [], head: 0 }));
  const queued = () => queues.reduce((n, q) => n + q.items.length - q.head, 0);
  const seen = new Set<string>();
  const variants = new Map<string, number>();
  let processed = 0;
  let completed = 0;
  let pages = 0;
  let inFlight = 0;
  let failStreak = 0;
  // A demo is the linked pages only: the orphan pass would download every unlinked file.
  let orphansAdded = !opts.orphans || opts.maxPages !== undefined;
  let wake: (() => void) | null = null;
  let stopped = false;
  let failure: unknown;
  const pageLimitReached = () => opts.maxPages !== undefined && pages >= opts.maxPages;

  // Every worker checks this, so a fatal error stops them all before crawl() rejects.
  const stop = (err: unknown) => {
    if (!stopped) {
      stopped = true;
      failure = err;
    }
    wake?.();
  };

  const enqueue = (u: URL, prio: number, via: Item['via'], referrer?: string): boolean => {
    if (!isInternal(u, opts.domain)) return false;
    const key = urlKey(u);
    if (seen.has(key)) return false;
    const pq = pathAndQuery(u);
    if (SKIP_PATH.test(pq) || GENERATED.has(u.pathname)) return false;
    seen.add(key);
    const cap = index.get(key);
    // The cap stops crawler traps (calendars, faceted search). URLs the index lists are a finite
    // list of real captures and always go in.
    if (!cap && pq.includes('?')) {
      const n = (variants.get(u.pathname) ?? 0) + 1;
      variants.set(u.pathname, n);
      if (n > MAX_QUERY_VARIANTS) {
        manifest.missing.push({ key, url: u.toString(), reason: `not downloaded: more than ${MAX_QUERY_VARIANTS} unarchived query-string variants of this path`, referrer });
        return false;
      }
    }
    queues[prio].items.push({ key, url: cap?.original ?? u.toString(), referrer, via, html: cap ? cdxHtml(cap.mimetype) : undefined });
    wake?.();
    return true;
  };

  const next = (): Item | undefined => {
    for (const q of queues) {
      while (q.head < q.items.length) {
        const item = q.items[q.head++];
        if (q.head > 1024 && q.head * 2 > q.items.length) {
          q.items.splice(0, q.head);
          q.head = 0;
        }
        // Past the demo limit only files a kept page linked to still come along; an unknown type
        // may be a page.
        if (pageLimitReached() && !(item.html === false && item.via === 'link')) continue;
        return item;
      }
    }
    return undefined;
  };

  // Saves run one at a time, each through its own temporary file. Downloads of an earlier run that
  // this run has not reached yet are written too, so an interrupted resume never loses them.
  let saving: Promise<void> = Promise.resolve();
  let saveSeq = 0;
  const save = (): Promise<void> => {
    const run = async () => {
      const tmp = `${manifestPath}.${process.pid}.${++saveSeq}.tmp`;
      await writeFile(tmp, JSON.stringify({ ...manifest, resources: [...manifest.resources, ...previous.values()] }));
      await rename(tmp, manifestPath);
    };
    saving = saving.then(run, run);
    return saving;
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

    // Bodies an earlier version took from outside the window are fetched again.
    if (reuse && inWindow(reuse.timestamp, opts.window)) {
      const isPage = reuse.status === 200 && reuse.file && isHtmlType(reuse.contentType);
      if (isPage && pageLimitReached()) return;
      previous.delete(item.key);
      manifest.resources.push(reuse);
      if (reuse.status === 200 && reuse.file) {
        if (isPage) pages++;
        discover(await readFile(path.join(rawDir, reuse.file)), reuse.contentType ?? '', reuse.url, reuse.key);
      } else if (reuse.location) {
        const t = toUrl(reuse.location);
        if (t) enqueue(t, 0, 'link', reuse.key);
      }
      return;
    }
    previous.delete(item.key);

    let used: Capture | undefined = cap;
    let res = await client.fetchCapture(cap?.timestamp ?? opts.target, item.url);
    // Replay does not always serve the capture asked for: the archive skips a 3xx whose Location is
    // the same URL (http -> https, bare -> www) and serves the nearest other capture, which can be
    // the parked domain. Then the best in-window capture that is not a redirect is fetched instead.
    if (cap?.alt && !isTransient(res) && (res.kind === 'missing' || !inWindow(res.timestamp, opts.window))) {
      used = cap.alt;
      res = await client.fetchCapture(cap.alt.timestamp, cap.alt.original);
    }
    failStreak = isTransient(res) ? failStreak + 1 : 0;
    if (res.kind !== 'missing' && !inWindow(res.timestamp, opts.window)) {
      manifest.missing.push({ key: item.key, url: item.url, reason: 'only archived outside the good period', referrer: item.referrer });
      return;
    }
    if (res.kind === 'ok') {
      if (isHtmlType(res.contentType)) {
        // The CDX type can be wrong or unknown; the demo limit holds whatever it said. The page is
        // counted before the write so parallel workers cannot all pass the check.
        if (pageLimitReached()) return;
        pages++;
      }
      const file = hashKey(item.key);
      await writeFile(path.join(rawDir, file), res.body);
      const sha1 = createHash('sha1').update(res.body).digest('hex');
      manifest.resources.push({ ...base, timestamp: res.timestamp, status: 200, contentType: res.contentType, file, size: res.body.length, sha1 });
      discover(res.body, res.contentType, item.url, item.key);
    } else if (res.kind === 'redirect') {
      const status = used && isRedirect(used) && used.timestamp === res.timestamp ? Number(used.statuscode) : res.status;
      const target = toUrl(res.location, item.url);
      manifest.resources.push({ ...base, timestamp: res.timestamp, status: normalizeRedirectStatus(status), location: target?.toString() ?? res.location });
      if (target) enqueue(target, 0, 'link', item.key);
    } else {
      manifest.missing.push({ key: item.key, url: item.url, reason: res.reason, referrer: item.referrer, transient: res.transient || undefined });
    }
  };

  const home = toUrl(`http://${opts.domain}/`)!;
  enqueue(home, 0, 'seed');

  const addOrphans = () => {
    let added = 0;
    for (const [key, c] of index) {
      if (seen.has(key)) continue;
      const u = toUrl(c.original);
      if (u && enqueue(u, cdxHtml(c.mimetype) === false ? 2 : 1, 'index')) added++;
    }
    if (added) log(`following ${added} more URLs from the archive index that no page links to`);
  };

  const checkpoint = async () => {
    try {
      await save();
    } catch (err) {
      // A failed checkpoint only costs resume progress; the final save still has to succeed.
      log(`could not save progress: ${(err as Error).message}`);
    }
  };

  const worker = async () => {
    while (!stopped) {
      if (processed >= opts.maxUrls) return;
      let item = next();
      if (!item && !orphansAdded && inFlight === 0) {
        orphansAdded = true;
        addOrphans();
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
        opts.progress?.({ done: processed, queued: queued(), current: item.url });
        await handle(item);
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          stop(err);
        } else {
          failStreak++;
          manifest.missing.push({ key: item.key, url: item.url, reason: (err as Error).message, referrer: item.referrer, transient: true });
        }
      } finally {
        inFlight--;
        wake?.();
      }
      if (failStreak >= MAX_FAILURE_STREAK) {
        stop(new Error(`archive.org refused or failed the last ${failStreak} downloads (rate limit, server errors or a blocked IP). Progress is saved; run the same restore again later to continue.`));
      }
      // Counted per finished item, so each multiple of 50 saves exactly once.
      if (++completed % 50 === 0) await checkpoint();
    }
  };

  const workers = Math.max(1, Math.floor(Number(opts.workers ?? client.concurrency)) || 1);
  await Promise.all(
    Array.from({ length: workers }, () =>
      worker().catch((err: unknown) => {
        stop(err);
      }),
    ),
  );

  if (failure !== undefined) {
    await checkpoint();
    throw failure;
  }
  const left = queued();
  if (left > 0 || processed >= opts.maxUrls) {
    manifest.truncated = left > 0;
    if (left > 0) log(`URL limit reached: ${left} URLs were not downloaded`);
  }
  await save();
  return manifest;
}
