// Round-3 health cases for stubs and redirects whose page cannot be had. The site's own redirect to a
// dated page the archive lost in one month must not end the site there, while a later owner's
// one-link page must not borrow a page of the old site captured shortly before the takeover.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { buildIndex } from '../src/engine/crawl.ts';
import { scanHealth, type HealthReport } from '../src/engine/health.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };

async function scan(captures: FakeCapture[]): Promise<HealthReport> {
  const archive = await startFakeArchive(captures);
  try {
    return await scanHealth(new ArchiveClient({ base: archive.base, ...FAST }), 'example.com');
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

const links = (n: number) => Array.from({ length: n }, (_, i) => `<a href="/p${i}.html">p${i}</a>`).join(' ');
const words = (n: number) => Array.from({ length: n }, (_, i) => `bread${i % 40}`).join(' ');
const good = (title = 'Bakery') => `<html lang="en"><head><title>${title}</title></head><body>${links(8)}<p>${words(300)}</p></body></html>`;
const PARKED = '<html><body><h1>parked</h1><p>This domain may be for sale!</p></body></html>';
const oneLink = '<html><head><title>example.com</title></head><body><a href="/contact.html">Contact</a></body></html>';

/** A homepage that sends visitors to the day's edition; the editions of `lost` were never archived. */
function daily(lost: string[], how: 'redirect' | 'refresh'): FakeCapture[] {
  const captures: FakeCapture[] = [];
  for (const m of monthRange('201001', '202112')) {
    const ts = `${m}10120000`;
    const edition = `/edition/${ts.slice(0, 8)}/`;
    if (m >= '202001') captures.push({ url: 'http://example.com/', ts, body: PARKED });
    else if (how === 'redirect') captures.push({ url: 'http://example.com/', ts, status: 302, location: edition });
    else captures.push({ url: 'http://example.com/', ts, body: `<html><head><meta http-equiv="refresh" content="0; url=${edition}"></head><body></body></html>` });
    if (m < '202001' && !lost.includes(m)) captures.push({ url: `http://example.com${edition}`, ts, body: good(`Daily ${m}`) });
  }
  return captures;
}

describe("health2: the site's own way to a page the archive lost in one month", () => {
  for (const how of ['redirect', 'refresh'] as const) {
    // 2018-12 is a spread probe; 2019-09 and 2019-11 are narrowing ones.
    for (const lost of ['201812', '201909', '201911']) {
      it(`keeps the site going past a lost edition (${how}, ${lost})`, async () => {
        const h = await scan(daily([lost], how));
        assert.equal(h.lastGood?.month, '201912');
        assert.deepEqual(h.window, { to: '20191231235959' });
        assert.ok(h.months.filter((m) => m.month < '202001').every((m) => m.verdict === 'good'));
        const failed = h.months.find((m) => m.month === lost)!;
        if (failed.probed) assert.ok(failed.reasons.includes('estimated from the months around it'), failed.reasons.join('; '));
      });
    }
  }

  it('restores the pages of the months after the lost one', async () => {
    const captures = daily(['201812'], 'redirect');
    captures.push({ url: 'http://example.com/about-2019.html', ts: '20190610120000', body: good() });
    const archive = await startFakeArchive(captures);
    try {
      const client = new ArchiveClient({ base: archive.base, ...FAST });
      const h = await scanHealth(client, 'example.com');
      const index = await buildIndex(client, { domain: 'example.com', target: h.lastGood!.timestamp, window: h.window });
      const paths = [...index.values()].map((c) => new URL(c.original).pathname);
      assert.ok(paths.includes('/about-2019.html'));
      assert.equal(paths.filter((p) => p.startsWith('/edition/2019')).length, 12);
    } finally {
      await archive.close();
    }
  });

  it("still ends the site at a later owner's lander that a parked page follows", async () => {
    const lander = '<html><head><title>example.com</title><script>window.location.href="/lander"</script></head><body></body></html>';
    const body = (m: string) => (m < '202001' ? good() : m < '202201' ? lander : PARKED);
    const h = await scan(monthRange('201001', '202312').map((m) => ({ url: 'http://example.com/', ts: `${m}10120000`, body: body(m) })));
    assert.equal(h.lastGood?.month, '201912');
    assert.deepEqual(h.window, { to: '20191231235959' });
    assert.ok(h.months.filter((m) => m.month >= '202001').every((m) => m.verdict === 'bad'));
  });
});

describe("health2: a later owner's one-link page and the old site's last pages", () => {
  it('does not take a page captured just after the old homepage, behind a redirect to the one-link page', async () => {
    // Each crawl of the old site took the homepage, then /contact.html five minutes later. The later
    // owner's homepage redirects to /start.html, a page it has, that links to /contact.html.
    for (const status of [301, 302]) {
      const captures: FakeCapture[] = [];
      for (const m of monthRange('200401', '201212')) {
        if (m <= '200806') {
          captures.push({ url: 'http://example.com/', ts: `${m}10120000`, body: good() });
          if (Number(m.slice(4)) % 3 === 0) captures.push({ url: 'http://example.com/contact.html', ts: `${m}10120500`, body: good('Contact the bakery') });
        } else if (m >= '200809') {
          captures.push({ url: 'http://example.com/', ts: `${m}10120000`, status, location: 'http://example.com/start.html' });
          captures.push({ url: 'http://example.com/start.html', ts: `${m}10120100`, body: oneLink });
        }
      }
      const h = await scan(captures);
      assert.equal(h.lastGood?.month, '200806', String(status));
      assert.equal(h.window.to, '20080831235959', String(status));
      assert.ok(h.months.filter((m) => m.month >= '200809').every((m) => m.verdict === 'bad'), String(status));
    }
  });

  it('does not take a page captured between the last old homepage and the takeover', async () => {
    // Yearly homepage captures: the old one last in 2007-06, /contact.html in 2008-04, nearer the
    // one-link page that followed in 2008-08 than the old homepage before it.
    const yearly: FakeCapture[] = [];
    for (let y = 2004; y <= 2007; y++) yearly.push({ url: 'http://example.com/', ts: `${y}0610120000`, body: good() });
    yearly.push({ url: 'http://example.com/', ts: '20080810120000', body: oneLink });
    for (let y = 2009; y <= 2012; y++) yearly.push({ url: 'http://example.com/', ts: `${y}0610120000`, body: oneLink });
    for (const m of ['200503', '200703', '200804']) yearly.push({ url: 'http://example.com/contact.html', ts: `${m}10120000`, body: good('Contact the bakery') });
    let h = await scan(yearly);
    assert.equal(h.lastGood?.month, '200706');
    assert.equal(h.window.to, '20080731235959');

    // Monthly: the old homepage last in 2008-01, /contact.html in 2008-06, the takeover from 2008-09.
    const monthly: FakeCapture[] = [];
    for (const m of monthRange('200401', '200801')) monthly.push({ url: 'http://example.com/', ts: `${m}10120000`, body: good() });
    for (const m of monthRange('200809', '201212')) monthly.push({ url: 'http://example.com/', ts: `${m}10120000`, body: oneLink });
    for (const m of ['200503', '200703', '200806']) monthly.push({ url: 'http://example.com/contact.html', ts: `${m}10120000`, body: good('Contact the bakery') });
    h = await scan(monthly);
    assert.equal(h.lastGood?.month, '200801');
    assert.equal(h.window.to, '20080831235959');
    assert.ok(h.months.filter((m) => m.month >= '200809').every((m) => m.verdict !== 'good'));
  });
});
