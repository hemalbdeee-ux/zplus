// A small stand-in for web.archive.org: the CDX index API and raw "id_" playback, served from
// fixture captures. It behaves like the real archive in the ways the engine depends on:
// SURT-style keys that ignore www and scheme, the nearest-timestamp redirect, archived redirects
// with a Location on the archive, resume keys, and filters.

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
}

export interface FakeArchive {
  base: string;
  requests: string[];
  /** Answer the next n playback requests with this status before serving normally. */
  failNext(status: number, n: number): void;
  close(): Promise<void>;
}

function surt(u: URL): string {
  const host = u.hostname.toLowerCase().replace(/^www\d{0,3}\./, '');
  return host.split('.').reverse().join(',') + ')' + (u.pathname + u.search).toLowerCase();
}

function httpDate(ts: string): string {
  const d = new Date(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`);
  return d.toUTCString();
}

export async function startFakeArchive(captures: FakeCapture[]): Promise<FakeArchive> {
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
      let hits = rows.filter((r) => (match === 'exact' ? r.key === key : r.key.startsWith(key)) && r.ts >= from && r.ts <= to);
      hits = hits.filter((r) =>
        filters.every((f) => {
          const v = f.field === 'statuscode' ? String(r.status) : f.field === 'mimetype' ? r.type : '';
          return f.re.test(v) !== f.neg;
        }),
      );
      const offset = Number(q.get('resumeKey') ?? 0);
      const limit = Number(q.get('limit') ?? 100000);
      const page = hits.slice(offset, offset + limit);
      const out: string[][] = [['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length']];
      for (const r of page) out.push([r.key, r.ts, r.url, r.type, String(r.status), r.digest, String(r.bytes.length + 400)]);
      if (q.get('showResumeKey') === 'true' && offset + limit < hits.length) out.push([], [String(offset + limit)]);
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
      const closest = list.reduce((best, r) => (Math.abs(Number(r.ts) - Number(ts)) < Math.abs(Number(best.ts) - Number(ts)) ? r : best));
      if (closest.ts !== ts) {
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
