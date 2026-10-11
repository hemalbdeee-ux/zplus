// What a restore takes and tells: never a later owner's pages when the scan found no good month or
// was skipped, dates checked before any request, a re-run that continues the earlier snapshot,
// refusals counted apart from gaps in the archive, and one note on Cloudflare Pages' rule limits.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { BuildResult } from '../src/engine/build.ts';
import type { Manifest } from '../src/engine/crawl.ts';
import type { MonthHealth } from '../src/engine/health.ts';
import { hostingNotes, makeReport, reportHtml } from '../src/engine/report.ts';
import { restore, windowAround } from '../src/engine/restore.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = (t: string, b = '') => `<html><head><title>${t}</title></head><body><h1>${t}</h1>${b}</body></html>`;

function cli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // Not spawnSync: the fake archive answers from this process.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'zp-restore5-'));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

// A homepage that was always thin (a short splash with a menu scores "weak" every month), parked
// from 2021 with a link to the later owner's spam page.
const W = 'http://www.splash.example';
const SPLASH: FakeCapture[] = [
  ...[2015, 2016, 2017, 2018, 2019, 2020].map((y) => ({
    url: `${W}/`,
    ts: `${y}0610120000`,
    body: html('Splash Ceramics', `<p>${'Hand made ceramics from our studio by the sea. '.repeat(4)}</p>${['gallery', 'about', 'shop', 'contact', 'news', 'links'].map((p) => `<a href="/${p}.html">${p}</a>`).join(' ')}`),
  })),
  ...['gallery', 'about', 'shop', 'contact', 'news', 'links'].map((p) => ({ url: `${W}/${p}.html`, ts: '20190610120000', body: html(p, `<p>${'Our bowls are thrown on the wheel and fired twice. '.repeat(20)}</p>`) })),
  ...[2021, 2022, 2023].map((y) => ({ url: `${W}/`, ts: `${y}0610120000`, body: html('splash.example', '<p>This domain may be for sale. Buy this domain today!</p><a href="/casino-bonus.html">Best casino bonus</a>') })),
  { url: `${W}/casino-bonus.html`, ts: '20220611120000', body: html('Casino bonus', `<p>${'Play slots and poker online casino now. '.repeat(30)}</p>`) },
];

