// What a skipped self-redirect may and may not become. Wayback skips a 3xx whose Location it files
// under the same key and serves the nearest other capture of that key, so the reply never says
// whether the site's 3xx only switched to https (or www) or moved to another spelling. A URL that
// also served content of its own in the good period keeps that content; only a URL that was never
// anything but a 3xx is restored as a redirect, and never as one end of a loop.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ArchiveClient } from '../src/engine/archive.ts';
import { buildIndex, crawl, type CrawlOptions, type Manifest } from '../src/engine/crawl.ts';
import { restore } from '../src/engine/restore.ts';
import { createPreviewServer } from '../src/engine/serve.ts';
import { startFakeArchive, type FakeArchiveOptions, type FakeCapture } from './fake-archive.ts';

const FAST = { minIntervalMs: 0, backoffMs: 5 };
const html = (t: string, b = '') => `<html><head><title>${t}</title></head><body><h1>${t}</h1>${b}</body></html>`;
const PARKED = html('Parked', 'This domain may be for sale');

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'zp-replay-'));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

async function run(domain: string, captures: FakeCapture[], opts: { target?: string; to?: string; workDir?: string } = {}, fake: FakeArchiveOptions = {}) {
  const archive = await startFakeArchive(captures, fake);
  try {
    const client = new ArchiveClient({ base: archive.base, ...FAST });
    const full: CrawlOptions = {
      domain,
      target: opts.target ?? '20210215000000',
      window: { to: opts.to ?? '20210228235959' },
      workDir: opts.workDir ?? (await mkdtemp(path.join(work, 'w-'))),
      maxUrls: 100,
      orphans: true,
      workers: 1,
    };
    const manifest = await crawl(client, await buildIndex(client, full), full);
    const get = (p: string) => manifest.resources.find((r) => r.path === p);
    const body = async (p: string) => readFile(path.join(full.workDir, 'raw', get(p)!.file!), 'utf8');
    return { manifest, get, body };
  } finally {
    await archive.close();
  }
}

const redirects = (m: Manifest) => m.resources.filter((r) => r.location).map((r) => `${r.path} ${r.status} ${r.location}`);

describe('a 3xx pick whose replay lands on another spelling', () => {
  for (const [name, t] of Object.entries({
    'nearest-time skip': { t1: '20200601000000', t2: '20210210000000', t3: '20210212000000', t4: '20210501000000', target: '20210215000000' },
    'closest-time order': { t1: '20201101000000', t2: '20210209000000', t3: '20210311000000', t4: '20210530000000', target: '20210224000000' },
  })) {
    it(`does not turn two http -> https 301s into a loop between /page and /page/ (${name})`, async () => {
      // Both spellings served a page; each only ever redirected to https of itself.
      const D = 'loop.example';
      const { manifest, get, body } = await run(
        D,
        [
          { url: `http://${D}/`, ts: t.target, body: html('Home', '<a href="/page">a</a> <a href="/page/">b</a>') },
          { url: `http://${D}/page/`, ts: t.t1, body: html('PAGE-SLASH') },
          { url: `http://${D}/page`, ts: t.t2, status: 301, location: `https://${D}/page` },
          { url: `http://${D}/page/`, ts: t.t3, status: 301, location: `https://${D}/page/` },
          { url: `https://${D}/page`, ts: t.t4, body: html('PAGE-NOSLASH') },
        ],
        { target: t.target, to: '20210630235959' },
        { stripTrailingSlash: true },
      );
      assert.deepEqual(redirects(manifest), []);
      assert.match(await body('/page'), /PAGE-NOSLASH/);
      assert.match(await body('/page/'), /PAGE-SLASH/);
      assert.deepEqual([get('/page')?.status, get('/page/')?.status], [200, 200]);
    });
  }

  it('serves an IIS page whose 301 only switched to https from its own capture', async () => {
    const D = 'iis.example';
    const { manifest, body } = await run(D, [
      { url: `http://${D}/`, ts: '20210201000000', body: html('Home', '<a href="/About.html">a</a> <a href="/about.html">b</a>') },
      { url: `https://${D}/about.html`, ts: '20210101000000', body: html('about-lower') },
      { url: `http://${D}/About.html`, ts: '20210210000000', status: 301, location: `https://${D}/About.html` },
      { url: `https://${D}/About.html`, ts: '20200101000000', body: html('About-UPPER') },
    ]);
    assert.deepEqual(redirects(manifest), []);
    assert.match(await body('/About.html'), /About-UPPER/);
    assert.match(await body('/about.html'), /about-lower/);
  });

  it('does the same for a query string in another order', async () => {
    const D = 'query.example';
    const { manifest, body } = await run(D, [
      { url: `http://${D}/`, ts: '20210201000000', body: html('Home', '<a href="/p?a=1&amp;b=2">p</a>') },
      { url: `https://${D}/p?a=1&b=2`, ts: '20200101000000', body: html('P-ab') },
      { url: `http://${D}/p?a=1&b=2`, ts: '20210210000000', status: 301, location: `https://${D}/p?a=1&b=2` },
      { url: `http://${D}/p?b=2&a=1`, ts: '20210212000000', body: html('P-ba') },
    ]);
    assert.deepEqual(redirects(manifest), []);
    assert.match(await body('/p?a=1&b=2'), /P-ab/);
  });

  it('still restores a case-only 301 when the URL was never anything else', async () => {
    const D = 'caseonly.example';
    const { manifest, get } = await run(D, [
      { url: `http://${D}/`, ts: '20210201000000', body: html('Home', '<a href="/About.html">About</a>') },
      { url: `http://${D}/About.html`, ts: '20210210000000', status: 301, location: `http://${D}/about.html` },
      { url: `http://${D}/about.html`, ts: '20210212000000', body: html('about') },
    ]);
    assert.deepEqual(redirects(manifest), [`/About.html 301 http://${D}/about.html`]);
    assert.equal(get('/about.html')?.status, 200);
  });

  it('keeps the window for a listed URL whose replay lands after it', async () => {
    // Only a self-redirect in the window, then the new owner's catch-all redirect to a spam site.
    const D = 'spam.example';
    const { manifest } = await run(D, [
      { url: `http://${D}/`, ts: '20210201000000', body: html('Home', '<a href="/promo">promo</a>') },
      { url: `http://${D}/promo`, ts: '20210210000000', status: 301, location: `https://${D}/promo` },
      { url: `https://${D}/promo`, ts: '20210401000000', status: 302, location: 'http://casino.example/' },
    ]);
    assert.equal(manifest.resources.find((r) => r.path === '/promo'), undefined);
    assert.ok(manifest.missing.some((m) => m.url.endsWith('/promo') && /outside the good period/.test(m.reason)));
  });

  it('never closes a loop with a redirect kept from an earlier run', async () => {
    // An earlier version recorded /page -> /page/; this run works out /page/ -> /page.
    const D = 'resume.example';
    const workDir = await mkdtemp(path.join(work, 'w-'));
    const target = '20210215000000';
    const window = { to: '20210228235959' };
    const old: Manifest = {
      version: 1,
      domain: D,
      target,
      window,
      indexSize: 3,
      truncated: false,
      resources: [{ key: `${D}/page`, url: `http://${D}/page`, path: '/page', timestamp: '20200601000000', status: 301, location: `http://${D}/page/`, via: 'link' }],
      missing: [],
    };
    await mkdir(path.join(workDir, 'raw'), { recursive: true });
    await writeFile(path.join(workDir, 'manifest.json'), JSON.stringify(old));
    const { manifest } = await run(
      D,
      [
        { url: `http://${D}/`, ts: '20210201000000', body: html('Home', '<a href="/page/">page</a> <a href="/page">p</a>') },
        { url: `http://${D}/page`, ts: '20200601000000', body: html('REAL page') },
        { url: `http://${D}/page/`, ts: '20210210000000', status: 301, location: `http://${D}/page` },
      ],
      { target, to: window.to, workDir },
      { stripTrailingSlash: true },
    );
    const byKey = new Map(manifest.resources.map((r) => [r.key, r]));
    for (const r of manifest.resources) {
      if (!r.location) continue;
      const back = byKey.get(new URL(r.location).host + new URL(r.location).pathname);
      assert.notEqual(back?.location && new URL(back.location).pathname, r.path, `${r.path} -> ${r.location} -> ${back?.location}`);
    }
    assert.ok(manifest.missing.some((m) => m.url.endsWith('/page/') && /loop/.test(m.reason)), JSON.stringify(manifest.missing));
  });
});

