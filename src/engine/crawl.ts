// Downloads the site from the archive.
//
// 1. The CDX index tells us which URLs exist; for each URL we keep the one capture closest to the
//    target date inside the good window (earlier captures win ties: the site was healthier then).
//    On a huge domain the index stops at a size limit, and a linked URL past it is looked up alone.
// 2. Starting at the homepage we follow links breadth-first, so pages the site actually linked
//    come first. 3. Pages nobody linked any more ("orphans", often the ones with backlinks) are
//    added after that, until the URL budget is spent.
//
// Every response body is stored under work/raw so a stopped job resumes without refetching.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveClient, Capture, CaptureResult, CdxQuery } from './archive.ts';
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
  /**
   * When the chosen capture is a 3xx: the best in-window capture, not a 3xx, of another URL that
   * the archive files under the same key (/about.html for /About.html, /page for /page/). Replay
   * skips a 3xx that points inside its own key, so when the URL has no alt this is where such a
   * redirect went.
   */
  twin?: Capture;
}

/** One capture per URL key; `truncated` is set when reading stopped at the size limit. */
export type CaptureIndex = Map<string, IndexedCapture> & { truncated?: boolean };

const SKIP_PATH = /\/(wp-admin|wp-json|cgi-bin|trackback)(\/|$)|\/(wp-login|xmlrpc|wp-cron)\.php|[?&](replytocom|share|action=edit)=/i;
const GENERATED = new Set(['/robots.txt', '/sitemap.xml']);
const MAX_QUERY_VARIANTS = 200;
/** One archive key holds a handful of spellings of a URL; more means the lookup went wrong. */
const LOOKUP_URLS = 100;
/** This many archive failures in a row (429, 5xx, network) mean archive.org is refusing us. */
const MAX_FAILURE_STREAK = 20;
const REVISIT = 'warc/revisit';
// Where a URL of unknown type was found tells what it is: these lead to other pages, everything
// else a page names (img, script, a stylesheet, srcset, url() in CSS) is part of that page.
const PAGE_LINKS: Array<[string, string]> = [['a', 'href'], ['area', 'href'], ['frame', 'src'], ['iframe', 'src'], ['form', 'action'], ['base', 'href'], ['blockquote', 'cite'], ['q', 'cite']];
const ASSET_REL = /\b(stylesheet|icon|preload|prefetch|modulepreload|manifest|image_src)\b/i;
// What an extension gives away when the CDX type does not say (a revisit row, an unlisted URL).
const PAGE_EXT = /\.(html?|shtml|xhtml)$/i;
const FILE_EXT = /\.(css|m?js|json|xml|rss|atom|txt|csv|pdf|zip|gz|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp3|mp4|m4a|webm|ogg|ogv|wav|flv|swf|docx?|xlsx?|pptx?)$/i;

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

/** Is a URL a page? Its CDX row says, else its extension; undefined when neither does. */
function guessHtml(cap: Capture | undefined, u: URL): boolean | undefined {
  const known = cap ? cdxHtml(cap.mimetype) : undefined;
  if (known !== undefined) return known;
  return PAGE_EXT.test(u.pathname) ? true : FILE_EXT.test(u.pathname) ? false : undefined;
}

const isRedirect = (c: Capture) => /^3/.test(c.statuscode);

/** How many times each raw URL appears in a page as a link to another page (see PAGE_LINKS). */
function pageLinks($: ReturnType<typeof loadHtml>): Map<string, number> {
  const out = new Map<string, number>();
  const add = (v: string | undefined) => {
    if (v !== undefined) out.set(v, (out.get(v) ?? 0) + 1);
  };
  for (const [tag, attr] of PAGE_LINKS) $(`${tag}[${attr}]`).each((_, el) => add($(el).attr(attr)));
  // rel="canonical", "alternate", "next": pages and feeds, not part of this page.
  $('link[href]').each((_, el) => {
    if (!ASSET_REL.test($(el).attr('rel') ?? '')) add($(el).attr('href'));
  });
  return out;
}

function rank(c: Capture, targetSec: number): number {
  const d = tsSeconds(c.timestamp) - targetSec;
  let r = d > 0 ? d * 1.5 : -d;
  if (isRedirect(c)) r += 30 * 86_400;
  return r;
}

function inWindow(ts: string, w: { from?: string; to?: string }): boolean {
  return (!w.from || ts >= w.from) && (!w.to || ts <= w.to);
}

type IndexOptions = Pick<CrawlOptions, 'domain' | 'target' | 'window'>;