describe('a date picked after the scan found no good month', () => {
  it('still keeps out the months the scan found parked', async () => {
    const archive = await startFakeArchive(SPLASH);
    const out = await mkdtemp(path.join(work, 'r-'));
    try {
      const opts = { domain: 'splash.example', outDir: out, zip: false, archive: { base: archive.base, ...FAST } };
      await assert.rejects(restore(opts), /No capture of splash\.example looks like a real website\. Pass a date with --target/);
      const r = await restore({ ...opts, target: '2019' });
      assert.deepEqual(r.report.window, { from: undefined, to: '20210531235959' });
      assert.equal(r.report.counts.pages, 7);
      await assert.rejects(readFile(path.join(r.siteDir, 'casino-bonus.html')), { code: 'ENOENT' });
      assert.doesNotMatch(await readFile(path.join(r.siteDir, 'sitemap-pages.xml'), 'utf8'), /casino/);
      // A date in the later owner's years is refused, unless the period is given.
      await assert.rejects(restore({ ...opts, target: '2022-07' }), /found splash\.example parked or run by another owner around 2022-07-01\. .*--from and --to/);
    } finally {
      await archive.close();
    }
  });

  it('is bounded the way the scan bounds its last good month', () => {
    const month = (m: string, verdict: MonthHealth['verdict'], reasons: string[] = []): MonthHealth => ({ month: m, captures: 1, timestamp: `${m}15000000`, score: null, verdict, reasons, probed: true });
    const months = [
      month('201001', 'bad', ['parked domain page ("buy this domain")']),
      month('201101', 'weak'),
      month('201201', 'bad', ['hosting or error page ("account suspended")']),
      month('201301', 'weak'),
      month('201401', 'weak'),
      month('201501', 'bad', ['spam words appeared (9), likely a new owner']),
    ];
    // A one-month outage is the site's own; the earlier owner's lander and the later spam are not.
    assert.deepEqual(windowAround(months, '20130601000000'), { from: '20100201000000', to: '20141231235959' });
    assert.deepEqual(windowAround(months, '20090101000000'), { to: '20091231235959' });
    assert.equal(windowAround(months, '20150301000000'), null);
    assert.deepEqual(windowAround([], '20150301000000'), {});
  });

  it('refuses a date anywhere in a parked stretch, and leaves out the months the scan did not check before it', () => {
    const month = (m: string, verdict: MonthHealth['verdict'], reasons: string[], probed = false): MonthHealth => ({ month: m, captures: 1, timestamp: `${m}15000000`, score: null, verdict, reasons, probed });
    const PARKED = ['parked domain page ("this domain may be for sale")'];
    const months = [
      month('201801', 'weak', ['very little text (44 words)'], true),
      month('201802', 'weak', ['estimated from the months around it']),
      month('201803', 'weak', ['very little text (44 words)'], true),
      month('201804', 'weak', ['not checked; near a change']),
      month('201805', 'weak', ['not checked; near a change']),
      month('201806', 'bad', PARKED, true),
      month('201807', 'bad', ['estimated from the months around it']),
      month('201808', 'bad', PARKED, true),
      month('201809', 'bad', ['after the site went down']),
    ];
    // The months between the probes, and after the last one, are the later owner's too.
    for (const t of ['20180601000000', '20180701000000', '20180901000000', '20190101000000']) assert.equal(windowAround(months, t), null, t);
    // The scan never narrowed down where the site turned bad: April and May may be parked already.
    assert.deepEqual(windowAround(months, '20180201000000'), { to: '20180331235959' });
    assert.deepEqual(windowAround(months, '20180501000000'), { to: '20180331235959' });
    // Between two parked stretches, with every month in between unchecked, nothing is left.
    const between = [month('201001', 'bad', PARKED, true), month('201002', 'weak', ['not checked; near a change']), month('201003', 'bad', PARKED, true)];
    assert.deepEqual(windowAround(between, '20100215000000'), { from: '20100201000000', to: '20100131235959' });
  });

  it('keeps the parked years out when most months were estimated, not probed', async () => {
    // A homepage captured every month, each capture a little different (a build date), so the scan
    // probes a few months and estimates the rest.
    const months = (from: number, to: number) => Array.from({ length: (to - from + 1) * 12 }, (_, n) => `${from + Math.floor(n / 12)}${String((n % 12) + 1).padStart(2, '0')}`);
    const stamped = (c: FakeCapture, m: string) => ({ url: c.url, ts: `${m}10120000`, body: String(c.body).replace('</body>', `<!-- ${m} --></body>`) });
    const [splash, parked, casino] = [SPLASH[0], SPLASH.find((c) => c.ts === '20210610120000')!, SPLASH[SPLASH.length - 1]];
    const archive = await startFakeArchive([
      ...months(2015, 2020).map((m) => stamped(splash, m)),
      ...SPLASH.filter((c) => /\/(gallery|about|shop|contact|news|links)\.html$/.test(c.url)),
      ...months(2021, 2023).map((m) => stamped(parked, m)),
      ...['20210211120000', '20220611120000', '20231111120000'].map((ts) => ({ ...casino, ts })),
    ]);
    const out = await mkdtemp(path.join(work, 'r-'));
    try {
      const opts = { domain: 'splash.example', outDir: out, zip: false, archive: { base: archive.base, ...FAST } };
      const events: string[] = [];
      const r = await restore({ ...opts, target: '2019', onEvent: (e) => events.push(e.message) });
      assert.ok(r.report.window.to && r.report.window.to < '20210101', r.report.window.to);
      await assert.rejects(readFile(path.join(r.siteDir, 'casino-bonus.html')), { code: 'ENOENT' });
      assert.doesNotMatch(await readFile(path.join(r.siteDir, 'sitemap-pages.xml'), 'utf8'), /casino/);
      assert.match(await readFile(path.join(r.siteDir, 'index.html'), 'utf8'), /Splash Ceramics/);
      // The log gives the period that was used.
      assert.ok(events.some((m) => m.includes(`pages are taken from the start to ${r.report.window.to!.slice(0, 8)}`)), events.join(' | '));
      for (const target of ['2022', '2022-06', '2023-11']) {
        await assert.rejects(restore({ ...opts, target }), /found splash\.example parked or run by another owner around/, target);
      }
      // A --from after the months the scan can vouch for leaves nothing to restore.
      await assert.rejects(restore({ ...opts, target: '2021-03', from: '2021-01' }), /cannot vouch for splash\.example around 2021-03-01: .* from 2021-01-01 to 20\d\d-\d\d-\d\d\. .*--from and --to/);
    } finally {
      await archive.close();
    }
  });
});