describe('archive navigation is never a redirect', () => {
  it('treats a 3xx without Memento-Datetime that leaves the archive as a failed capture', async () => {
    const server = http.createServer((req, res) => {
      if (req.url!.includes('/away')) {
        res.writeHead(302, { location: 'https://login.example.org/' });
      } else {
        res.writeHead(301, { location: 'http://other.example/new', 'memento-datetime': 'Wed, 01 Jan 2020 00:00:00 GMT' });
      }
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const client = new ArchiveClient({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...FAST });
      const away = await client.fetchCapture('20200101000000', 'http://site.example/away');
      assert.equal(away.kind, 'missing');
      // An archived redirect (it has Memento-Datetime) is still the site's own.
      const archived = await client.fetchCapture('20200101000000', 'http://site.example/old');
      assert.deepEqual(archived.kind === 'redirect' && [archived.status, archived.location], [301, 'http://other.example/new']);
    } finally {
      server.close();
    }
  });

  it('answers both spellings of a case-folded link on the restored site', async () => {
    // The home page links /About-Us.html; the archive only holds /about-us.html.
    const D = 'casefold.example';
    const archive = await startFakeArchive([
      { url: `http://${D}/`, ts: '20190415101010', body: html('Home', '<a href="/About-Us.html">About</a>') },
      { url: `http://${D}/about-us.html`, ts: '20190415101010', body: html('About us') },
    ]);
    const out = await mkdtemp(path.join(work, 'r-'));
    try {
      const r = await restore({ domain: D, outDir: out, skipHealth: true, target: '20190415101010', to: '2019', zip: false, archive: { base: archive.base, ...FAST } });
      assert.deepEqual(r.report.redirects, []);
      const preview = await createPreviewServer(r.siteDir);
      await new Promise<void>((ok) => preview.listen(0, '127.0.0.1', ok));
      try {
        const base = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
        for (const p of ['/About-Us.html', '/about-us.html']) {
          const res = await fetch(base + p, { redirect: 'manual' });
          assert.equal(res.status, 200, p);
          assert.match(await res.text(), /About us/, p);
        }
      } finally {
        preview.close();
      }
    } finally {
      await archive.close();
    }
  });
});
