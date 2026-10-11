// Round-2 health cases around stub homepages: a later (or earlier) owner's lander whose target was
// never archived, a later owner's one-link page that the archive answers with a page of the old
// site, and the site's own stubs that must stay good while the archive drops one of their pages.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArchiveClient, type CaptureResult } from '../src/engine/archive.ts';
import { buildIndex } from '../src/engine/crawl.ts';
import { scanHealth, type HealthReport } from '../src/engine/health.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };

/** Answers chosen captures (timestamp plus the end of the URL) the way a failing archive does. */
class FlakyClient extends ArchiveClient {
  failing: Array<{ ts?: string; url: string; res: CaptureResult }> = [];
  async fetchCapture(timestamp: string, original: string): Promise<CaptureResult> {
    const f = this.failing.find((x) => (!x.ts || x.ts === timestamp) && original.endsWith(x.url));
    return f ? f.res : super.fetchCapture(timestamp, original);
  }
}

const REFUSED: CaptureResult = { kind: 'missing', status: 503, reason: 'HTTP 503', transient: true };

async function scan(captures: FakeCapture[], failing: FlakyClient['failing'] = []): Promise<HealthReport> {
  const archive = await startFakeArchive(captures);
  try {
    const client = new FlakyClient({ base: archive.base, ...FAST });
    client.failing = failing;
    return await scanHealth(client, 'example.com');
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
const words = (n: number, w = 'bread') => Array.from({ length: n }, (_, i) => `${w}${i % 40}`).join(' ');
const GOOD = `<html lang="en"><head><title>Bakery</title></head><body>${links(8)}<p>${words(300)}</p></body></html>`;
const PARKED = '<html><body><h1>parked</h1><p>This domain may be for sale!</p></body></html>';
const META = '<html><head><meta http-equiv="refresh" content="0; url=/home.html"></head><body></body></html>';
const notGoodFrom = (h: HealthReport, month: string) => h.months.filter((m) => m.month >= month).every((m) => m.verdict !== 'good');

describe('health2: a later owner\'s lander whose target was never archived', () => {
  it('scores the lander bad and closes the window, at a third of the homepage size', async () => {
    // The usual Bodis/ParkingCrew lander: a script sends visitors to /lander, which the archive never
    // captured. Padded to about 0.35 of the real homepage, so its size alone does not give it away.
    const pad = Math.round(GOOD.length * 0.35) - 200;
    const lander = `<html><head><title>example.com</title><script>var cfg=${JSON.stringify('x'.repeat(pad))};</script><script>window.onload=function(){window.location.href="/lander"}</script></head><body></body></html>`;
    const captures: FakeCapture[] = monthRange('201001', '202312').map((m) => ({ url: 'http://example.com/', ts: `${m}10120000`, body: m < '202001' ? GOOD : lander }));
    for (let i = 0; i < 8; i++) captures.push({ url: `http://example.com/p${i}.html`, ts: '20150610120000', body: GOOD });
    captures.push({ url: 'http://example.com/slot-gacor.html', ts: '20220610120000', body: '<html><body>slot gacor</body></html>' });
    const archive = await startFakeArchive(captures);
    try {
      const client = new ArchiveClient({ base: archive.base, ...FAST });
      const h = await scanHealth(client, 'example.com');
      assert.equal(h.lastGood?.month, '201912');
      assert.equal(h.window.to, '20191231235959');
      assert.ok(notGoodFrom(h, '202001'));
      const probed = h.months.find((m) => m.probed && m.month >= '202001')!;
      assert.equal(probed.verdict, 'bad');
      assert.ok(probed.reasons.some((r) => /the page it leads to: capture not playable/.test(r)), probed.reasons.join('; '));
      // The later owner's pages stay out of the restore.
      const index = await buildIndex(client, { domain: 'example.com', target: h.lastGood!.timestamp, window: h.window });
      assert.ok(![...index.values()].some((c) => c.original.includes('slot-gacor')));
    } finally {
      await archive.close();
    }
  });

  it("scores a later owner's one-link page bad when the page it links to was never archived", async () => {
    const tiny = '<html><head><title>example.com</title></head><body><a href="/contact.html">Contact</a></body></html>';
    const heavy = `<html><head><title>example.com</title><style>${'.x{color:red}'.repeat(400)}</style></head><body><h1>New things coming</h1><a href="/shop/">Shop</a></body></html>`;
    for (const page of [tiny, heavy]) {
      const h = await scan(monthRange('201001', '202312').map((m) => ({ url: 'http://example.com/', ts: `${m}10120000`, body: m < '202001' ? GOOD : page })));
      assert.equal(h.lastGood?.month, '201912');
      assert.equal(h.window.to, '20191231235959');
      assert.ok(notGoodFrom(h, '202001'));
    }
  });

  it("starts the window after an earlier owner's one-link page", async () => {
    const heavy = `<html><head><title>example.com</title><style>${'.x{color:red}'.repeat(400)}</style></head><body><h1>New things coming</h1><a href="/shop/">Shop</a></body></html>`;
    const body = (m: string) => (m < '201001' ? heavy : m < '202001' ? GOOD : PARKED);
    const h = await scan(monthRange('200501', '202112').map((m) => ({ url: 'http://example.com/', ts: `${m}10120000`, body: body(m) })));
    assert.equal(h.lastGood?.month, '201912');
    assert.equal(h.window.from, '20100101000000');
    assert.equal(h.window.to, '20191231235959');
  });

  it('scores a spam page whose refresh leads to a page never archived as spam', async () => {
    const spam = `<html><head><title>Slot gacor</title><meta http-equiv="refresh" content="0; url=/go/"></head><body><p>${'slot gacor judi togel casino '.repeat(10)}</p></body></html>`;
    const h = await scan(monthRange('201001', '202312').map((m) => ({ url: 'http://example.com/', ts: `${m}10120000`, body: m < '202001' ? GOOD : spam })));
    assert.equal(h.window.to, '20191231235959');
    const probed = h.months.find((m) => m.probed && m.month >= '202001')!;
    assert.match(probed.reasons[0], /spam words/);
  });

  it('scores a redirect to a page never archived bad, without touching the site\'s own redirects', async () => {
    // Both redirects have empty bodies, so one digest: the lander's verdict must not be copied to the
    // months in which the site's own redirect led to its page.
    const captures: FakeCapture[] = [];
    for (const m of monthRange('201001', '202312')) {
      const ts = `${m}10120000`;
      if (m < '202001') {
        captures.push({ url: 'http://example.com/', ts, status: 302, location: '/index.php' });
        captures.push({ url: 'http://example.com/index.php', ts, body: GOOD });
      } else captures.push({ url: 'http://example.com/', ts, status: 302, location: '/lander' });
    }
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '201912');
    assert.equal(h.window.to, '20191231235959');
    assert.ok(h.months.filter((m) => m.month < '202001').every((m) => m.verdict === 'good'));
    assert.ok(notGoodFrom(h, '202001'));
  });
});

describe("health2: a later owner's stub answered with a page of the old site", () => {
  const oneLink = '<html><head><title>example.com</title></head><body><a href="/contact.html">Contact</a></body></html>';
  // The old homepage changes every month, so no digest tells what the months in between were.
  const old = (m: string) => GOOD.replace('Bakery', `Bakery ${m}`);

  it('does not take the old page for the site, however soon the takeover came', async () => {
    const captures: FakeCapture[] = [];
    for (const m of monthRange('200401', '201212')) {
      if (m <= '200806') captures.push({ url: 'http://example.com/', ts: `${m}10120000`, body: old(m) });
      else if (m >= '200809') captures.push({ url: 'http://example.com/', ts: `${m}10120000`, body: oneLink });
    }
    // Last captured six months before the takeover: within any "near in time" allowance.
    for (const m of ['200503', '200703', '200803']) captures.push({ url: 'http://example.com/contact.html', ts: `${m}10120000`, body: GOOD.replace('Bakery', 'Contact the bakery') });
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '200806');
    assert.equal(h.window.to, '20080831235959');
    assert.ok(notGoodFrom(h, '200807'));
  });

  it('leaves those months unknown when the archive refuses the old homepage it would compare with', async () => {
    const captures: FakeCapture[] = [];
    for (const m of monthRange('200401', '201212')) {
      if (m <= '200806') captures.push({ url: 'http://example.com/', ts: `${m}10120000`, body: old(m) });
      else if (m >= '200809') captures.push({ url: 'http://example.com/', ts: `${m}10120000`, body: oneLink });
    }
    captures.push({ url: 'http://example.com/contact.html', ts: '20080310120000', body: GOOD.replace('Bakery', 'Contact the bakery') });
    const h = await scan(captures, [{ ts: '20080310120000', url: 'example.com/', res: REFUSED }]);
    assert.equal(h.lastGood?.month, '200806');
    const after = h.months.filter((m) => m.month >= '200809');
    assert.ok(after.every((m) => m.verdict !== 'good'));
    const probed = after.find((m) => m.probed)!;
    assert.match(probed.reasons[0], /the archive did not play what the homepage was then \(HTTP 503\)/);
  });

  it('does so for a one-link page that only lasted a few months', async () => {
    const captures: FakeCapture[] = [];
    for (const m of monthRange('200401', '201212')) {
      const body = m <= '200806' ? old(m) : m <= '200808' ? null : m <= '200906' ? oneLink : PARKED;
      if (body) captures.push({ url: 'http://example.com/', ts: `${m}10120000`, body });
    }
    captures.push({ url: 'http://example.com/contact.html', ts: '20080310120000', body: GOOD.replace('Bakery', 'Contact') });
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '200806');
    assert.equal(h.window.to, '20080831235959');
  });

  it('does not take the same stub bytes again after a parked spell for the old site', async () => {
    const captures: FakeCapture[] = [];
    for (const m of monthRange('200401', '201212')) {
      const ts = `${m}10120000`;
      captures.push({ url: 'http://example.com/', ts, body: m <= '200612' || m > '200812' ? META : PARKED });
      if (m <= '200612') captures.push({ url: 'http://example.com/home.html', ts: `${m}10120100`, body: GOOD });
    }
    const h = await scan(captures);
    assert.ok(h.lastGood && h.lastGood.month <= '200612', h.lastGood?.month);
    assert.ok(notGoodFrom(h, '200701'));
  });
});

