// Crawl robustness: progress saved from several workers at once, resumes that are interrupted
// again, and an archive that refuses every download.

import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { buildIndex, crawl, type CrawlOptions, type Manifest } from '../src/engine/crawl.ts';
import { scanHealth } from '../src/engine/health.ts';
import { restore } from '../src/engine/restore.ts';
import { startFakeArchive, type FakeArchive, type FakeCapture } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };
const D = 'http://www.racesite.example';
const TS = '20200101000000';

/** A homepage linking `linked` pages (and `dead` links nobody archived), plus `orphans` unlinked pages. */
function site(linked: number, orphans = 0, dead = 0): FakeCapture[] {
  const links = [
    ...Array.from({ length: linked }, (_, i) => `<a href="/p${i}.html">p${i}</a>`),
    ...Array.from({ length: dead }, (_, i) => `<a href="/gone${i}.html">gone</a>`),
  ];
  return [
    { url: `${D}/`, ts: TS, body: `<html><body>${links.join('\n')}</body></html>` },
    ...Array.from({ length: linked }, (_, i) => ({ url: `${D}/p${i}.html`, ts: TS, body: `<html><body>page ${i}</body></html>` })),
    ...Array.from({ length: orphans }, (_, i) => ({ url: `${D}/orphan${i}.html`, ts: TS, body: `<html><body>orphan ${i}</body></html>` })),
  ];
}

const playback = (archive: FakeArchive) => archive.requests.filter((r) => r.startsWith('/web/')).length;

describe('crawl progress and resume', () => {
  let work: string;
  before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'wbd-crawl-'));
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('saves progress from several workers at once, on a fresh run and on every resume', async () => {
    const archive = await startFakeArchive(site(160));
    try {
      const client = new ArchiveClient({ base: archive.base, ...FAST });
      const opts: CrawlOptions = { domain: 'racesite.example', target: TS, window: {}, workDir: path.join(work, 'race'), maxUrls: 1000, orphans: true, workers: 3 };
      const index = await buildIndex(client, opts);
      const first = await crawl(client, index, opts);
      assert.equal(first.resources.length, 161);
      for (let run = 0; run < 3; run++) {
        const before = playback(archive);
        const again = await crawl(client, index, opts);
        assert.equal(again.resources.length, 161, `resume ${run}`);
        assert.equal(playback(archive) - before, 0, `resume ${run} downloaded again`);
      }
      const left = (await readdir(opts.workDir)).filter((f) => f.endsWith('.tmp'));
      assert.deepEqual(left, []);
    } finally {
      await archive.close();
    }
  });

  it('keeps the earlier downloads when a resume is interrupted again', async () => {
    const archive = await startFakeArchive(site(0, 100, 60));
    try {
      const opts: CrawlOptions = { domain: 'racesite.example', target: TS, window: {}, workDir: path.join(work, 'twice'), maxUrls: 1000, orphans: true, workers: 1 };
      const client = new ArchiveClient({ base: archive.base, ...FAST });
      const index = await buildIndex(client, opts);
      const first = await crawl(client, index, opts);
      assert.equal(first.resources.length, 101);
      assert.equal(first.missing.length, 60);

      // The resume refetches the 60 dead links first and is stopped after 50 of them, past the
      // first periodic save.
      const ac = new AbortController();
      const stopping = new ArchiveClient({ base: archive.base, ...FAST, signal: ac.signal });
      let calls = 0;
      const fetchCapture = stopping.fetchCapture.bind(stopping);
      stopping.fetchCapture = (ts, url) => {
        if (++calls === 57) ac.abort();
        return fetchCapture(ts, url);
      };
      await assert.rejects(crawl(stopping, index, opts), { name: 'AbortError' });
      const onDisk = JSON.parse(await readFile(path.join(opts.workDir, 'manifest.json'), 'utf8')) as Manifest;
      assert.equal(new Set(onDisk.resources.map((r) => r.key)).size, 101);

      const before = archive.requests.length;
      const third = await crawl(client, index, opts);
      assert.equal(third.resources.length, 101);
      const refetched = archive.requests.slice(before).filter((r) => r.includes('/orphan'));
      assert.deepEqual(refetched, []);
    } finally {
      await archive.close();
    }
  });

  it('stops every worker when archive.org refuses every download', async () => {
    const archive = await startFakeArchive(site(0, 60));
    try {
      const client = new ArchiveClient({ base: archive.base, ...FAST, retries: 1 });
      const opts: CrawlOptions = { domain: 'racesite.example', target: TS, window: {}, workDir: path.join(work, 'refused'), maxUrls: 1000, orphans: true, workers: 3 };
      const index = await buildIndex(client, opts);
      archive.failNext(429, 1e9);
      await assert.rejects(crawl(client, index, opts), /archive\.org refused or failed the last \d+ downloads/);
      const atReject = archive.requests.length;
      // Far fewer than the 61 URLs times 2 attempts, and nothing keeps downloading afterwards.
      assert.ok(atReject < 61, `${atReject} requests`);
      await sleep(300);
      assert.equal(archive.requests.length, atReject);
    } finally {
      await archive.close();
    }
  });
});

describe('restore refuses to ship an empty site', () => {
  let archive: FakeArchive;
  let out: string;
  before(async () => {
    archive = await startFakeArchive(OLD_BAKERY);
    out = await mkdtemp(path.join(os.tmpdir(), 'wbd-'));
  });
  after(async () => {
    await archive.close();
    await rm(out, { recursive: true, force: true });
  });

  it('fails with a clear message when every playback request is refused', async () => {
    const health = await scanHealth(new ArchiveClient({ base: archive.base, ...FAST }), 'oldbakery.example');
    archive.failNext(503, 1e9);
    try {
      await assert.rejects(
        restore({ domain: 'oldbakery.example', outDir: out, health, zip: false, archive: { base: archive.base, ...FAST, retries: 1 } }),
        /archive\.org refused or failed/,
      );
    } finally {
      archive.failNext(503, 0);
    }
  });

  it('fails when the chosen period has no captures at all', async () => {
    await assert.rejects(
      restore({ domain: 'oldbakery.example', outDir: out, skipHealth: true, target: '2010', from: '2010', to: '2011', zip: false, archive: { base: archive.base, ...FAST } }),
      /no captures of oldbakery\.example between 20100101 and 20111231/,
    );
  });
});
