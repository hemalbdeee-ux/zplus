// What the user is told: a scan archive.org refused to play back is not "no real website", the
// report says which hosts cannot serve every URL of this site, and requests say who is asking.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import type { BuildResult } from '../src/engine/build.ts';
import type { Manifest } from '../src/engine/crawl.ts';
import { hostingNotes, makeReport, reportHtml } from '../src/engine/report.ts';
import { restore } from '../src/engine/restore.ts';
import { startFakeArchive } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5, retries: 1 };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

describe('archive.org refusing playback during the scan', () => {
  it('says so instead of "no capture looks like a real website"', async () => {
    const archive = await startFakeArchive(OLD_BAKERY);
    const out = await mkdtemp(path.join(os.tmpdir(), 'zp-msg-'));
    try {
      archive.failNext(429, 100_000);
      await assert.rejects(restore({ domain: 'oldbakery.example', outDir: out, zip: false, archive: { base: archive.base, ...FAST } }), (err: Error) => {
        assert.match(err.message, /archive\.org refused or failed every request to play back oldbakery\.example's captures \(HTTP 429\)/);
        assert.doesNotMatch(err.message, /real website/);
        return true;
      });
      const r = await cli('scan', 'oldbakery.example', '--archive', archive.base, '--delay', '0');
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /archive\.org refused or failed every request to play back/);
    } finally {
      archive.failNext(429, 0);
      await archive.close();
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe('report hosting notes', () => {
  const lines = (n: number, from: (i: number) => string) => Array.from({ length: n }, (_, i) => `${from(i)}  /x  200`).join('\n');

  it('warns only when Cloudflare Pages would drop rules', () => {
    const small = `# Generated\n\n${lines(10, (i) => `/a${i}.html`)}\n/index.html  /  200\n/*/index.html  /:splat/  200\n/*.html  /:splat  200\n`;
    assert.deepEqual(hostingNotes(small, '/__wbd/*\n  X-Robots-Tag: noindex\n'), []);
    const plain = hostingNotes(lines(2001, (i) => `/p${i}`), '');
    assert.equal(plain.length, 1);
    assert.match(plain[0], /needs 2001, 0 and 0/);
    // Every line after the first pattern counts as a pattern.
    const patterns = hostingNotes(`${lines(100, (i) => `/wiki/Talk:P${i}.html`)}\n/plain-after  /x  200\n`, '');
    assert.match(patterns[0], /needs 0, 101 and 0/);
    // Under the limit, but each of those rules also matches the other Talk: pages on Pages.
    const talk = hostingNotes(`${lines(98, (i) => `/wiki/Talk:P${i}.html`)}\n/*.html  /:splat  200\n`, '');
    assert.deepEqual(talk.length, 1);
    assert.match(talk[0], /^98 original URLs have ":" or "\*" in their path, which Cloudflare Pages reads as a pattern/);
    const headers = hostingNotes('', Array.from({ length: 101 }, (_, i) => `/p${i}.php\n  Content-Type: text/html`).join('\n'));
    assert.match(headers[0], /needs 0, 0 and 101/);
  });

  it('names query-string URLs and tells a refusal from a gap in the archive', () => {
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
      ],
    };
    const build: BuildResult = {
      siteName: 'Example',
      pages: [],
      routes: [
        { path: '/index.php', rawPath: '/index.php', query: 'page=contact', file: '__wbd/q/1.html' },
        { path: '/img', rawPath: '/img', file: '__wbd/f/2.png' },
      ],
      redirects: [{ path: '/old.php', rawPath: '/old.php', query: 'id=1', to: '/new/', status: 301 }],
      types: [],
      files: 0,
      bytes: 0,
      warnings: [],
      cleaned: { wayback: 0, trackers: 0 },
    };
    const r = makeReport({ manifest, build, siteUrl: 'https://example.com', startedAt: Date.now(), archiveRequests: 0, warnings: [] });
    assert.ok(r.warnings.some((w) => /^2 original URLs have a query string: .*Netlify and Cloudflare Pages cannot/.test(w)), r.warnings.join(' | '));
    assert.equal(r.missing[0].reason, 'HTTP 404');
    assert.match(r.missing[1].reason, /archive\.org did not answer \(HTTP 503\); run the restore again/);
    assert.match(reportHtml(r), /Cloudflare Pages reads at most 2000 plain and 100 pattern rules/);
  });
});

describe('archive requests', () => {
  it('say who is asking', async () => {
    const agents: string[] = [];
    const server = http.createServer((req, res) => {
      agents.push(req.headers['user-agent'] ?? '');
      res.writeHead(200, { 'content-type': 'text/plain', 'memento-datetime': 'Wed, 01 Jan 2020 00:00:00 GMT' });
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const client = new ArchiveClient({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...FAST });
      await client.fetchCapture('20200101000000', 'http://example.com/');
      assert.deepEqual(agents, ['zplus/0.1 (+https://zplus.ai)']);
    } finally {
      server.close();
    }
  });
});
