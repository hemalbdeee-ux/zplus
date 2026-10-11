// Round-3 health cases for the homepage index read one capture a day. archive.org collapses the rows
// of a day to the first one, whatever its status: often the http -> https or www redirect a crawler
// took seconds before the page, or a CDN error. The scan must still see the site's pages.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArchiveClient, type Capture, type CdxQuery } from '../src/engine/archive.ts';
import { scanHealth, type HealthReport } from '../src/engine/health.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };

/** Collapses the index as archive.org does: of the rows of one day, the first is kept. */
class CollapsingClient extends ArchiveClient {
  async *cdx(q: CdxQuery): AsyncGenerator<Capture[]> {
    const n = Number(q.collapse?.find((c) => c.startsWith('timestamp:'))?.split(':')[1] ?? 0);
    let last: string | undefined;
    for await (const page of super.cdx(q)) {
      const kept = page.filter((c) => {
        const t = c.timestamp.slice(0, n || 14);
        if (n && t === last) return false;
        last = t;
        return true;
      });
      if (kept.length) yield kept;
    }
  }
}

async function scan(captures: FakeCapture[]): Promise<HealthReport> {
  const archive = await startFakeArchive(captures);
  try {
    return await scanHealth(new CollapsingClient({ base: archive.base, ...FAST }), 'example.com');
  } finally {
    await archive.close();
  }
}

function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(4)); `${y}${String(m).padStart(2, '0')}` <= to; m === 12 ? (y++, (m = 1)) : m++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
  }
  return out;
}

const links = (n: number, p = 'p') => Array.from({ length: n }, (_, i) => `<a href="/${p}${i}.html">${p}${i}</a>`).join(' ');
const words = (n: number, w = 'bread') => Array.from({ length: n }, (_, i) => `${w}${i % 40}`).join(' ');
const GOOD = `<html lang="en"><head><title>Bakery</title></head><body>${links(8)}<p>${words(300)}</p></body></html>`;
const PARKED = '<html><body><h1>parked</h1><p>This domain may be for sale!</p></body></html>';

describe('health2: an index that keeps the first capture of each day', () => {
  it("takes the day's page over the redirect taken seconds before it", async () => {
    // Every crawl hits http:// first (301 to https://, the same index key), then the page. The
    // redirects have one digest in both eras, so a redirect month must not stand for the others.
    const captures: FakeCapture[] = [];
    for (const m of monthRange('201001', '202112')) {
      for (const day of ['05', '20']) {
        captures.push({ url: 'http://example.com/', ts: `${m}${day}100000`, status: 301, location: 'https://example.com/' });
        captures.push({ url: 'https://example.com/', ts: `${m}${day}100005`, body: m < '202001' ? GOOD : PARKED });
      }
    }
    const h = await scan(captures);
    assert.ok(h.months.every((m) => m.statuscode === '200' && m.captures === 2));
    assert.equal(h.lastGood?.month, '201912');
    assert.deepEqual(h.window, { to: '20191231235959' });
  });

  it('keeps the size and the host of a site whose crawls began with a redirect to www', async () => {
    // The old site's rich homepage on www; a later owner's small but real-looking site on the bare host.
    const big = `<html lang="en"><head><title>Old Bakery</title><style>${'.c{color:#333;margin:0 auto;padding:4px}'.repeat(250)}</style></head><body><nav>${links(30, 'menu')}</nav><p>${words(450)}</p></body></html>`;
    const small = `<html lang="en"><head><title>Crumbs and Co</title></head><body><nav>${links(6, 'x')}</nav><p>${words(200, 'toast')}</p></body></html>`;
    const captures: FakeCapture[] = [];
    for (const m of monthRange('201001', '201812')) {
      for (const day of ['05', '20']) {
        captures.push({ url: 'http://example.com/', ts: `${m}${day}100000`, status: 301, location: 'https://www.example.com/' });
        captures.push({ url: 'https://www.example.com/', ts: `${m}${day}100005`, body: big });
      }
    }
    for (const m of monthRange('201901', '202112')) captures.push({ url: 'http://example.com/', ts: `${m}10120000`, body: small });
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '201812');
    assert.equal(h.host, 'www.example.com');
  });

  it("takes the day's page over a CDN error captured first", async () => {
    const captures: FakeCapture[] = [];
    for (const m of monthRange('201001', '202112')) {
      const flaky = m >= '201801' && m < '202001';
      for (const day of ['05', '20']) {
        captures.push({ url: 'https://example.com/', ts: `${m}${day}100000`, status: flaky ? 503 : 200, body: flaky ? 'Service Unavailable' : m < '202001' ? GOOD : PARKED });
        captures.push({ url: 'https://example.com/', ts: `${m}${day}110000`, body: m < '202001' ? GOOD : PARKED });
      }
    }
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '201912');
    assert.deepEqual(h.window, { to: '20191231235959' });
  });

  it('does not let a month with only a redirect stand for the other redirect months', async () => {
    // Every third month has no page capture, only the http -> https redirect. The archive skips such
    // a redirect and plays the nearest page, which says nothing about the redirect's digest.
    const captures: FakeCapture[] = [];
    for (const [i, m] of monthRange('201001', '202112').entries()) {
      captures.push({ url: 'http://example.com/', ts: `${m}05100000`, status: 301, location: 'https://example.com/' });
      if (i % 3 !== 1) captures.push({ url: 'https://example.com/', ts: `${m}20100000`, body: m < '202001' ? GOOD : PARKED });
    }
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '201912');
    assert.equal(h.window.from, undefined);
    assert.ok(h.months.filter((m) => m.month < '202001').every((m) => m.verdict !== 'bad'));
  });
});
