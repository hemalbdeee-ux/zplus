// Health scan cases left over from the first round of fixes: stubs whose page cannot be had, a later
// owner's one-link page, ordinary small homepages with a parking phrase on every capture, mailto
// scripts, and parked months known only by their digest.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArchiveClient, type CaptureResult } from '../src/engine/archive.ts';
import { analyzePage, scanHealth, scoreSignals, type HealthReport } from '../src/engine/health.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };

/** Answers "not playable" for chosen captures (timestamp plus a piece of the URL). */
class FlakyClient extends ArchiveClient {
  failing: Array<{ ts: string; url: string }> = [];
  async fetchCapture(timestamp: string, original: string): Promise<CaptureResult> {
    if (this.failing.some((f) => f.ts === timestamp && original.includes(f.url))) return { kind: 'missing', status: 503, reason: 'HTTP 503' };
    return super.fetchCapture(timestamp, original);
  }
}

async function scan(captures: FakeCapture[], failing: Array<{ ts: string; url: string }> = []): Promise<HealthReport> {
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

const links = (n: number, p = 'p') => Array.from({ length: n }, (_, i) => `<a href="/${p}${i}.html">${p}${i}</a>`).join(' ');
const words = (n: number, w = 'bread') => Array.from({ length: n }, (_, i) => `${w}${i % 40}`).join(' ');
const GOOD = `<html lang="en"><head><title>Bakery</title></head><body>${links(8)}<p>${words(300)}</p></body></html>`;
const PARKED = '<html><body><h1>parked</h1><p>This domain may be for sale!</p></body></html>';

describe('health: a stub whose page cannot be played', () => {
  const stubs: Record<string, string> = {
    'meta refresh': '<html><head><meta http-equiv="refresh" content="0; url=/home.html"></head><body></body></html>',
    splash: '<html><head><title>Bakery</title></head><body><a href="/home.html"><img src="/splash.jpg" alt="">ENTER</a></body></html>',
    frameset: '<html><head><title>Bakery</title></head><frameset cols="200,*"><frame src="/nav.html" name="nav"><frame src="/home.html" name="main"></frameset></html>',
  };
  for (const [name, stub] of Object.entries(stubs)) {
    it(`does not score the empty ${name} and copy that to every month`, async () => {
      // The same stub 2010-2019 (one digest), the page behind it a little different every month.
      const captures: FakeCapture[] = [];
      for (const m of monthRange('201001', '202112')) {
        const ts = `${m}10120000`;
        if (m >= '202001') captures.push({ url: 'http://example.com/', ts, body: PARKED });
        else {
          captures.push({ url: 'http://example.com/', ts, body: stub });
          captures.push({ url: 'http://example.com/home.html', ts, body: GOOD.replace('Bakery', `Bakery ${m}`) });
        }
      }
      const clean = await scan(captures);
      assert.equal(clean.lastGood?.month, '201912');
      // 2018-12 is a spread probe, 2019-09 a narrowing one.
      for (const ts of ['20181210120000', '20190910120000']) {
        const h = await scan(captures, [{ ts, url: 'home.html' }]);
        assert.equal(h.lastGood?.month, '201912', `${name} ${ts}`);
        assert.deepEqual(h.window, clean.window, `${name} ${ts}`);
        assert.ok(h.months.filter((m) => m.month < '202001').every((m) => m.verdict === 'good'), `${name} ${ts}`);
        const failed = h.months.find((m) => m.timestamp === ts)!;
        assert.match(failed.reasons[0], /^capture not playable/);
      }
    });
  }
});

describe('health: the page behind a stub is from another time', () => {
  it("does not take a later owner's one-link page for the site", async () => {
    const captures: FakeCapture[] = [];
    for (let y = 2004; y <= 2012; y++) {
      const body = y <= 2008 ? GOOD : '<html><head><title>example.com</title></head><body><a href="/contact.html">Contact</a></body></html>';
      captures.push({ url: 'http://example.com/', ts: `${y}0610120000`, body });
    }
    // The archive plays this one capture of the old site for any date.
    captures.push({ url: 'http://example.com/contact.html', ts: '20070610120000', body: GOOD.replace('Bakery', 'Contact the bakery') });
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '200806');
    assert.ok(h.window.to && h.window.to < '20100101000000', JSON.stringify(h.window));
    assert.ok(h.months.filter((m) => m.month >= '200901').every((m) => m.verdict !== 'good'));
  });

  it('still takes a page captured years away while the same stub was the homepage', async () => {
    const stub = '<html><head><meta http-equiv="refresh" content="0; url=/home.html"></head><body></body></html>';
    const captures: FakeCapture[] = monthRange('200401', '201212').map((m) => ({ url: 'http://example.com/', ts: `${m}10120000`, body: m < '201101' ? stub : PARKED }));
    // Captured once: every later month is played this capture, years away.
    captures.push({ url: 'http://example.com/home.html', ts: '20040310120000', body: GOOD });
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '201012');
    assert.equal(h.window.to, '20101231235959');
    assert.ok(h.months.filter((m) => m.month < '201101').every((m) => m.verdict === 'good'));
  });
});