/** Collects CDX rows into a CaptureIndex; `limit` caps the number of distinct URLs. */
function indexer(opts: IndexOptions, limit = Infinity) {
  const targetSec = tsSeconds(opts.target);
  const index: CaptureIndex = new Map();
  // Mimetype of the latest non-revisit row per key, to tell what a revisit pick really is.
  const realType = new Map<string, string>();

  const add = (c: Capture): void => {
    if (c.statuscode !== '-' && !/^[23]\d\d$/.test(c.statuscode)) return;
    if (!inWindow(c.timestamp, opts.window)) return;
    const u = toUrl(c.original);
    if (!u || !isInternal(u, opts.domain)) return;
    // Never downloaded (see enqueue), so not worth a place in a size-limited index.
    if (SKIP_PATH.test(pathAndQuery(u)) || GENERATED.has(u.pathname)) return;
    const key = urlKey(u);
    if (cdxHtml(c.mimetype) !== undefined) realType.set(key, c.mimetype);
    const cur = index.get(key);
    if (!cur) {
      // A big domain lists millions of URLs; keeping them all would exhaust memory.
      if (index.size >= limit) {
        index.truncated = true;
        return;
      }
      index.set(key, c);
      return;
    }
    const r = rank(c, targetSec);
    if (r < rank(cur, targetSec)) {
      const entry: IndexedCapture = c;
      if (isRedirect(c)) entry.alt = isRedirect(cur) ? cur.alt : cur;
      index.set(key, entry);
    } else if (isRedirect(cur) && !isRedirect(c) && (!cur.alt || r < rank(cur.alt, targetSec))) {
      cur.alt = c;
    }
  };

  const finish = (): CaptureIndex => {
    for (const [key, c] of index) {
      const t = cdxHtml(c.mimetype) === undefined ? realType.get(key) : undefined;
      if (t) index.set(key, Object.assign({}, c, { mimetype: t }));
    }
    // The archive key (CDX urlkey) ignores case, a trailing slash and query order, so it can hold
    // several of our URLs. Each 3xx pick learns the best other URL under its archive key.
    const redirects = new Map<string, IndexedCapture[]>();
    for (const c of index.values()) {
      if (!isRedirect(c) || !c.urlkey) continue;
      const group = redirects.get(c.urlkey);
      if (group) group.push(c);
      else redirects.set(c.urlkey, [c]);
    }
    if (redirects.size) {
      for (const c of index.values()) {
        const group = redirects.get(c.urlkey);
        const best = isRedirect(c) ? c.alt : c;
        if (!group || !best) continue;
        for (const p of group) if (p !== c && (!p.twin || rank(best, targetSec) < rank(p.twin, targetSec))) p.twin = best;
      }
    }
    return index;
  };

  return { index, add, finish };
}

async function readIndex(client: ArchiveClient, q: CdxQuery, opts: IndexOptions, limit?: number, log?: (msg: string) => void): Promise<CaptureIndex> {
  const ix = indexer(opts, limit);
  let rows = 0;
  for await (const page of client.cdx({ ...q, from: opts.window.from, to: opts.window.to, filters: ['!statuscode:[45]..'] })) {
    for (const c of page) {
      rows++;
      ix.add(c);
    }
    log?.(`index: ${rows} captures read, ${ix.index.size} distinct URLs`);
    if (ix.index.truncated) {
      log?.(`index: stopped reading at ${ix.index.size} distinct URLs`);
      break;
    }
  }
  return ix.finish();
}

export function buildIndex(client: ArchiveClient, opts: IndexOptions & Pick<CrawlOptions, 'log'> & { maxIndexUrls?: number }): Promise<CaptureIndex> {
  return readIndex(client, { url: `${opts.domain}/`, matchType: 'prefix' }, opts, opts.maxIndexUrls, opts.log);
}

/**
 * The index of one URL alone, from an exact CDX query. That lists every URL the archive files
 * under the same key, so a 3xx pick gets its alt and twin too. For URLs past where the index stopped.
 */
