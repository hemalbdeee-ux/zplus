// The health scan end to end against the fake archive: which snapshot it picks and which window
// it keeps, for sites whose history is less tidy than "good, then parked".

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ArchiveClient, type CaptureResult } from '../src/engine/archive.ts';
import { scanHealth, type HealthReport } from '../src/engine/health.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };

/** Answers "not playable" for chosen timestamps, like a capture the archive keeps failing on. */
class FlakyClient extends ArchiveClient {
  failing = new Set<string>();
  async fetchCapture(timestamp: string, original: string): Promise<CaptureResult> {
    if (this.failing.has(timestamp)) return { kind: 'missing', status: 503, reason: 'HTTP 503' };
    return super.fetchCapture(timestamp, original);
  }
}

async function scan(domain: string, captures: FakeCapture[], failing: string[] = []): Promise<HealthReport> {
  const archive = await startFakeArchive(captures);
  try {
    const client = new FlakyClient({ base: archive.base, ...FAST });
    for (const ts of failing) client.failing.add(ts);
    return await scanHealth(client, domain);
  } finally {
    await archive.close();
  }
}

/** YYYYMM for every month from `from` to `to`, inclusive. */
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
const verdictOf = (h: HealthReport, month: string) => h.months.find((m) => m.month === month)?.verdict;

describe('health scan: narrowing', () => {
  it('ends when a weak month sits between the last good and the first parked one', () => {
    const fixture = fileURLToPath(new URL('./fixtures/health-weak-month.ts', import.meta.url));
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fixture], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.signal, null, 'the scan did not finish');
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.lastGood, '201901');
    assert.deepEqual(out.verdicts, ['good', 'weak', 'bad']);
  });

  it('finds a short real site between long parked periods', async () => {
    const real = (m: string) => m >= '201002' && m <= '201206';
    // Parked pages that are all alike, and parked pages that differ every month.
    for (const parked of [() => PARKED, (m: string) => PARKED.replace('parked', `parked ${m}`)]) {
      const captures = monthRange('200501', '202412').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: real(m) ? GOOD : parked(m) }));
      const h = await scan('example.com', captures);
      assert.ok(h.lastGood && real(h.lastGood.month), `lastGood ${h.lastGood?.month}`);
      assert.equal(h.window.from, '20100201000000');
    }
  });
});

describe('health scan: archive failures', () => {
  // Good 2010-2019 with the same homepage throughout, parked from 2020.
  const captures = monthRange('201001', '202112').map((m) => ({ url: 'http://example.com/', ts: `${m}10120000`, body: m < '202001' ? GOOD : PARKED }));

  it('does not let one unplayable capture turn the site bad', async () => {
    const clean = await scan('example.com', captures);
    assert.equal(clean.lastGood?.month, '201912');
    // 2018-12 is a spread probe, 2019-09 a narrowing probe.
    for (const ts of ['20181210120000', '20190910120000']) {
      const h = await scan('example.com', captures, [ts]);
      assert.equal(h.lastGood?.month, '201912', ts);
      assert.deepEqual(h.window, clean.window, ts);
      assert.ok(h.months.filter((m) => m.month < '202001').every((m) => m.verdict === 'good'), ts);
      const failed = h.months.find((m) => m.timestamp === ts)!;
      assert.ok(failed.probed && failed.reasons[0].startsWith('capture not playable'), ts);
    }
  });

  it('does not pick a capture the archive cannot play as the snapshot', async () => {
    const h = await scan('example.com', captures, ['20191210120000']);
    assert.equal(h.lastGood?.month, '201911');
    assert.equal(h.window.to, '20191231235959');
  });
});

