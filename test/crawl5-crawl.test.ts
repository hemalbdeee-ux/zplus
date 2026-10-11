// What the crawl keeps: a URL's own content over another spelling's archived redirect, pages under
// /cgi-bin/, a demo's revisit images after an http -> https move, an honest "URL limit reached"
// when the budget runs out exactly as the linked URLs do, and a resume across a changed window.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { buildIndex, crawl, type CrawlOptions, type Manifest } from '../src/engine/crawl.ts';
import { restore } from '../src/engine/restore.ts';
import { createPreviewServer } from '../src/engine/serve.ts';
import { startFakeArchive, type FakeArchive, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };
const html = (t: string, b = '') => `<html><head><title>${t}</title></head><body><h1>${t}</h1>${b}</body></html>`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'zp-crawl5-'));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

async function run(archive: FakeArchive, opts: Partial<CrawlOptions> & Pick<CrawlOptions, 'domain' | 'target'>) {
  const client = new ArchiveClient({ base: archive.base, ...FAST });
  const full: CrawlOptions = { window: {}, workDir: await mkdtemp(path.join(work, 'w-')), maxUrls: 100, orphans: true, workers: 1, ...opts };
  const manifest = await crawl(client, await buildIndex(client, full), full);
  const get = (p: string) => manifest.resources.find((r) => r.path === p);
  const body = async (p: string) => readFile(path.join(full.workDir, 'raw', get(p)!.file!), 'utf8');
  return { manifest, get, body, workDir: full.workDir };
}

const redirects = (m: Manifest) => m.resources.filter((r) => r.location).map((r) => `${r.path} ${r.status} ${r.location}`);
const playback = (archive: FakeArchive) => archive.requests.filter((r) => r.startsWith('/web/'));

describe('a 3xx pick whose replay lands on another spelling\'s archived redirect', () => {
  // A case-sensitive Apache site: /About.html and /about.html are different pages. Replay skips
  // /About.html's http -> https 301 and moves to /about.html's own 301 to /company/.
  const D = 'apache.example';
  const captures = (own: boolean): FakeCapture[] => [
    { url: `http://${D}/`, ts: '20210201000000', body: html('Home', '<a href="/About.html">A</a> <a href="/about.html">a</a>') },
    ...(own ? [{ url: `https://${D}/About.html`, ts: '20200101000000', body: html('About-UPPER') }] : []),
    { url: `http://${D}/About.html`, ts: '20210210000000', status: 301, location: `https://${D}/About.html` },
    { url: `http://${D}/about.html`, ts: '20210209000000', status: 301, location: `http://${D}/company/` },
    { url: `http://${D}/company/`, ts: '20210209000000', body: html('Company') },
  ];

  it('says which URL the archived redirect was served from', async () => {
    const archive = await startFakeArchive(captures(true));
    try {
      const res = await new ArchiveClient({ base: archive.base, ...FAST }).fetchCapture('20210210000000', `http://${D}/About.html`);
      assert.deepEqual(res.kind === 'redirect' && [res.original, res.location], [`http://${D}/about.html`, `http://${D}/company/`]);
    } finally {
      await archive.close();
    }
  });

  it('keeps the URL\'s own page instead of the other spelling\'s redirect', async () => {
    const archive = await startFakeArchive(captures(true));
    try {
      const { manifest, get, body } = await run(archive, { domain: D, target: '20210215000000', window: { to: '20210228235959' } });
      assert.equal(get('/About.html')?.status, 200);
      assert.match(await body('/About.html'), /About-UPPER/);
      assert.deepEqual(redirects(manifest), [`/about.html 301 http://${D}/company/`]);
    } finally {
      await archive.close();
    }
  });

  it('with nothing but 3xx captures, redirects to that spelling and leaves its redirect to it', async () => {
    const archive = await startFakeArchive(captures(false));
    try {
      const { manifest } = await run(archive, { domain: D, target: '20210215000000', window: { to: '20210228235959' } });
      assert.deepEqual(redirects(manifest).sort(), [`/About.html 301 http://${D}/about.html`, `/about.html 301 http://${D}/company/`]);
    } finally {
      await archive.close();
    }
  });
});

describe('/cgi-bin/ pages', () => {
  it('are downloaded and served at their own address like any other URL', async () => {
    const D = 'oldsite.example';
    const archive = await startFakeArchive([
      { url: `http://${D}/`, ts: '20050101000000', body: html('Home', '<a href="/cgi-bin/page.cgi?id=news">News</a> <a href="/cgi-bin/guestbook.pl">Guestbook</a>') },
      { url: `http://${D}/cgi-bin/page.cgi?id=news`, ts: '20050101000000', body: html('News') },
      { url: `http://${D}/cgi-bin/guestbook.pl`, ts: '20050101000000', body: html('Guestbook') },
      // Not linked: the orphan pass finds it in the index.
      { url: `http://${D}/cgi-bin/forum.pl?topic=12`, ts: '20050101000000', body: html('Topic 12') },
    ]);
    const out = await mkdtemp(path.join(work, 'r-'));
    try {
      const r = await restore({ domain: D, outDir: out, skipHealth: true, target: '2005', to: '2005', zip: false, archive: { base: archive.base, ...FAST } });
      assert.equal(r.report.counts.indexUrls, 4);
      assert.deepEqual(r.report.missing, []);
      const preview = await createPreviewServer(r.siteDir);
      await new Promise<void>((ok) => preview.listen(0, '127.0.0.1', ok));
      try {
        const base = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
        for (const [p, title] of [['/cgi-bin/page.cgi?id=news', 'News'], ['/cgi-bin/guestbook.pl', 'Guestbook'], ['/cgi-bin/forum.pl?topic=12', 'Topic 12']]) {
          const res = await fetch(base + p, { redirect: 'manual' });
          assert.equal(res.status, 200, p);
          assert.match(res.headers.get('content-type') ?? '', /text\/html/, p);
          assert.match(await res.text(), new RegExp(`<h1>${title}</h1>`), p);
        }
      } finally {
        preview.close();
      }
    } finally {
      await archive.close();
    }
  });
});