describe('a restore without the health scan', () => {
  const D = 'expired.example';
  const captures: FakeCapture[] = [
    { url: `http://${D}/`, ts: '20140601000000', body: html('Bakery', '<a href="/about.html">About</a>') },
    { url: `http://${D}/about.html`, ts: '20140601000000', body: html('About the bakery') },
    { url: `http://${D}/casino-bonus.html`, ts: '20200101000000', body: html('Casino') },
  ];

  it('needs --to on the command line, and says so before any request', async () => {
    const archive = await startFakeArchive(captures);
    try {
      const out = await mkdtemp(path.join(work, 'c-'));
      const r = await cli('restore', D, '--no-health', '--target', '2014', '--archive', archive.base, '--out', out, '--no-zip');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /--no-health needs --target and --to/);
      assert.deepEqual(archive.requests, []);
      const ok = await cli('restore', D, '--no-health', '--target', '2014', '--to', '2015', '--archive', archive.base, '--delay', '0', '--out', out, '--no-zip');
      assert.equal(ok.code, 0, ok.stderr);
      await assert.rejects(readFile(path.join(out, D, 'site', 'casino-bonus.html')), { code: 'ENOENT' });
    } finally {
      await archive.close();
    }
  });

  it('warns when nothing bounds the window', async () => {
    const archive = await startFakeArchive(captures);
    try {
      const r = await restore({ domain: D, outDir: await mkdtemp(path.join(work, 'r-')), skipHealth: true, target: '2014', zip: false, archive: { base: archive.base, ...FAST } });
      assert.ok(r.report.warnings.some((w) => /^Neither a health scan of the homepage nor a --to date bounded the period, so captures of every date were used/.test(w)), r.report.warnings.join(' | '));
      const bounded = await restore({ domain: D, outDir: await mkdtemp(path.join(work, 'r-')), skipHealth: true, target: '2014', to: '2015', zip: false, archive: { base: archive.base, ...FAST } });
      assert.deepEqual(bounded.report.warnings, []);
    } finally {
      await archive.close();
    }
  });
});

describe('dates', () => {
  it('are checked before the health scan or any archive request', async () => {
    const archive = await startFakeArchive(SPLASH);
    try {
      const outDir = await mkdtemp(path.join(work, 'd-'));
      for (const bad of [{ to: '2019-13' }, { from: 'yesterday' }, { target: '2019-02-30' }]) {
        await assert.rejects(restore({ domain: 'splash.example', outDir, ...bad, archive: { base: archive.base, ...FAST } }), /Not a date or Wayback timestamp/, JSON.stringify(bad));
      }
      await assert.rejects(restore({ domain: 'splash.example', outDir, from: '2020', to: '2019-06', archive: { base: archive.base, ...FAST } }), /The --from date 2020 is after the --to date 2019-06/);
      assert.deepEqual(archive.requests, []);
      const r = await cli('restore', 'splash.example', '--target', '2019-02-30', '--archive', archive.base, '--out', outDir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /Not a date or Wayback timestamp: 2019-02-30/);
      assert.deepEqual(archive.requests, []);
    } finally {
      await archive.close();
    }
  });
});

describe('running the same restore again', () => {
  it('continues the earlier snapshot when a new scan picks another good month', async () => {
    const D = 'resumer.example';
    const N = 12;
    const text = 'Fresh sourdough, rye and spelt loaves baked every morning in our wood-fired oven since 1987. '.repeat(30);
    const home = (y: string) => `<html><head><title>Resumer Bakery</title></head><body><nav>${Array.from({ length: N }, (_, i) => `<a href="/p${i}.html">Page ${i}</a>`).join(' ')}</nav><main><h1>Resumer Bakery</h1><p>${text}</p><p>Updated ${y}</p></main></body></html>`;
    const captures: FakeCapture[] = [];
    for (let y = 2014; y <= 2018; y++) for (const mo of ['02', '05', '08', '11']) captures.push({ url: `http://${D}/`, ts: `${y}${mo}10000000`, body: home(`${y}${mo}`) });
    for (let i = 0; i < N; i++) captures.push({ url: `http://${D}/p${i}.html`, ts: '20180810000000', body: html(`Page ${i}`, `<p>${text}</p>`) });
    const out = await mkdtemp(path.join(work, 'resume-'));
    const pages = (requests: string[]) => requests.filter((u) => /id_\/http:\/\/resumer\.example\/p\d+\.html$/.test(u));

    // Run 1: archive.org starts refusing downloads half way.
    const first = await startFakeArchive(captures);
    let r1;
    try {
      r1 = await restore({ domain: D, outDir: out, zip: false, archive: { base: first.base, ...FAST }, onEvent: (e) => e.phase === 'download' && e.done === 6 && first.failNext(503, 1e9) });
    } finally {
      await first.close();
    }
    assert.equal(r1.report.target, '20181110000000');
    const manifest = JSON.parse(await readFile(path.join(out, D, '.work', 'manifest.json'), 'utf8')) as Manifest;
    const saved = manifest.resources.filter((r) => /^\/p\d+\.html$/.test(r.path)).length;
    assert.ok(r1.report.counts.refused! > 0 && saved > 0, JSON.stringify(r1.report.counts));

    // Run 2: the archive now lists one more good homepage capture, so the scan picks that month.
    const second = await startFakeArchive([...captures, { url: `http://${D}/`, ts: '20190210000000', body: home('201902') }]);
    try {
      const messages: string[] = [];
      const r2 = await restore({ domain: D, outDir: out, zip: false, archive: { base: second.base, ...FAST }, onEvent: (e) => messages.push(e.message) });
      assert.ok(messages.includes('last good snapshot: 20190210000000 (score 100)'), messages.join('\n'));
      assert.equal(r2.report.target, '20181110000000');
      assert.ok(messages.some((m) => m.startsWith('resuming: ')), messages.join('\n'));
      assert.equal(pages(second.requests).length, N - saved);
      assert.equal(r2.report.counts.pages, N + 1);
    } finally {
      await second.close();
    }
  });
});