describe('health scan: homepages that are not the page', () => {
  it('follows a chain of redirects the site made', async () => {
    const chains: Array<Array<[string, string]>> = [
      [['/', '/blog'], ['/blog', '/blog/']],
      [['/', '/index.php'], ['/index.php', '/index.php?lang=en']],
    ];
    for (const chain of chains) {
      const final = chain[chain.length - 1][1];
      const captures: FakeCapture[] = [];
      for (const m of monthRange('201901', '201912')) {
        const ts = `${m}10120000`;
        for (const [from, to] of chain) captures.push({ url: `http://example.com${from}`, ts, status: 301, location: to });
        captures.push({ url: `http://example.com${final}`, ts, body: GOOD });
      }
      const h = await scan('example.com', captures);
      assert.equal(h.lastGood?.month, '201912', final);
      assert.ok(h.months.every((m) => m.verdict === 'good'), final);
    }
  });

  it('scores the page a stub homepage leads to', async () => {
    const stubs: Record<string, string> = {
      'meta refresh': '<html><head><meta http-equiv="refresh" content="0; url=/home.html"></head><body></body></html>',
      frameset: '<html><head><title>Bakery</title></head><frameset cols="200,*"><frame src="/nav.html" name="nav"><frame src="/home.html" name="main"></frameset></html>',
      splash: '<html><head><title>Bakery</title></head><body><a href="/home.html"><img src="/splash.jpg" alt="">ENTER</a></body></html>',
      script: '<html><body><script>window.location.href = "/home.html";</script></body></html>',
    };
    for (const [name, stub] of Object.entries(stubs)) {
      const captures: FakeCapture[] = [];
      for (const m of monthRange('201201', '201210')) {
        captures.push({ url: 'http://example.com/', ts: `${m}10120000`, body: stub });
        captures.push({ url: 'http://example.com/home.html', ts: `${m}10120000`, body: GOOD });
      }
      const h = await scan('example.com', captures);
      assert.equal(h.lastGood?.month, '201210', name);
    }
  });

  it('takes the www host from where the redirects led', async () => {
    for (const host of ['www.example.com', 'example.com']) {
      const captures: FakeCapture[] = [];
      for (const m of monthRange('201801', '201810')) {
        captures.push({ url: `http://${host}/`, ts: `${m}10120000`, status: 302, location: `http://${host}/index.php` });
        captures.push({ url: `http://${host}/index.php`, ts: `${m}10120000`, body: GOOD });
      }
      const h = await scan('example.com', captures);
      assert.ok(h.lastGood, host);
      assert.equal(h.host, host);
    }
  });
});

describe('health scan: page size', () => {
  it('measures the usual size on the site itself, not on a heavier spam site after it', async () => {
    const small = `<html lang="en"><head><title>Smith's Shop</title></head><body>${links(6)}<p>${words(220, 'shop')}</p></body></html>`;
    const spam = `<html lang="en"><head><title>Slot gacor</title><script>${'var theme = 1;'.repeat(2500)}</script></head><body>${links(20)}<p>${'slot gacor judi togel casino '.repeat(20)}${words(300, 'win')}</p></body></html>`;
    const captures = monthRange('201001', '202312')
      .filter((m) => Number(m.slice(4)) % 3 === 1)
      .map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: m < '201401' ? small : spam }));
    const h = await scan('example.com', captures);
    assert.equal(h.lastGood?.month, '201310');
    assert.ok(h.months.filter((m) => m.month < '201401').every((m) => m.verdict === 'good'));
  });
});

describe('health scan: window', () => {
  const site = (bad: (m: string) => FakeCapture | undefined) =>
    monthRange('200801', '201812').map((m) => bad(m) ?? { url: 'http://example.com/', ts: `${m}15120000`, body: m < '201701' ? GOOD : PARKED });

  it('keeps the history before a short outage', async () => {
    const h = await scan('example.com', site((m) => (m === '201205' || m === '201206' ? { url: 'http://example.com/', ts: `${m}15120000`, status: 503, body: 'down' } : undefined)));
    assert.equal(verdictOf(h, '201205'), 'bad');
    assert.equal(h.lastGood?.month, '201612');
    assert.deepEqual(h.window, { to: '20161231235959' });
  });

  it('keeps the history before a maintenance page', async () => {
    const maintenance = '<html><head><title>Maintenance</title></head><body><h1>Site is under maintenance</h1><p>Back soon.</p></body></html>';
    // 2010-10 is one of the spread probes.
    const h = await scan('example.com', site((m) => (m === '201010' ? { url: 'http://example.com/', ts: `${m}15120000`, body: maintenance } : undefined)));
    const month = h.months.find((m) => m.month === '201010')!;
    assert.ok(month.probed && month.verdict === 'bad', month.reasons.join('; '));
    assert.deepEqual(h.window, { to: '20161231235959' });
  });

  it('still starts the window after an outage of half a year or more', async () => {
    const h = await scan('example.com', site((m) => (m >= '201201' && m <= '201207' ? { url: 'http://example.com/', ts: `${m}15120000`, status: 503, body: 'down' } : undefined)));
    assert.equal(h.window.from, '20120801000000');
  });

  it('starts the window after an earlier owner parked the domain', async () => {
    const captures = [...monthRange('200501', '200712').map((m) => ({ url: 'http://example.com/', ts: `${m}15120000`, body: PARKED })), ...site(() => undefined)];
    const h = await scan('example.com', captures);
    assert.equal(h.window.from, '20080101000000');
  });
});
