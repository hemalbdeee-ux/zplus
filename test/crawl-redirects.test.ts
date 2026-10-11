// Redirects the archive does not replay. Wayback files /About.html and /about.html (or /page/ and
// /page) under one key and skips a 3xx that points inside its own key, so a redirect the site made
// that only changes case or a trailing slash never comes back as a redirect. It still has to be
// restored as one, wherever the archive's replay landed.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { buildIndex, crawl, type CrawlOptions } from '../src/engine/crawl.ts';
import { restore } from '../src/engine/restore.ts';
import { createPreviewServer } from '../src/engine/serve.ts';
import { startFakeArchive, type FakeArchiveOptions, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };
const html = (body: string) => `<html><head><title>T</title></head><body>${body}</body></html>`;
const PARKED = html('This domain may be for sale');
const D = 'twins.example';
const S = `http://${D}`;
const target = '20210215000000';
const window = { to: '20210228235959' };

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'wbd-twins-'));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

async function run(captures: FakeCapture[], fake: FakeArchiveOptions = {}) {
  const archive = await startFakeArchive(captures, fake);
  try {
    const client = new ArchiveClient({ base: archive.base, ...FAST });
    const opts: CrawlOptions = { domain: D, target, window, workDir: await mkdtemp(path.join(work, 'w-')), maxUrls: 100, orphans: true, workers: 1 };
    const manifest = await crawl(client, await buildIndex(client, opts), opts);
    const get = (p: string) => manifest.resources.find((r) => r.path === p);
    return { manifest, get };
  } finally {
    await archive.close();
  }
}

describe('a redirect inside one archive key', () => {
  for (const parked of [false, true]) {
    it(`keeps a case-only 301${parked ? ' when replay lands on the parked domain' : ''}`, async () => {
      const caps: FakeCapture[] = [
        { url: `${S}/`, ts: '20210201000000', body: html('<a href="/About.html">About</a>') },
        { url: `${S}/about.html`, ts: '20200601000000', body: html('REAL about page') },
        { url: `${S}/About.html`, ts: '20210210000000', status: 301, location: `${S}/about.html` },
      ];
      if (parked) caps.push({ url: `${S}/about.html`, ts: '20210305000000', body: PARKED });
      const { manifest, get } = await run(caps);
      assert.deepEqual([get('/About.html')?.status, get('/About.html')?.location], [301, `${S}/about.html`]);
      assert.equal(get('/about.html')?.status, 200);
      assert.deepEqual(manifest.missing, []);
    });
  }

  it('keeps a trailing-slash 301 when replay lands on the parked domain', async () => {
    const caps: FakeCapture[] = [
      { url: `${S}/`, ts: '20210201000000', body: html('<a href="/page/">page</a>') },
      { url: `${S}/page`, ts: '20200601000000', body: html('REAL page') },
      { url: `${S}/page/`, ts: '20210210000000', status: 301, location: `${S}/page` },
      { url: `${S}/page`, ts: '20210305000000', body: PARKED },
    ];
    const { get } = await run(caps, { stripTrailingSlash: true });
    assert.deepEqual([get('/page/')?.status, get('/page/')?.location], [301, `${S}/page`]);
    assert.equal(get('/page')?.status, 200);
  });

  it('keeps it when replay lands on a parked capture of the same spelling', async () => {
    // After the domain expired, the parking page answered every URL, /About.html included.
    const caps: FakeCapture[] = [
      { url: `${S}/`, ts: '20210201000000', body: html('<a href="/About.html">About</a>') },
      { url: `${S}/about.html`, ts: '20200601000000', body: html('REAL about page') },
      { url: `${S}/About.html`, ts: '20210210000000', status: 301, location: `${S}/about.html` },
      { url: `${S}/About.html`, ts: '20210305000000', body: PARKED },
    ];
    const { get } = await run(caps);
    assert.deepEqual([get('/About.html')?.status, get('/About.html')?.location], [301, `${S}/about.html`]);
    assert.equal(get('/about.html')?.status, 200);
  });

  it('serves a switch to https captured in the same second as the page', async () => {
    const caps: FakeCapture[] = [
      { url: `${S}/`, ts: '20210201000000', body: html('<a href="/p">p</a>') },
      { url: `${S}/p`, ts: '20210210000000', status: 301, location: `https://${D}/p` },
      { url: `https://${D}/p`, ts: '20210210000000', body: html('REAL p') },
    ];
    const { manifest, get } = await run(caps);
    assert.equal(get('/p')?.status, 200);
    assert.deepEqual(manifest.missing, []);
  });

  it('answers both spellings on the restored site', async () => {
    const caps: FakeCapture[] = [
      { url: `${S}/`, ts: '20210201000000', body: html('<a href="/About.html">About</a>') },
      { url: `${S}/about.html`, ts: '20200601000000', body: html('REAL about page') },
      { url: `${S}/About.html`, ts: '20210210000000', status: 301, location: `${S}/about.html` },
      { url: `${S}/about.html`, ts: '20210305000000', body: PARKED },
    ];
    const archive = await startFakeArchive(caps);
    const out = await mkdtemp(path.join(work, 'r-'));
    try {
      const r = await restore({ domain: D, outDir: out, skipHealth: true, target, to: '20210228', zip: false, archive: { base: archive.base, ...FAST } });
      const preview = await createPreviewServer(r.siteDir);
      await new Promise<void>((ok) => preview.listen(0, '127.0.0.1', ok));
      try {
        const base = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
        const moved = await fetch(`${base}/About.html`, { redirect: 'manual' });
        assert.deepEqual([moved.status, moved.headers.get('location')], [301, '/about.html']);
        const page = await fetch(`${base}/about.html`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /REAL about page/);
      } finally {
        preview.close();
      }
    } finally {
      await archive.close();
    }
  });
});