export function lookupIndex(client: ArchiveClient, url: string, opts: IndexOptions): Promise<CaptureIndex> {
  return readIndex(client, { url, matchType: 'exact' }, opts, LOOKUP_URLS);
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

  /**
   * asset: found as part of a page (an image, a stylesheet), not as a link to another page.
   * skipped: left out by a demo past its page limit.
   */
  type Item = { key: string; url: string; referrer?: string; via: Resource['via']; html?: boolean; asset?: boolean; skipped?: boolean };
  // A read position instead of shift(): shift() is O(n) on big arrays, and a demo drops thousands.
  type Queue = { items: Item[]; head: number };
  const queues: Queue[] = [0, 1, 2].map(() => ({ items: [], head: 0 }));
  const queued = () => queues.reduce((n, q) => n + q.items.length - q.head, 0);
  const seen = new Set<string>();
  // Items not downloaded yet by key, so a URL first seen as a link and then as an image becomes an asset.
  const pending = new Map<string, Item>();
  const variants = new Map<string, number>();
  // Keys whose redirect was worked out from where replay went, not read from an archived 3xx.
  const inferred = new Set<string>();
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

  const enqueue = (u: URL, prio: number, via: Item['via'], referrer?: string, asset = false): boolean => {
    if (!isInternal(u, opts.domain)) return false;
    const key = urlKey(u);
    if (seen.has(key)) {
      const waiting = asset ? pending.get(key) : undefined;
      if (waiting && !waiting.asset) {
        waiting.asset = true;
        if (waiting.skipped) {
          waiting.skipped = false;
          queues[0].items.push(waiting);
          wake?.();
        }
      }
      return false;
    }
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
        // Past a cut-short index "not listed" no longer means "not archived".
        const unlisted = index.truncated ? 'that the part of the archive index read does not list' : 'that are not archived';
        manifest.missing.push({ key, url: u.toString(), reason: `not downloaded: more than ${MAX_QUERY_VARIANTS} query-string variants of this path ${unlisted}`, referrer });
        return false;
      }
    }
    const item: Item = { key, url: cap?.original ?? u.toString(), referrer, via, html: guessHtml(cap, u), asset };
    queues[prio].items.push(item);
    pending.set(key, item);
    wake?.();
    return true;
  };

  // Past the demo limit only files a kept page linked to still come along. A URL of unknown type (a
  // revisit row, no extension) that a kept page uses as an image or stylesheet is fetched too, and
  // handle() drops it if it is a page; one it links to as a page is not.
  const mayBeFile = (item: Item) => item.html === false || (item.html === undefined && item.asset === true && (index.has(item.key) || index.truncated === true));

  const next = (): Item | undefined => {
    for (const q of queues) {
      while (q.head < q.items.length) {
        const item = q.items[q.head++];
        if (q.head > 1024 && q.head * 2 > q.items.length) {
          q.items.splice(0, q.head);
          q.head = 0;
        }
        if (pageLimitReached() && !(item.via === 'link' && mayBeFile(item))) {
          item.skipped = true;
          continue;
        }
        pending.delete(item.key);
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
    let links = new Map<string, number>();
    if (isHtmlType(contentType)) {
      const { text } = decodeText(body, contentType);
      const $ = loadHtml(text);
      const baseHref = $('base[href]').attr('href');
      if (baseHref) base = toUrl(unwrapWayback(baseHref), pageUrl)?.toString() ?? pageUrl;
      urls = collectUrls($);
      links = pageLinks($);
    } else if (isCssType(contentType, pageUrl)) {
      urls = cssUrls(body.toString('latin1'));
    }
    // A URL is an asset if it appears more often than as a page link (<a href="/x"><img src="/x">).
    const assets = new Set<string>();
    for (const raw of urls) {
      const n = links.get(raw) ?? 0;
      if (n > 0) links.set(raw, n - 1);
      else assets.add(raw);
    }
    for (const raw of urls) {
      const u = toUrl(unwrapWayback(raw.trim()), base);
      if (u) enqueue(u, 0, 'link', key, assets.has(raw));
    }
  };

  const handle = async (item: Item) => {
    let cap = index.get(item.key);
    const reuse = previous.get(item.key);

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
        if (t) enqueue(t, 0, 'link', reuse.key, item.asset);
      }
      return;
    }
    previous.delete(item.key);

    if (!cap && index.truncated) {
      // The index stopped early on a big domain: a URL it does not list is looked up on its own, so
      // it is still taken from the good period and its redirects are read like a listed one's.
      const u = new URL(item.url);
      const own = await lookupIndex(client, u.origin + pathAndQuery(u), opts);
      if (own.size === 0) {
        manifest.missing.push({ key: item.key, url: item.url, reason: 'not archived in the good period', referrer: item.referrer });
        return;
      }
      cap = own.get(item.key);
      if (cap && cdxHtml(cap.mimetype) === true && pageLimitReached()) return;
    }
    const url = cap?.original ?? item.url;
    const base: Omit<Resource, 'timestamp' | 'status'> = { key: item.key, url, path: pathAndQuery(new URL(url)), via: item.via };

    let used: Capture | undefined = cap;
    let res = await client.fetchCapture(cap?.timestamp ?? opts.target, url);
    if (cap && isRedirect(cap) && !isTransient(res)) {
      // Replay does not always serve the 3xx asked for: the archive skips one whose Location it
      // files under the same key and serves the nearest other capture of that key instead, which
      // can be the parked domain or another spelling. The key ignores scheme and www (http ->
      // https: the same URL here) but also case, a trailing slash and query order (/About.html ->
      // /about.html: a redirect to restore), and nothing in the reply tells which it was.
      const kept = res.kind !== 'missing' && inWindow(res.timestamp, opts.window);
      const landed = kept && res.kind === 'ok' ? toUrl(res.original) : null;
      const elsewhere = landed !== null && urlKey(landed) !== item.key;
      if (kept && !elsewhere) {
        // The archived redirect itself, or this URL's own content from the good period.
      } else if (cap.alt) {
        // The URL also served content of its own in the good period: serving it never invents a
        // redirect. Where replay landed says nothing about the 3xx, which may only have switched to
        // https or www (both spellings could otherwise end up redirecting to each other).
        used = cap.alt;
        res = await client.fetchCapture(cap.alt.timestamp, cap.alt.original);
      } else if (landed && elsewhere) {
        // Nothing but 3xx captures of this URL, and replay moved to the other spelling under its key.
        res = { kind: 'redirect', timestamp: cap.timestamp, status: Number(cap.statuscode), location: landed.toString() };
        inferred.add(item.key);
      } else if (cap.twin) {
        // Nothing usable of this URL itself: the 3xx went to the other URL under its key.
        res = { kind: 'redirect', timestamp: cap.timestamp, status: Number(cap.statuscode), location: cap.twin.original };
        inferred.add(item.key);
      }
    }
    failStreak = isTransient(res) ? failStreak + 1 : 0;
    if (res.kind !== 'missing' && !inWindow(res.timestamp, opts.window)) {
      manifest.missing.push({ key: item.key, url, reason: 'only archived outside the good period', referrer: item.referrer });
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
      discover(res.body, res.contentType, url, item.key);
    } else if (res.kind === 'redirect') {
      const status = used && isRedirect(used) && used.timestamp === res.timestamp ? Number(used.statuscode) : res.status;
      const target = toUrl(res.location, url);
      manifest.resources.push({ ...base, timestamp: res.timestamp, status: normalizeRedirectStatus(status), location: target?.toString() ?? res.location });
      if (target) enqueue(target, 0, 'link', item.key, item.asset);
    } else {
      manifest.missing.push({ key: item.key, url, reason: res.reason, referrer: item.referrer, transient: res.transient || undefined });
    }
  };

  const home = toUrl(`http://${opts.domain}/`)!;
  enqueue(home, 0, 'seed');

  // Orphans past what the URL budget can still take are only counted: queueing every one of a
  // big index would copy it whole.
  let unqueued = 0;
  const addOrphans = () => {
    const room = Math.max(0, opts.maxUrls - processed);
    const added = [0, 0, 0];
    for (const [key, c] of index) {
      if (seen.has(key)) continue;
      const u = toUrl(c.original);
      if (!u) continue;
      const prio = guessHtml(c, u) === false ? 2 : 1;
      if (added[prio] >= room) unqueued++;
      else if (enqueue(u, prio, 'index')) added[prio]++;
    }
    const n = added[1] + added[2] + unqueued;
    if (n) log(`following ${n} more URLs from the archive index that no page links to`);
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
  breakLoops(manifest, inferred);
  const left = queued() + unqueued;
  if (left > 0 || processed >= opts.maxUrls) {
    manifest.truncated = left > 0;
    if (left > 0) log(`URL limit reached: ${left} URLs were not downloaded`);
  }
  await save();
  return manifest;
}

/**
 * Backstop: a redirect worked out from replay never ends in a loop (with one kept from an earlier
 * run, say). The site never sent visitors round in circles, so such a URL is left out instead.
 */
function breakLoops(manifest: Manifest, inferred: Set<string>): void {
  const byKey = new Map(manifest.resources.map((r) => [r.key, r]));
  const keyOf = (location: string) => {
    const u = toUrl(location);
    return u ? urlKey(u) : undefined;
  };
  for (const key of inferred) {
    const chain = new Set<string>();
    let r = byKey.get(key);
    while (r?.location !== undefined && !chain.has(r.key)) {
      chain.add(r.key);
      const next = keyOf(r.location);
      r = next === undefined ? undefined : byKey.get(next);
    }
    if (r?.key !== key) continue;
    const loop = byKey.get(key)!;
    byKey.delete(key);
    manifest.resources.splice(manifest.resources.indexOf(loop), 1);
    manifest.missing.push({ key, url: loop.url, reason: 'the archive only has redirects for this URL that go round in a loop' });
  }
}