describe("health2: the site's own stubs", () => {
  it('takes a page captured years away while a stub that changes every capture led there', async () => {
    const captures: FakeCapture[] = [];
    for (const m of monthRange('200401', '201206')) {
      const ts = `${m}10120000`;
      // A date in a comment: every capture has its own digest.
      if (m <= '201012') captures.push({ url: 'http://example.com/', ts, body: META.replace('</head>', `<!-- ${ts} --></head>`) });
      else captures.push({ url: 'http://example.com/', ts, body: PARKED });
    }
    captures.push({ url: 'http://example.com/home.html', ts: '20040310120000', body: GOOD });
    captures.push({ url: 'http://example.com/home.html', ts: '20100910120000', body: GOOD });
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '201012');
    assert.equal(h.window.to, '20101231235959');
    assert.ok(h.months.filter((m) => m.month <= '201012').every((m) => m.verdict === 'good'));
  });

  it('takes the main frame of a frameset the homepage redirects to, captured once', async () => {
    const frameset = '<html><head><title>Bakery</title></head><frameset cols="180,*"><frame src="/menu.htm" name="menu"><frame src="/main.htm" name="main"></frameset></html>';
    const captures: FakeCapture[] = [];
    for (const m of monthRange('200401', '201206')) {
      const ts = `${m}10120000`;
      if (m <= '201012') {
        captures.push({ url: 'http://example.com/', ts, status: 301, location: 'http://example.com/index.htm' });
        captures.push({ url: 'http://example.com/index.htm', ts: `${m}10120100`, body: frameset });
      } else captures.push({ url: 'http://example.com/', ts, body: PARKED });
    }
    captures.push({ url: 'http://example.com/main.htm', ts: '20040310120000', body: GOOD });
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '201012');
    assert.equal(h.window.to, '20101231235959');
  });

  it('leaves a month unknown when the archive refuses the page behind a stub with its own digest', async () => {
    const captures: FakeCapture[] = [];
    for (const m of monthRange('201001', '202112')) {
      const ts = `${m}10120000`;
      if (m < '202001') {
        captures.push({ url: 'http://example.com/', ts, body: META.replace('</head>', `<!-- ${ts} --></head>`) });
        captures.push({ url: 'http://example.com/home.html', ts, body: GOOD });
      } else captures.push({ url: 'http://example.com/', ts, body: PARKED });
    }
    const clean = await scan(captures);
    // 2018-12 is a spread probe.
    const h = await scan(captures, [{ ts: '20181210120000', url: 'home.html', res: REFUSED }]);
    assert.equal(h.lastGood?.month, '201912');
    assert.deepEqual(h.window, clean.window);
    const failed = h.months.find((m) => m.month === '201812')!;
    assert.ok(failed.probed && failed.verdict === 'good', failed.reasons.join('; '));
    assert.match(failed.reasons[0], /^capture not playable/);
  });

  it('does not score its own stub as itself when the archive cannot play the page in one month', async () => {
    // Not an archive failure: the page behind the stub redirects in a loop in that one month. The
    // stub is the same every month, or carries the date and so has a digest of its own each month.
    for (const stub of [() => META, (ts: string) => META.replace('</head>', `<!-- ${ts} --></head>`)]) {
      const captures: FakeCapture[] = [];
      for (const m of monthRange('201001', '202112')) {
        const ts = `${m}10120000`;
        if (m < '202001') {
          captures.push({ url: 'http://example.com/', ts, body: stub(ts) });
          captures.push({ url: 'http://example.com/home.html', ts, body: GOOD.replace('Bakery', `Bakery ${m}`) });
        } else captures.push({ url: 'http://example.com/', ts, body: PARKED });
      }
      // 2018-12 is a spread probe, 2019-09 a narrowing one.
      for (const ts of ['20181210120000', '20190910120000']) {
        const loop: FlakyClient['failing'] = [
          { ts, url: '/home.html', res: { kind: 'redirect', timestamp: ts, status: 302, location: 'http://example.com/home2.html' } },
          { ts, url: '/home2.html', res: { kind: 'redirect', timestamp: ts, status: 302, location: 'http://example.com/home.html' } },
        ];
        const h = await scan(captures, loop);
        assert.equal(h.lastGood?.month, '201912', ts);
        assert.equal(h.window.to, '20191231235959', ts);
        assert.ok(h.months.filter((m) => m.month < '202001').every((m) => m.verdict === 'good'), ts);
        assert.ok(h.months.find((m) => m.timestamp === ts)?.probed, ts);
      }
    }
  });
});
