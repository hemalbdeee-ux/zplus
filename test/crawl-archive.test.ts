// The archive client, the CLI options, the site address and the report: archived error pages,
// bodies over the size limit, mistyped numbers, and the outlined snapshot month.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import type { HealthReport, MonthHealth } from '../src/engine/health.ts';
import { reportHtml, type RestoreReport } from '../src/engine/report.ts';
import { normalizeSiteUrl, restore } from '../src/engine/restore.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('archive client', () => {
  it('takes an archived 429 or 503 page as the answer: no retries, no pause', async () => {
    const E = 'http://www.errsite.example';
    const caps: FakeCapture[] = [
      { url: `${E}/blocked`, ts: '20200101000000', status: 429, body: 'Too Many Requests' },
      { url: `${E}/maint`, ts: '20200101000000', status: 503, body: 'Down for maintenance' },
    ];
    const archive = await startFakeArchive(caps);
    try {
      const logs: string[] = [];
      const client = new ArchiveClient({ base: archive.base, minIntervalMs: 0, backoffMs: 200, log: (m) => logs.push(m) });
      for (const p of ['/blocked', '/maint']) {
        const started = Date.now();
        const res = await client.fetchCapture('20200601000000', `${E}${p}`);
        assert.equal(res.kind, 'missing');
        assert.match(res.kind === 'missing' ? res.reason : '', /^archived as HTTP (429|503)$/);
        assert.ok(res.kind === 'missing' && !res.transient);
        assert.ok(Date.now() - started < 150, `${p} took ${Date.now() - started} ms`);
      }
      // One nearest-capture hop and one replay per URL.
      assert.equal(archive.requests.length, 4);
      assert.deepEqual(logs, []);
    } finally {
      await archive.close();
    }
  });

  it('still retries the archive itself when it answers 429', async () => {
    const archive = await startFakeArchive(OLD_BAKERY);
    try {
      const client = new ArchiveClient({ base: archive.base, ...FAST });
      archive.failNext(429, 2);
      assert.equal((await client.fetchCapture('20201114083015', 'http://www.oldbakery.example/')).kind, 'ok');
      archive.failNext(503, 100);
      const res = await client.fetchCapture('20201114083015', 'http://www.oldbakery.example/');
      assert.ok(res.kind === 'missing' && res.transient, JSON.stringify(res));
      archive.failNext(503, 0);
    } finally {
      await archive.close();
    }
  });

  it('enforces maxBytes on chunked and gzipped bodies', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 'a');
    const server = http.createServer((req, res) => {
      const memento = { 'content-type': 'text/plain', 'memento-datetime': 'Wed, 01 Jan 2020 00:00:00 GMT' };
      if (req.url!.endsWith('/chunked')) {
        res.writeHead(200, memento);
        for (let i = 0; i < 3; i++) res.write(big.subarray(i * 1024 * 1024, (i + 1) * 1024 * 1024));
        res.end();
      } else if (req.url!.endsWith('/gzip')) {
        const gz = gzipSync(big);
        res.writeHead(200, { ...memento, 'content-encoding': 'gzip', 'content-length': String(gz.length) });
        res.end(gz);
      } else {
        res.writeHead(200, memento);
        res.end('small');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const client = new ArchiveClient({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...FAST, maxBytes: 1024 * 1024 });
      for (const p of ['chunked', 'gzip']) {
        const res = await client.fetchCapture('20200101000000', `http://big.example/${p}`);
        assert.deepEqual(res.kind === 'missing' && [res.status, res.reason], [413, 'file too large'], p);
      }
      const small = await client.fetchCapture('20200101000000', 'http://big.example/small');
      assert.equal(small.kind === 'ok' && small.body.toString(), 'small');
    } finally {
      server.close();
    }
  });

  it('falls back to the defaults for options that are not numbers', () => {
    const c = new ArchiveClient({ concurrency: Number('three'), minIntervalMs: Number('1s'), retries: NaN, maxBytes: NaN });
    assert.equal(c.concurrency, 3);
    assert.equal(c.minIntervalMs, 350);
    assert.equal(c.retries, 5);
    assert.equal(c.maxBytes, 50 * 1024 * 1024);
  });
});