describe('health: a parking phrase on an ordinary small homepage', () => {
  const nav = links(7, 'menu');
  const small = (phrase: string) =>
    `<html lang="en"><head><title>Luigi's Trattoria</title></head><body><nav>${nav}</nav><h1>Welcome</h1><p>${words(80, 'pasta')} ${phrase}</p></body></html>`;

  it('leaves a short page with a title and a menu good', () => {
    for (const phrase of ['Online ordering coming soon!', 'Log in to renew your domain.', 'This site is always under construction.']) {
      const s = analyzePage(small(phrase), 'http://example.com/', 'example.com');
      assert.equal(s.fatal, null, phrase);
      assert.equal(scoreSignals(s, {}).verdict, 'good', phrase);
    }
  });

  it('finds a snapshot when every capture has the phrase', async () => {
    const captures = monthRange('201601', '201812').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: m < '201801' ? small('Online ordering coming soon!') : PARKED }));
    const h = await scan(captures);
    assert.equal(h.lastGood?.month, '201712');
    assert.equal(h.window.to, '20171231235959');
  });

  it('still scores a parking page with ad links and legal links bad', () => {
    const ads = ['cheap flights', 'car insurance', 'loans', 'hotels'].map((q) => `<a href="/search?q=${encodeURIComponent(q)}">${q}</a>`).join(' ');
    const html = `<html><head><title>example.com</title></head><body><h1>example.com</h1><p>Related Searches</p>${ads}<a href="/privacy.html">Privacy</a> <a href="/contact.html">Contact</a></body></html>`;
    assert.equal(scoreSignals(analyzePage(html, 'http://example.com/', 'example.com'), {}).verdict, 'bad');
  });
});

describe('health: scripts that are not redirects', () => {
  it('does not take a mailto or javascript: address in a script for a redirect', () => {
    const scripts = [
      "var u = 'info'; function mail() { location.href = 'mailto:' + u + '@example.com'; }",
      "function mail() { window.location = 'mailto:info@example.com'; }",
      "function back() { location.href = 'javascript:history.back()'; }",
    ];
    for (const js of scripts) {
      const s = analyzePage(`<html><head><title>Smith</title><script>${js}</script></head><body><a href="/gallery.html">Enter</a></body></html>`, 'http://example.com/', 'example.com');
      assert.equal(s.fatal, null, js);
      assert.equal(s.follow, 'http://example.com/gallery.html', js);
    }
  });

  it('still finds the redirect after a mailto in the same script', () => {
    const js = "function mail() { location.href = 'mailto:info@example.com'; } window.location = 'https://other.example/';";
    const s = analyzePage(`<html><head><script>${js}</script></head><body></body></html>`, 'http://example.com/', 'example.com');
    assert.equal(s.fatal, 'sends visitors to other.example');
  });
});

describe('health: frames', () => {
  it('does not take a frame named "mainmenu" for the main frame', () => {
    const html = '<html><head><title>Bakery</title></head><frameset cols="200,*"><frame name="mainmenu" src="/menu.html"><frame name="content" src="/home.html"></frameset></html>';
    assert.equal(analyzePage(html, 'http://example.com/', 'example.com').follow, 'http://example.com/home.html');
  });
});

describe('health: window', () => {
  it('starts the window after parked months known only by their digest', async () => {
    const OLD = `<html lang="en"><head><title>Plumbing</title></head><body>${links(10, 'q')}<p>${words(300, 'pipe')}</p></body></html>`;
    // An earlier owner, then the same parking page as from 2017, none of these months probed.
    const body = (m: string) => (m <= '200701' ? OLD : m <= '200705' ? PARKED : m < '201701' ? GOOD : PARKED);
    const h = await scan(monthRange('200301', '201812').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: body(m) })));
    const parked = h.months.filter((m) => m.month >= '200702' && m.month <= '200705');
    assert.ok(parked.every((m) => !m.probed && m.verdict === 'bad'), 'the test needs these months unprobed');
    assert.ok(parked.every((m) => m.reasons.some((r) => /parked/.test(r))), parked[0].reasons.join('; '));
    assert.equal(h.window.from, '20070601000000');
  });
});
