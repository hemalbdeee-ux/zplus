// The web app: Ghost-style public routes and SEO, and the scan -> restore -> download flow
// against the fake archive.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { configFromEnv, createApp } from '../src/web/server.ts';
import { startFakeArchive, type FakeArchive } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

describe('web app', () => {
  let archive: FakeArchive;
  let dataDir: string;
  let server: Server;
  let base: string;
  let stop: () => void;

  before(async () => {
    archive = await startFakeArchive(OLD_BAKERY);
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wbd-web-'));
    const { app, runner, store } = await createApp({
      ...configFromEnv({}),
      siteUrl: 'https://wayback.example',
      dataDir,
      archiveBase: archive.base,
      archiveDelayMs: 0,
      archiveBackoffMs: 5,
      accessCode: 'letmein',
    });
    runner.start();
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => {
      runner.stop();
      store.close();
    };
  });

  after(async () => {
    server?.close();
    stop?.();
    await archive?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const get = (p: string, init?: RequestInit) => fetch(base + p, { redirect: 'manual', ...init });
  const post = (p: string, form: Record<string, string>) =>
    fetch(base + p, { method: 'POST', redirect: 'manual', body: new URLSearchParams(form), headers: { origin: base } });

  async function waitFor(id: string): Promise<{ status: string }> {
    for (let i = 0; i < 200; i++) {
      const job = (await (await get(`/api/jobs/${id}`)).json()) as { status: string };
      if (job.status === 'done' || job.status === 'failed') return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('job did not finish');
  }

  it('serves the public site with Ghost-style URLs and SEO', async () => {
    const home = await (await get('/')).text();
    assert.match(home, /<link rel="canonical" href="https:\/\/wayback\.example\/">/);
    assert.match(home, /"@type": "WebSite"/);
    assert.match(home, /<link rel="alternate" type="application\/rss\+xml"/);

    const post = await get('/restore-a-website-from-the-wayback-machine/');
    assert.equal(post.status, 200);
    const html = await post.text();
    assert.match(html, /<meta property="og:type" content="article">/);
    assert.match(html, /"@type": "Article"/);
    assert.match(html, /<link rel="canonical" href="https:\/\/wayback\.example\/restore-a-website-from-the-wayback-machine\/">/);

    const noSlash = await get('/faq');
    assert.equal(noSlash.status, 301);
    assert.equal(noSlash.headers.get('location'), '/faq/');
    assert.equal((await get('/tag/expired-domains/')).status, 200);
    assert.equal((await get('/author/team/')).status, 200);
    assert.equal((await get('/blog/page/9/')).status, 404);
    assert.equal((await get('/no-such-page/')).status, 404);
  });

  it('serves sitemaps, RSS and robots.txt', async () => {
    const index = await (await get('/sitemap.xml')).text();
    assert.match(index, /https:\/\/wayback\.example\/sitemap-posts\.xml/);
    assert.match(index, /https:\/\/wayback\.example\/sitemap-pages\.xml/);
    const posts = await (await get('/sitemap-posts.xml')).text();
    assert.match(posts, /keep-original-urls-on-an-expired-domain/);
    assert.match(await (await get('/rss/')).text(), /<rss/);
    const robots = await (await get('/robots.txt')).text();
    assert.match(robots, /Disallow: \/job\//);
    assert.match(robots, /Sitemap: https:\/\/wayback\.example\/sitemap\.xml/);
  });

  it('rejects bad input and forms from other sites', async () => {
    assert.equal((await post('/restore/', { domain: 'not a domain' })).status, 422);
    const foreign = await fetch(base + '/restore/', { method: 'POST', body: new URLSearchParams({ domain: 'a.com' }), headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    assert.equal((await get('/job/doesnotexist0000/')).status, 404);
    const nullOrigin = await fetch(base + '/restore/', { method: 'POST', body: new URLSearchParams({ domain: 'a.com' }), headers: { origin: 'null' } });
    assert.equal(nullOrigin.status, 403);
    const prefill = await (await get('/restore/?domain=oldsite.com')).text();
    assert.match(prefill, /value="oldsite\.com"/);
    assert.doesNotMatch(prefill, /Checking the archive/);
  });

  it('scans, restores a demo, and serves the ZIP', async () => {
    const scan = await post('/restore/', { domain: 'https://www.oldbakery.example/' });
    assert.equal(scan.status, 303);
    const scanUrl = scan.headers.get('location')!;
    const scanId = scanUrl.split('/')[2];
    assert.equal((await waitFor(scanId)).status, 'done');

    const page = await (await get(scanUrl)).text();
    assert.match(page, /<meta name="robots" content="noindex">/);
    assert.match(page, /option value="20201114083015" selected/);

    assert.equal((await post(`/job/${scanId}/restore`, { target: '20201114083015', mode: 'full', code: 'wrong' })).status, 403);
    assert.equal((await post(`/job/${scanId}/restore`, { target: '19990101000000', mode: 'demo' })).status, 422);

    const restore = await post(`/job/${scanId}/restore`, { target: '20201114083015', mode: 'demo' });
    assert.equal(restore.status, 303);
    const restoreId = restore.headers.get('location')!.split('/')[2];
    assert.equal((await waitFor(restoreId)).status, 'done');

    const result = await (await get(`/job/${restoreId}/`)).text();
    assert.match(result, /The site is ready/);
    assert.match(result, /Demo restore/);
    const zip = await get(`/job/${restoreId}/download`);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get('content-disposition') ?? '', /oldbakery\.example-restored\.zip/);
    assert.ok((await zip.arrayBuffer()).byteLength > 1000);
    assert.equal((await get(`/job/${restoreId}/report`)).status, 200);

    // The same domain again reuses the recent scan instead of asking the archive twice.
    const again = await post('/restore/', { domain: 'oldbakery.example' });
    assert.equal(again.headers.get('location'), scanUrl);
  });
});
