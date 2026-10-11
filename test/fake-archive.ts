// A small stand-in for web.archive.org: the CDX index API and raw "id_" playback, served from
// fixture captures. It behaves like the real archive in the ways the engine depends on:
// SURT-style keys that ignore www, scheme, case and query order, the nearest-timestamp redirect (no
// Memento-Datetime), archived redirects with a Location on the archive (with Memento-Datetime),
// skipped self-redirects, revisit rows, resume keys, and filters.

import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCapture {
  url: string;
  ts: string;
  status?: number;
  type?: string;
  body?: string | Buffer;
  location?: string;
  /** A deduplicated repeat capture: the CDX row says "warc/revisit" and "-", playback serves the content. */
  revisit?: boolean;
}

export interface FakeArchiveOptions {
  /** Drop a trailing slash from keys as the real SURT canonicalizer does (/blog/ matches /blog). */
  stripTrailingSlash?: boolean;
  /**
   * The CDX server's per-request read cap (150000 on archive.org). As in CDXServer.java, every
   * row read counts, including rows that from/to, filter or collapse then drop, and a resume key
   * is printed only when a full page was written. Default: no cap.
   */
  readLimit?: number;
}

export interface FakeArchive {
  base: string;
  requests: string[];
  /** Answer the next n playback requests with this status before serving normally. */
  failNext(status: number, n: number): void;
  close(): Promise<void>;
}

function surtKey(u: URL, stripTrailingSlash = false): string {
  const host = u.hostname.toLowerCase().replace(/^www\d{0,3}\./, '');
  const p = stripTrailingSlash && u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  // IA's canonicalizer sorts the query parameters: ?b=2&a=1 and ?a=1&b=2 share a key.
  const q = u.search.length > 1 ? '?' + u.search.slice(1).split('&').sort().join('&') : '';
  return host.split('.').reverse().join(',') + ')' + (p + q).toLowerCase();
}