describe('the report', () => {
  const manifest: Manifest = {
    version: 1,
    domain: 'example.com',
    target: '20200101000000',
    window: {},
    indexSize: 3,
    truncated: false,
    resources: [],
    missing: [
      { key: 'example.com/gone', url: 'http://example.com/gone', reason: 'HTTP 404' },
      { key: 'example.com/busy', url: 'http://example.com/busy', reason: 'HTTP 503', transient: true },
      { key: 'example.com/slow', url: 'http://example.com/slow', reason: 'fetch failed', transient: true },
    ],
  };
  const build: BuildResult = { siteName: 'Example', pages: [], routes: [], redirects: [], types: [], files: 0, bytes: 0, warnings: [], cleaned: { wayback: 0, trackers: 0 } };

  it('counts URLs archive.org refused apart from those not in the archive', () => {
    const r = makeReport({ manifest, build, siteUrl: 'https://example.com', startedAt: Date.now(), archiveRequests: 0, warnings: [] });
    assert.equal(r.counts.missing, 1);
    assert.equal(r.counts.refused, 2);
    const page = reportHtml(r);
    assert.match(page, /<b>1<\/b>not in the archive/);
    assert.match(page, /<b>2<\/b>refused by archive\.org/);
    assert.match(page, /<h2>Not restored<\/h2>/);
    assert.doesNotMatch(reportHtml(makeReport({ manifest: { ...manifest, missing: manifest.missing.slice(0, 1) }, build, siteUrl: 'https://example.com', startedAt: Date.now(), archiveRequests: 0, warnings: [] })), /refused by archive\.org/);
  });

  it('and so does the command line', async () => {
    const D = 'busy.example';
    const archive = await startFakeArchive([
      { url: `http://${D}/`, ts: '20200101000000', body: html('Home', '<a href="/a.html">a</a> <a href="/b.html">b</a> <a href="/gone.html">gone</a>') },
      { url: `http://${D}/a.html`, ts: '20200101000000', body: html('A') },
      { url: `http://${D}/b.html`, ts: '20200101000000', body: html('B') },
    ]);
    // archive.org refuses /b.html every time.
    const proxy = http.createServer((req, res) => {
      if (/id_\/http:\/\/busy\.example\/b\.html$/.test(req.url!)) {
        res.writeHead(503, { 'retry-after': '0' });
        res.end('busy');
        return;
      }
      http.get(archive.base + req.url, (r) => {
        res.writeHead(r.statusCode!, r.headers);
        r.pipe(res);
      });
    });
    await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
    try {
      const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const r = await cli('restore', D, '--no-health', '--target', '2020', '--to', '2020', '--archive', base, '--delay', '0', '--out', await mkdtemp(path.join(work, 'c-')), '--no-zip');
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /2 pages \(0 posts\), \d+ files, 0 original redirects, 1 not in the archive, 1 refused by archive\.org \(run again to fetch\)/);
    } finally {
      proxy.close();
      await archive.close();
    }
  });

  it('notes Cloudflare Pages\' rule limits once', async () => {
    const D = 'php.example';
    const archive = await startFakeArchive([
      { url: `http://${D}/`, ts: '20200101000000', body: html('Home', Array.from({ length: 120 }, (_, i) => `<a href="/p${i}.php">p${i}</a>`).join(' ')) },
      ...Array.from({ length: 120 }, (_, i) => ({ url: `http://${D}/p${i}.php`, ts: '20200101000000', body: html(`P${i}`) })),
    ]);
    try {
      const r = await restore({ domain: D, outDir: await mkdtemp(path.join(work, 'r-')), skipHealth: true, target: '2020', to: '2020', zip: false, archive: { base: archive.base, ...FAST } });
      assert.equal(r.report.warnings.filter((w) => /Cloudflare Pages reads/.test(w)).length, 1, r.report.warnings.join('\n'));
    } finally {
      await archive.close();
    }
    // Without the limits note, the look-alike one stays.
    const talk = Array.from({ length: 101 }, (_, i) => `/wiki/Talk:P${i}.html  /x  200`).join('\n');
    const notes = hostingNotes(talk, '', { limits: false });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^101 original URLs have ":" or "\*" in their path/);
  });
});
