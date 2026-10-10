// Client for the Wayback Machine: the CDX index API and raw ("id_") capture playback.
//
// archive.org rate-limits hard and blocks IPs that hammer it, so every request goes through one
// gate: a small number of parallel requests, a minimum gap between request starts, and a shared
// pause when the archive answers 429.

import { setTimeout as sleep } from 'node:timers/promises';
import { urlKey, toUrl } from './url.ts';

export interface Capture {
  urlkey: string;
  timestamp: string;
  original: string;
  mimetype: string;
  /** "200", "301", ... or "-" for a revisit record (same content as an earlier capture). */
  statuscode: string;
  digest: string;
  length: number;
}

export interface CdxQuery {
  url: string;
  matchType?: 'exact' | 'prefix' | 'host' | 'domain';
  from?: string;
  to?: string;
  filters?: string[];
  collapse?: string[];
  pageSize?: number;
}

export type CaptureResult =
  /** original: the URL the served capture is filed under; the archive can move to another spelling. */
  | { kind: 'ok'; timestamp: string; original: string; status: number; contentType: string; body: Buffer }
  | { kind: 'redirect'; timestamp: string; status: number; location: string }
  /** transient: the archive itself failed or refused (429, 5xx), so a later try may work. */
  | { kind: 'missing'; status: number; reason: string; transient?: boolean };

export interface ArchiveOptions {
  base?: string;
  concurrency?: number;
  minIntervalMs?: number;
  retries?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** First retry wait; doubles on every attempt (default 2000 ms). */
  backoffMs?: number;
  userAgent?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

const CDX_FIELDS = ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'];

export class ArchiveClient {
  readonly base: string;
  readonly concurrency: number;
  readonly minIntervalMs: number;
  readonly retries: number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly backoffMs: number;
  readonly userAgent: string;
  readonly signal?: AbortSignal;
  readonly log: (msg: string) => void;
  requests = 0;

  #active = 0;
  #waiters: Array<() => void> = [];
  #nextStart = 0;
  #pausedUntil = 0;

  constructor(opts: ArchiveOptions = {}) {
    // NaN would silently turn off the gate (no concurrency cap, no gap, no 429 pause).
    const num = (v: number | undefined, fallback: number, min: number) => (v !== undefined && Number.isFinite(v) ? Math.max(min, v) : fallback);
    this.base = (opts.base ?? 'https://web.archive.org').replace(/\/+$/, '');
    this.concurrency = Math.floor(num(opts.concurrency, 3, 1));
    this.minIntervalMs = num(opts.minIntervalMs, 350, 0);
    this.retries = Math.floor(num(opts.retries, 5, 0));
    this.timeoutMs = num(opts.timeoutMs, 90_000, 1);
    this.maxBytes = num(opts.maxBytes, 50 * 1024 * 1024, 0);
    this.backoffMs = num(opts.backoffMs, 2_000, 0);
    this.userAgent = opts.userAgent ?? 'WaybackDownloader/0.1 (+site restore tool)';
    this.signal = opts.signal;
    this.log = opts.log ?? (() => {});
  }

  async #acquire(): Promise<void> {
    while (this.#active >= this.concurrency) await new Promise<void>((r) => this.#waiters.push(r));
    this.#active++;
    const now = Date.now();
    const start = Math.max(now, this.#nextStart, this.#pausedUntil);
    this.#nextStart = start + this.minIntervalMs;
    if (start > now) await sleep(start - now, undefined, { signal: this.signal });
  }

  #release(): void {
    this.#active--;
    this.#waiters.shift()?.();
  }

  #backoff(attempt: number): number {
    return Math.min(60_000, this.backoffMs * 2 ** attempt) + Math.floor(Math.random() * Math.min(1_000, this.backoffMs));
  }

