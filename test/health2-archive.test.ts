// Round-2 health cases about the archive itself: the homepage index of a busy site is read one
// capture a day, and a scan whose playback archive.org refuses says so instead of calling the
// domain a site that never was.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ArchiveClient, type Capture, type CaptureResult, type CdxQuery } from '../src/engine/archive.ts';
import { scanHealth } from '../src/engine/health.ts';
import { restore } from '../src/engine/restore.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 1, retries: 1 };

function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(4)); `${y}${String(m).padStart(2, '0')}` <= to; m === 12 ? (y++, (m = 1)) : m++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
  }
  return out;
}

const links = (n: number) => Array.from({ length: n }, (_, i) => `<a href="/p${i}.html">p${i}</a>`).join(' ');
const words = (n: number) => Array.from({ length: n }, (_, i) => `bread${i % 40}`).join(' ');
const GOOD = `<html lang="en"><head><title>Bakery</title></head><body>${links(8)}<p>${words(300)}</p></body></html>`;
const PARKED = '<html><body><h1>parked</h1><p>This domain may be for sale!</p></body></html>';
const site = (): FakeCapture[] => monthRange('201001', '202112').map((m) => ({ url: 'http://example.com/', ts: `${m}10120000`, body: m < '202001' ? GOOD : PARKED }));

describe('health2: the homepage index of a busy site', () => {
  it('asks the archive for one capture a day', async () => {
    const archive = await startFakeArchive(site());
    try {
      await scanHealth(new ArchiveClient({ base: archive.base, ...FAST }), 'example.com');
      const cdx = archive.requests.filter((r) => r.startsWith('/cdx/'));
      assert.equal(cdx.length, 1);
      assert.equal(new URL(cdx[0], 'http://archive.local').searchParams.get('collapse'), 'timestamp:8');
    } finally {
      await archive.close();
    }
  });

  it('keeps one capture a day when the index sends more, preferring the content capture', async () => {
    // Hundreds of captures a day, as a news site's homepage has: an http -> https redirect first, then pages.
    const rows: Capture[] = [];
    for (const m of monthRange('201001', '202112')) {
      for (let day = 1; day <= 28; day++) {
        for (let n = 0; n < 50; n++) {
          const ts = `${m}${String(day).padStart(2, '0')}${String(Math.floor(n / 4)).padStart(2, '0')}${String((n % 4) * 10).padStart(2, '0')}00`;
          const redirect = n === 0;
          rows.push({ urlkey: 'com,example)/', timestamp: ts, original: redirect ? 'http://example.com/' : 'https://example.com/', mimetype: 'text/html', statuscode: redirect ? '301' : '200', digest: m < '202001' ? 'GOOD' : 'PARKED', length: 3000 });
        }
      }
    }
    let asked: CdxQuery | undefined;
    const client = {
      async *cdx(q: CdxQuery) {
        asked = q;
        for (let i = 0; i < rows.length; i += 25_000) yield rows.slice(i, i + 25_000);
      },
      async fetchCapture(timestamp: string, original: string): Promise<CaptureResult> {
        return { kind: 'ok', timestamp, original, status: 200, contentType: 'text/html', body: Buffer.from(timestamp < '202001' ? GOOD : PARKED) };
      },
    } as unknown as ArchiveClient;
    const h = await scanHealth(client, 'example.com');
    assert.deepEqual(asked?.collapse, ['timestamp:8']);
    assert.equal(h.lastGood?.month, '201912');
    assert.equal(h.window.to, '20191231235959');
    // One capture for each of the 28 days, and the day's page rather than its redirect.
    assert.ok(h.months.every((m) => m.captures === 28), String(h.months[0].captures));
    assert.ok(h.months.every((m) => m.statuscode === '200'));
  });
});

describe('health2: archive.org refuses playback', () => {
  it('says so when it refuses every probe, after three', async () => {
    const archive = await startFakeArchive(site());
    try {
      archive.failNext(429, 1_000);
      await assert.rejects(scanHealth(new ArchiveClient({ base: archive.base, ...FAST }), 'example.com'), /archive\.org refused or failed 3 of the 3 .*\(HTTP 429\).*Try again later/);
      // Three probes of two tries each, and nothing more.
      assert.equal(archive.requests.filter((r) => r.startsWith('/web/')).length, 6);
    } finally {
      await archive.close();
    }
  });

  it('takes a request that fails after every retry for a refusal too', async () => {
    const archive = await startFakeArchive(site());
    try {
      const client = new (class extends ArchiveClient {
        async fetchCapture(): Promise<CaptureResult> {
          throw new TypeError('fetch failed');
        }
      })({ base: archive.base, ...FAST });
      await assert.rejects(scanHealth(client, 'example.com'), /archive\.org refused or failed 3 of the 3 .*\(fetch failed\)/);
    } finally {
      await archive.close();
    }
  });

  it('stops at once when the scan is cancelled', async () => {
    const archive = await startFakeArchive(site());
    const cancel = new AbortController();
    try {
      const client = new (class extends ArchiveClient {
        async fetchCapture(timestamp: string, original: string): Promise<CaptureResult> {
          cancel.abort();
          return super.fetchCapture(timestamp, original);
        }
      })({ base: archive.base, ...FAST, signal: cancel.signal });
      await assert.rejects(scanHealth(client, 'example.com'), (err: Error) => err.name === 'AbortError');
    } finally {
      await archive.close();
    }
  });

  it('stops a restore with that message instead of "no capture looks like a real website"', async () => {
    const archive = await startFakeArchive(site());
    const out = await mkdtemp(path.join(os.tmpdir(), 'wbd-'));
    try {
      archive.failNext(503, 1_000);
      await assert.rejects(restore({ domain: 'example.com', outDir: out, zip: false, archive: { base: archive.base, ...FAST } }), /archive\.org refused or failed .*Try again later/);
    } finally {
      await archive.close();
      await rm(out, { recursive: true, force: true });
    }
  });

  it('still reports the snapshot when only some probes are refused', async () => {
    const archive = await startFakeArchive(site());
    try {
      const client = new (class extends ArchiveClient {
        async fetchCapture(timestamp: string, original: string): Promise<CaptureResult> {
          // Every capture before 2014 is refused: four of the spread probes.
          if (timestamp < '2014') return { kind: 'missing', status: 503, reason: 'HTTP 503', transient: true };
          return super.fetchCapture(timestamp, original);
        }
      })({ base: archive.base, ...FAST });
      const h = await scanHealth(client, 'example.com');
      assert.equal(h.lastGood?.month, '201912');
      assert.equal(h.window.to, '20191231235959');
    } finally {
      await archive.close();
    }
  });

  it('keeps "no real website" for a parked domain with a refusal or two', async () => {
    const archive = await startFakeArchive(monthRange('201001', '202112').map((m) => ({ url: 'http://example.com/', ts: `${m}10120000`, body: PARKED.replace('parked', `parked ${m}`) })));
    try {
      archive.failNext(503, 2);
      const h = await scanHealth(new ArchiveClient({ base: archive.base, minIntervalMs: 0, backoffMs: 1, retries: 0 }), 'example.com');
      assert.equal(h.lastGood, undefined);
      assert.ok(h.months.some((m) => m.probed && m.verdict === 'bad'));
    } finally {
      await archive.close();
    }
  });
});