function httpDate(ts: string): string {
  const d = new Date(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`);
  return d.toUTCString();
}

export async function startFakeArchive(captures: FakeCapture[], opts: FakeArchiveOptions = {}): Promise<FakeArchive> {
  const surt = (u: URL) => surtKey(u, opts.stripTrailingSlash);
  const rows = captures
    .map((c) => {
      const u = new URL(c.url);
      const body = typeof c.body === 'string' ? Buffer.from(c.body) : (c.body ?? Buffer.alloc(0));
      return {
        ...c,
        key: surt(u),
        status: c.status ?? 200,
        type: c.type ?? 'text/html',
        bytes: body,
        digest: createHash('sha1').update(body).update(String(c.status ?? 200)).digest('hex').slice(0, 32).toUpperCase(),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key) || a.ts.localeCompare(b.ts));

  type Row = (typeof rows)[number];
  const cdxStatus = (r: Row) => (r.revisit ? '-' : String(r.status));
  const cdxType = (r: Row) => (r.revisit ? 'warc/revisit' : r.type);

  const requests: string[] = [];
  let failures: { status: number; n: number } = { status: 0, n: 0 };

  const server = http.createServer((req, res) => {
    const raw = req.url ?? '/';
    requests.push(raw);

    if (raw.startsWith('/cdx/search/cdx')) {
      const q = new URL(raw, 'http://archive.local').searchParams;
      const target = new URL(/^https?:\/\//.test(q.get('url')!) ? q.get('url')! : `http://${q.get('url')}`);
      const key = surt(target);
      const match = q.get('matchType') ?? 'exact';
      const from = (q.get('from') ?? '').padEnd(14, '0');
      const to = q.get('to') ? q.get('to')!.padEnd(14, '9') : '99999999999999';
      const filters = q.getAll('filter').map((f) => {
        const neg = f.startsWith('!');
        const [field, ...re] = (neg ? f.slice(1) : f).split(':');
        return { neg, field, re: new RegExp(`^(?:${re.join(':')})$`) };
      });
      const collapse = q.getAll('collapse').map((c) => {
        const [field, n] = c.split(':');
        return { field, n: n ? Number(n) : undefined, last: undefined as string | undefined };
      });
      const field = (r: Row, name: string) =>
        name === 'statuscode' ? cdxStatus(r) : name === 'mimetype' ? cdxType(r) : name === 'timestamp' ? r.ts : name === 'urlkey' ? r.key : name === 'digest' ? r.digest : '';
      const inRange = (r: Row) => (match === 'exact' ? r.key === key : r.key.startsWith(key));
      const readLimit = opts.readLimit ?? Infinity;
      const limit = Math.min(Number(q.get('limit') ?? 100000), readLimit);
      // Seek like CDXServer: to the resume key, else to "<key> <from>", else to the key itself.
      const resume = q.get('resumeKey');
      const [seekKey, seekTs] = resume ? resume.split(' ') : [key, q.get('from') ? from : ''];
      let i = rows.findIndex((r) => r.key > seekKey || (r.key === seekKey && r.ts >= (seekTs ?? '')));
      if (i < 0) i = rows.length;
      const page: Row[] = [];
      let allCount = 0;
      let last: Row | undefined;
      for (; i < rows.length && page.length < limit && allCount < readLimit; i++) {
        const r = rows[i];
        if (!inRange(r)) {
          if (r.key > key && !r.key.startsWith(key)) break;
          continue;
        }
        allCount++;
        last = r;
        if (r.ts < from) continue;
        if (r.ts > to) {
          if (match === 'exact') break;
          continue;
        }
        if (!filters.every((f) => f.re.test(field(r, f.field)) !== f.neg)) continue;
        if (
          collapse.length &&
          !collapse.every((c) => {
            const v = field(r, c.field).slice(0, c.n);
            const keep = v !== c.last;
            c.last = v;
            return keep;
          })
        )
          continue;
        page.push(r);
      }
      const out: string[][] = [['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length']];
      for (const r of page) out.push([r.key, r.ts, r.url, cdxType(r), cdxStatus(r), r.digest, String(r.bytes.length + 400)]);
      if (q.get('showResumeKey') === 'true' && last && page.length >= limit) {
        // CDXServer: "<urlkey> <timestamp with its last character incremented>".
        const ts = last.ts.slice(0, -1) + String.fromCharCode(last.ts.charCodeAt(last.ts.length - 1) + 1);
        out.push([], [`${last.key} ${ts}`]);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(page.length ? JSON.stringify(out) : '[]');
      return;
    }

    const m = /^\/web\/(\d{14})id_\/(.+)$/.exec(raw);
    if (m) {
      if (failures.n > 0) {
        failures.n--;
        res.writeHead(failures.status, { 'retry-after': '0' });
        res.end('slow down');
        return;
      }
      const [, ts, original] = m;
      const wanted = new URL(original);
      const key = surt(wanted);
      const list = rows.filter((r) => r.key === key);
      if (!list.length) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<p>Hrm. The Wayback Machine has not archived that URL.</p>');
        return;
      }
      const dist = (r: Row) => Math.abs(Number(r.ts) - Number(ts));
      let closest: Row | undefined = list.reduce((best, r) => (dist(r) < dist(best) ? r : best));
      if (closest.ts !== ts) {
        res.writeHead(302, { location: `/web/${closest.ts}id_/${closest.url}` });
        res.end();
        return;
      }
      // Wayback (AccessPoint.handleReplay) skips a 3xx whose Location has the same key (http ->
      // https, bare -> www) and moves on to the next closest capture: of the two time neighbours a
      // 200 wins, then the nearer one (DefaultReplayCaptureSelector.findNextClosest).
      const pool = [...list];
      let skipped = false;
      while (closest && closest.status >= 300 && closest.status < 400 && closest.location && surt(new URL(closest.location, closest.url)) === key) {
        const i = pool.indexOf(closest);
        const [prev, after] = [pool[i - 1], pool[i + 1]];
        pool.splice(i, 1);
        if (!prev || !after) closest = prev ?? after;
        else if ((prev.status === 200) !== (after.status === 200)) closest = prev.status === 200 ? prev : after;
        else closest = dist(prev) <= dist(after) ? prev : after;
        skipped = true;
      }
      if (!closest) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<p>Self-Redirect: No Closest Match Found</p>');
        return;
      }
      // handleReplayRedirect: a capture at the asked time is served as is, any other is a move.
      if (skipped && closest.ts !== ts) {
        res.writeHead(302, { location: `/web/${closest.ts}id_/${closest.url}` });
        res.end();
        return;
      }
      if (closest.status >= 300 && closest.status < 400) {
        const loc = new URL(closest.location!, closest.url).toString();
        res.writeHead(closest.status, { location: `/web/${ts}id_/${loc}`, 'memento-datetime': httpDate(ts) });
        res.end();
        return;
      }
      res.writeHead(closest.status, { 'content-type': closest.type, 'memento-datetime': httpDate(closest.ts) });
      res.end(closest.bytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    failNext(status, n) {
      failures = { status, n };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