  async #get(url: string): Promise<RawResponse> {
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted();
      await this.#acquire();
      let retryIn = 0;
      try {
        this.requests++;
        const signals = [AbortSignal.timeout(this.timeoutMs)];
        if (this.signal) signals.push(this.signal);
        const res = await fetch(url, {
          redirect: 'manual',
          headers: { 'user-agent': this.userAgent },
          signal: AbortSignal.any(signals),
        });
        // A replayed capture of an error page (the site answered 429 or 503 when it was crawled)
        // carries Memento-Datetime. It is an answer, not the archive failing: retrying it or pausing
        // every request would not change it.
        const memento = res.headers.has('memento-datetime');
        const retryable = !memento && isRetryable(res.status);
        if (retryable && attempt < this.retries) {
          await res.body?.cancel();
          retryIn = parseRetryAfter(res.headers.get('retry-after')) ?? this.#backoff(attempt);
          if (res.status === 429) {
            this.#pausedUntil = Date.now() + retryIn;
            this.log(`archive.org asked us to slow down (429); pausing ${Math.round(retryIn / 1000)}s`);
          }
        } else {
          const declared = Number(res.headers.get('content-length') ?? 0);
          if (declared > this.maxBytes) {
            await res.body?.cancel();
            return { status: 413, headers: res.headers, body: Buffer.alloc(0) };
          }
          const body = await this.#readBody(res);
          if (!body) return { status: 413, headers: res.headers, body: Buffer.alloc(0) };
          return { status: res.status, headers: res.headers, body };
        }
      } catch (err) {
        if (this.signal?.aborted) throw err;
        if (attempt >= this.retries) throw err;
        retryIn = this.#backoff(attempt);
        this.log(`request failed (${(err as Error).message}); retrying in ${Math.round(retryIn / 1000)}s`);
      } finally {
        this.#release();
      }
      await sleep(retryIn, undefined, { signal: this.signal });
    }
  }

  /**
   * Reads a body up to maxBytes; null when it is bigger. Content-Length is missing on chunked
   * replies and is the compressed size of a gzipped one, so the bytes are counted as they arrive.
   */
  async #readBody(res: Response): Promise<Buffer | null> {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  }

  /** Pages through the CDX index; yields captures in index order (by URL, then time). */
  async *cdx(q: CdxQuery): AsyncGenerator<Capture[]> {
    let resumeKey: string | undefined;
    do {
      const p = new URLSearchParams({
        url: q.url,
        output: 'json',
        fl: CDX_FIELDS.join(','),
        limit: String(q.pageSize ?? 25_000),
        showResumeKey: 'true',
      });
      if (q.matchType) p.set('matchType', q.matchType);
      if (q.from) p.set('from', q.from);
      if (q.to) p.set('to', q.to);
      for (const f of q.filters ?? []) p.append('filter', f);
      for (const c of q.collapse ?? []) p.append('collapse', c);
      if (resumeKey) p.set('resumeKey', resumeKey);

      const res = await this.#get(`${this.base}/cdx/search/cdx?${p}`);
      if (res.status !== 200) throw new Error(`CDX query failed with HTTP ${res.status}`);
      const parsed = parseCdxJson(res.body.toString('utf8'));
      resumeKey = parsed.resumeKey;
      if (parsed.captures.length) yield parsed.captures;
    } while (resumeKey);
  }

  /**
   * Fetches the original bytes of a capture. The archive answers a timestamp that is not exact with
   * a redirect to the nearest capture; those hops are followed. A redirect that the original site
   * itself made (an archived 301/302 to a different URL) is returned as kind "redirect".
   */
  async fetchCapture(timestamp: string, original: string): Promise<CaptureResult> {
    const wanted = toUrl(original);
    if (!wanted) return { kind: 'missing', status: 0, reason: 'invalid URL' };
    const wantedKey = urlKey(wanted);
    let ts = timestamp;
    let orig = original;
    let url = `${this.base}/web/${ts}id_/${original}`;
    const visited = new Set<string>();

    for (let hop = 0; hop < 8; hop++) {
      visited.add(url);
      const res = await this.#get(url);
      // Every replayed capture carries Memento-Datetime, an archived redirect included.
      const memento = res.headers.has('memento-datetime');
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { kind: 'missing', status: res.status, reason: 'redirect without location' };
        const abs = new URL(loc, url);
        const archived = parseArchiveUrl(abs, this.base);
        if (archived) {
          const target = toUrl(archived.original);
          // Without Memento-Datetime the 3xx is the archive's own move to the nearest capture it has
          // for this URL. Its index ignores case, a trailing slash and query order, so the target
          // can be spelled differently; it is still this URL and never a redirect the site made.
          if (!memento || (target && urlKey(target) === wantedKey)) {
            // Same resource: the archive moved us to the nearest timestamp, or the site switched http/https or www.
            const nextUrl = `${this.base}/web/${archived.timestamp}id_/${archived.original}`;
            if (visited.has(nextUrl)) return { kind: 'missing', status: res.status, reason: 'redirect loop' };
            ts = archived.timestamp;
            orig = archived.original;
            url = nextUrl;
            continue;
          }
          return { kind: 'redirect', timestamp: archived.timestamp, status: res.status, location: archived.original };
        }
        const target = abs.toString();
        const t = toUrl(target);
        if (t && urlKey(t) === wantedKey) return { kind: 'missing', status: res.status, reason: 'redirect loop' };
        return { kind: 'redirect', timestamp: ts, status: res.status, location: target };
      }
      if (res.status === 200) {
        const fromHeader = mementoTimestamp(res.headers.get('memento-datetime'));
        return {
          kind: 'ok',
          timestamp: fromHeader ?? ts,
          original: orig,
          status: 200,
          contentType: res.headers.get('content-type') ?? '',
          body: res.body,
        };
      }
      if (res.status === 413) return { kind: 'missing', status: 413, reason: 'file too large' };
      if (memento) return { kind: 'missing', status: res.status, reason: `archived as HTTP ${res.status}` };
      return { kind: 'missing', status: res.status, reason: `HTTP ${res.status}`, transient: isRetryable(res.status) };
    }
    return { kind: 'missing', status: 0, reason: 'too many redirects' };
  }
}