describe('cli options', () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/cli.ts'), ...args], { encoding: 'utf8', timeout: 20_000 });

  it('rejects numbers that are not numbers before doing anything', () => {
    for (const [flag, value] of [
      ['--concurrency', 'three'],
      ['--max-urls', '5k'],
      ['--delay', '1s'],
      ['--concurrency', '0'],
    ]) {
      // The archive address is unreachable: a bad option has to fail before any request.
      const r = cli('restore', 'example.com', '--archive', 'http://127.0.0.1:9', flag, value);
      assert.equal(r.status, 1, `${flag} ${value}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${flag} needs a whole number`), r.stderr);
    }
  });
});

describe('site address', () => {
  it('accepts a bare host and refuses what is not an http(s) address', () => {
    assert.equal(normalizeSiteUrl('www.example.com'), 'https://www.example.com');
    assert.equal(normalizeSiteUrl(' http://Example.com/blog/ '), 'http://example.com/blog');
    assert.throws(() => normalizeSiteUrl('ftp://example.com'), /Not a valid site address/);
    assert.throws(() => normalizeSiteUrl('exa mple'), /Not a valid site address/);
    assert.throws(() => normalizeSiteUrl('https://example.com/?x=1'), /Not a valid site address/);
  });

  it('checks --site-url before contacting the archive', async () => {
    const archive = await startFakeArchive(OLD_BAKERY);
    const out = await mkdtemp(path.join(os.tmpdir(), 'wbd-'));
    try {
      await assert.rejects(restore({ domain: 'oldbakery.example', outDir: out, siteUrl: 'ftp://www.oldbakery.example', archive: { base: archive.base, ...FAST } }), /Not a valid site address/);
      assert.equal(archive.requests.length, 0);
      const r = await restore({ domain: 'oldbakery.example', outDir: out, siteUrl: 'www.oldbakery.example', skipHealth: true, target: '20201114083015', zip: false, archive: { base: archive.base, ...FAST } });
      assert.equal(r.report.siteUrl, 'https://www.oldbakery.example');
      assert.match(await readFile(path.join(r.siteDir, 'about.php'), 'utf8'), /<link rel="canonical" href="https:\/\/www\.oldbakery\.example\/about\.php">/);
    } finally {
      await archive.close();
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe('report timeline', () => {
  const month = (m: string, verdict: MonthHealth['verdict']): MonthHealth => ({ month: m, captures: 1, timestamp: `${m}15000000`, score: verdict === 'good' ? 90 : 5, verdict, reasons: [], probed: true });
  const report = (health: HealthReport, target: string) =>
    ({
      domain: 'example.com',
      siteUrl: 'https://example.com',
      target,
      window: {},
      generatedAt: '',
      durationSeconds: 0,
      archiveRequests: 0,
      health,
      counts: { indexUrls: 0, pages: 0, posts: 0, files: 0, bytes: 0, rewrites: 0, redirects: 0, missing: 0, trackersRemoved: 0 },
      truncated: false,
      missing: [],
      redirects: [],
      warnings: [],
    }) satisfies RestoreReport;
  const picks = (html: string) => [...html.matchAll(/<td class="[a-z]+ pick" title="([^"]*)"/g)].map((m) => m[1].slice(0, 7));

  it('outlines the month that was restored', () => {
    const noGood: HealthReport = { domain: 'example.com', months: [month('201803', 'bad'), month('201911', 'bad')], window: {}, host: 'example.com', probes: 2 };
    assert.deepEqual(picks(reportHtml(report(noGood, '20180315000000'))), ['2018-03']);
    const good: HealthReport = { ...noGood, months: [month('201803', 'good'), month('201911', 'good')], lastGood: { month: '201911', timestamp: '20191115000000', score: 90, original: 'http://example.com/' } };
    assert.deepEqual(picks(reportHtml(report(good, '20180315000000'))), ['2018-03']);
    assert.deepEqual(picks(reportHtml(report(good, '20191115000000'))), ['2019-11']);
  });
});