describe('a demo past its page limit', () => {
  it('still takes a revisit image and stylesheet whose latest row is an http -> https 301', async () => {
    const D = 'img.example';
    const NEW = '20200601000000';
    const links = [1, 2, 3, 4, 5].map((i) => `<a href="/p${i}.html">p${i}</a>`).join(' ');
    const asset = (p: string, type: string, body: Buffer | string): FakeCapture[] => [
      { url: `http://${D}${p}`, ts: '20190601000000', type, body },
      { url: `http://${D}${p}`, ts: NEW, type, body, revisit: true },
      // The redirect's own little body is text/html; it says nothing about the file.
      { url: `http://${D}${p}`, ts: '20200801000000', status: 301, location: `https://${D}${p}` },
    ];
    const archive = await startFakeArchive([
      { url: `http://${D}/`, ts: NEW, body: `<html><head><link rel="stylesheet" href="/s.css"></head><body>${links}<img src="/logo.png"></body></html>` },
      ...[1, 2, 3, 4, 5].map((i) => ({ url: `http://${D}/p${i}.html`, ts: NEW, body: `<html><body>p${i}<img src="/logo.png"></body></html>` })),
      ...asset('/logo.png', 'image/png', PNG),
      ...asset('/s.css', 'text/css', 'body { color: #333 }'),
    ]);
    try {
      const { manifest } = await run(archive, { domain: D, target: NEW, window: { from: '20190101000000', to: '20201231235959' }, maxUrls: 200, maxPages: 4, orphans: false });
      const types = Object.fromEntries(manifest.resources.map((r) => [r.path, r.contentType]));
      assert.equal(types['/logo.png'], 'image/png');
      assert.equal(types['/s.css'], 'text/css');
      assert.equal(manifest.resources.filter((r) => r.contentType === 'text/html').length, 4);
    } finally {
      await archive.close();
    }
  });
});

describe('the URL budget', () => {
  it('reports the unlinked URLs it left out when it runs out exactly as the linked ones do', async () => {
    const D = 'budget.example';
    const archive = await startFakeArchive([
      { url: `http://${D}/`, ts: '20200101000000', body: html('Home', '<a href="/a.html">a</a> <a href="/b.html">b</a>') },
      { url: `http://${D}/a.html`, ts: '20200101000000', body: html('A') },
      { url: `http://${D}/b.html`, ts: '20200101000000', body: html('B') },
      ...Array.from({ length: 5 }, (_, i) => ({ url: `http://${D}/orphan${i}.html`, ts: '20200101000000', body: html(`Orphan ${i}`) })),
    ]);
    try {
      for (const workers of [1, 3]) {
        const logs: string[] = [];
        const { manifest } = await run(archive, { domain: D, target: '20200101000000', maxUrls: 3, workers, log: (m) => logs.push(m) });
        assert.equal(manifest.resources.length, 3);
        assert.equal(manifest.truncated, true, `workers=${workers}`);
        assert.ok(logs.includes('URL limit reached: 5 URLs were not downloaded'), logs.join(' | '));
        // Nothing was followed from the index, so nothing says so.
        assert.ok(!logs.some((l) => l.startsWith('following')), logs.join(' | '));
      }
      // Room for everything: nothing was left out.
      const { manifest } = await run(archive, { domain: D, target: '20200101000000', maxUrls: 8 });
      assert.equal(manifest.resources.length, 8);
      assert.equal(manifest.truncated, false);
    } finally {
      await archive.close();
    }
  });
});

describe('resuming the same snapshot', () => {
  it('reuses downloads when the window changed, except those now outside it', async () => {
    const D = 'window.example';
    const archive = await startFakeArchive([
      { url: `http://${D}/`, ts: '20200101000000', body: html('Home', '<a href="/a.html">a</a> <a href="/b.html">b</a>') },
      { url: `http://${D}/a.html`, ts: '20200101000000', body: html('A') },
      { url: `http://${D}/b.html`, ts: '20200601000000', body: html('B') },
    ]);
    try {
      const target = '20200101000000';
      const first = await run(archive, { domain: D, target, window: { to: '20201231235959' } });
      assert.equal(first.manifest.resources.length, 3);
      const before = playback(archive).length;
      // A new health scan moved the end of the window: everything still in it is reused.
      const wider = await run(archive, { domain: D, target, window: { to: '20211231235959' }, workDir: first.workDir });
      assert.equal(wider.manifest.resources.length, 3);
      assert.equal(playback(archive).length, before);
      // One that is now outside it is not.
      const narrower = await run(archive, { domain: D, target, window: { to: '20200331235959' }, workDir: first.workDir });
      assert.equal(narrower.get('/b.html'), undefined);
      assert.ok(narrower.manifest.missing.some((m) => m.url.endsWith('/b.html') && /outside the good period/.test(m.reason)), JSON.stringify(narrower.manifest.missing));
      assert.deepEqual(new Set(playback(archive).slice(before).map((r) => r.replace(/^\/web\/\d+id_\//, ''))), new Set([`http://${D}/b.html`]));
    } finally {
      await archive.close();
    }
  });
});