export function parseCdxJson(text: string): { captures: Capture[]; resumeKey?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { captures: [] };
  const rows = JSON.parse(trimmed) as string[][];
  if (!Array.isArray(rows) || rows.length === 0) return { captures: [] };
  const header = rows[0];
  const idx = (name: string, fallback: number) => {
    const i = header.indexOf(name);
    return i >= 0 ? i : fallback;
  };
  const iKey = idx('urlkey', 0);
  const iTs = idx('timestamp', 1);
  const iOrig = idx('original', 2);
  const iMime = idx('mimetype', 3);
  const iStatus = idx('statuscode', 4);
  const iDigest = idx('digest', 5);
  const iLen = idx('length', 6);
  const captures: Capture[] = [];
  let resumeKey: string | undefined;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 0) {
      resumeKey = rows[i + 1]?.[0];
      break;
    }
    if (r.length === 1) {
      resumeKey = r[0];
      break;
    }
    captures.push({
      urlkey: r[iKey],
      timestamp: r[iTs],
      original: r[iOrig],
      mimetype: r[iMime] ?? '',
      statuscode: r[iStatus] ?? '',
      digest: r[iDigest] ?? '',
      length: Number(r[iLen]) || 0,
    });
  }
  return { captures, resumeKey };
}

function parseArchiveUrl(u: URL, base: string): { timestamp: string; original: string } | null {
  const baseHost = new URL(base).host;
  const onArchive = u.host === baseHost || /(^|\.)archive\.org$/i.test(u.hostname);
  if (!onArchive) return null;
  const m = /^\/web\/(\d{1,14})(?:[a-z]{2}_)?\/(.+)$/i.exec(u.pathname + u.search);
  if (!m) return null;
  let original = m[2].replace(/^(https?):\/(?!\/)/i, '$1://');
  if (!/^https?:\/\//i.test(original)) original = 'http://' + original.replace(/^\/+/, '');
  return { timestamp: m[1].padEnd(14, '0'), original };
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 501);
}

function mementoTimestamp(header: string | null): string | undefined {
  if (!header) return undefined;
  const d = new Date(header);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(300_000, Math.max(0, secs * 1000));
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.min(300_000, Math.max(1_000, d - Date.now()));
}
