// The public site under its own brand, the snapshot list (no month the archive could not play
// back), and access-code limits that count an IPv6 client's whole /64.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { HealthReport, MonthHealth } from '../src/engine/health.ts';
import type { JobStore } from '../src/web/db.ts';
import { clientKey, configFromEnv, createApp } from '../src/web/server.ts';
import { startFakeArchive, type FakeArchive, type FakeCapture } from './fake-archive.ts';

describe('client key for limits', () => {
  it('is the IPv4 address, or the /64 of an IPv6 one', () => {
    assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
    assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(clientKey('2001:DB8:0:0:ffff:1:2:3'), '2001:db8:0:0::/64');
    assert.equal(clientKey('2001:0db8:0000:0000::abcd'), '2001:db8:0:0::/64');
    assert.equal(clientKey('2001:db8:0:1::1'), '2001:db8:0:1::/64');
    assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(clientKey('::1'), '0:0:0:0::/64');
    assert.equal(clientKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
    assert.equal(clientKey('1:2:3:4:5:6:192.0.2.1'), '1:2:3:4::/64');
    assert.equal(clientKey(undefined), '');
  });
});

const month = (m: string, verdict: MonthHealth['verdict'], reasons: string[] = [], probed = true): MonthHealth => ({
  month: m,
  captures: 1,
  timestamp: `${m}10120000`,
  original: 'http://shop.example/',
  statuscode: '200',
  score: verdict === 'good' ? 90 : 10,
  verdict,
  reasons,
  probed,
});

describe('web app: brand, snapshot list and code limits', () => {
  let dataDir: string;
  let server: Server;
  let base: string;
  let store: JobStore;
  let scanId: string;

  before(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wbd-web2-site-'));
    const app = await createApp({
      ...configFromEnv({}),
      siteUrl: 'https://zplus.example',
      dataDir,
      archiveBase: 'http://127.0.0.1:9',
      archiveDelayMs: 0,
      archiveBackoffMs: 5,
      accessCode: 'letmein',
      restoreLimit: 100,
    });
    store = app.store;
    // No job runs: these tests look at pages and at which requests may start a job.
    app.runner.stop();
    server = app.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const health: HealthReport = {
      domain: 'shop.example',
      months: [
        month('201901', 'good'),
        // Not playable during the scan, estimated good from a neighbour with the same content.
        month('201902', 'good', ['capture not playable (HTTP 503)', 'same content as 2019-01']),
        month('201903', 'good', ['redirect could not be followed', 'estimated from the months around it']),
        month('201904', 'good', ['the page it leads to is a capture from 2015-02', 'estimated from the months around it']),
        // Not probed: estimated, and its capture may well play.
        month('201905', 'good', ['estimated from the months around it'], false),
        month('201906', 'good'),
        // Whatever the probe's failure is called, a probed month with an estimated verdict had none.
        month('201908', 'good', ['page could not be loaded', 'same content as 2019-01']),
        month('202001', 'bad', ['parked domain page ("buy this domain")']),
      ],
      lastGood: { month: '201906', timestamp: '20190610120000', score: 90, original: 'http://shop.example/' },
      window: { to: '20191231235959' },
      host: 'shop.example',
      probes: 6,
    };
    const scan = store.create({ kind: 'scan', domain: 'shop.example' });
    store.claim();
    store.finish(scan.id, { health });
    scanId = scan.id;
  });

  after(async () => {
    server?.close();
    store?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const get = (p: string) => fetch(base + p, { redirect: 'manual' });
  const restore = (ip: string, form: Record<string, string>) =>
    fetch(`${base}/job/${scanId}/restore`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ target: '20190610120000', ...form }),
      headers: { origin: base, 'x-forwarded-for': ip },
    });

  it('uses the zplus.ai name and tagline everywhere', async () => {
    const home = await (await get('/')).text();
    assert.match(home, /<title>zplus\.ai · Expired domain capture<\/title>/);
    assert.match(home, /<p class="eyebrow">Expired domain capture<\/p>/);
    assert.match(home, /<meta name="description" content="Expired domain capture: restore an expired website from the Wayback Machine/);
    assert.match(home, /"name": "zplus\.ai"/);
    for (const p of ['/', '/faq/', '/terms/', '/blog/', '/author/team/', '/rss/', '/sitemap.xsl', '/restore/', `/job/${scanId}/`, '/no-such-page/']) {
      const text = await (await get(p)).text();
      assert.doesNotMatch(text, /Wayback Downloader/i, p);
      assert.match(text, /zplus\.ai/, p);
    }
  });

  it('does not promise more than static hosts can do', async () => {
    const home = await (await get('/')).text();
    assert.doesNotMatch(home, /Upload it to any hosting/);
    const faq = await (await get('/faq/')).text();
    assert.match(faq, /Cloudflare Pages on its own redirects/);
    assert.match(faq, /2,000 plain and 100 pattern rules/);
    assert.doesNotMatch(faq, /Netlify and Cloudflare Pages work too/);
  });

  it('offers only months whose homepage capture could be played back', async () => {
    const html = await (await get(`/job/${scanId}/`)).text();
    const offered = [...html.matchAll(/<option value="(\d{14})"/g)].map((m) => m[1]);
    assert.deepEqual(offered, ['20190610120000', '20190510120000', '20190110120000']);
    assert.match(html, /option value="20190610120000" selected/);
    for (const target of ['20190210120000', '20190310120000', '20190410120000', '20190810120000']) {
      assert.equal((await restore('198.51.100.1', { mode: 'demo', target })).status, 422, target);
    }
    assert.equal((await restore('198.51.100.1', { mode: 'demo', target: '20190110120000' })).status, 303);
  });

  it('tells how many wrong codes are allowed', async () => {
    const html = await (await get(`/job/${scanId}/`)).text();
    assert.match(html, /After 5 wrong codes, full restores from your address are blocked for an hour/);
  });

  it('counts wrong codes for a whole IPv6 /64', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await restore(`2001:db8:5::${i + 1}`, { mode: 'full', code: `guess${i}` })).status, 403);
    // Another address of the same /64, with the right code: locked out too.
    assert.equal((await restore('2001:db8:5::99', { mode: 'full', code: 'letmein' })).status, 429);
    assert.equal(store.codeFailures('2001:db8:5:0::/64', 3600_000), 5);
    // The next /64 is another client.
    assert.equal((await restore('2001:db8:5:1::1', { mode: 'full', code: 'letmein' })).status, 303);
    // An IPv4 address is counted on its own, also when it arrives written as IPv6.
    for (let i = 0; i < 5; i++) assert.equal((await restore('::ffff:203.0.113.5', { mode: 'full', code: `g${i}` })).status, 403);
    assert.equal((await restore('203.0.113.5', { mode: 'full', code: 'letmein' })).status, 429);
    assert.equal((await restore('203.0.113.6', { mode: 'full', code: 'letmein' })).status, 303);
  });
});

describe('web app: snapshots the archive cannot play back', () => {
  const W = 'http://www.flaky.example';
  const LOREM = 'Fresh bread every morning from flour milled in the valley, baked in a wood-fired oven by people who care. ';
  const HOME = `<!DOCTYPE html><html lang="en"><head><title>Flaky bakery</title></head><body>
<nav><a href="/">Home</a> <a href="/about.html">About</a> <a href="/menu.html">Menu</a> <a href="/contact.html">Contact</a> <a href="/blog/">Blog</a></nav>
<h1>Flaky bakery</h1><p>${LOREM.repeat(12)}</p></body></html>`;
  const caps: FakeCapture[] = [];
  for (let mo = 1; mo <= 12; mo++) caps.push({ url: `${W}/`, ts: `2019${String(mo).padStart(2, '0')}10120000`, body: HOME });

  let archive: FakeArchive;
  let proxy: Server;
  let dataDir: string;
  let server: Server;
  let base: string;
  let stop: () => void;

  before(async () => {
    archive = await startFakeArchive(caps);
    // archive.org answers 503 for two homepage captures, every time.
    proxy = http.createServer(async (req, res) => {
      if (/^\/web\/(201905|201912)\d{8}id_\//.test(req.url ?? '')) {
        res.writeHead(503, { 'retry-after': '0' });
        res.end('busy');
        return;
      }
      const r = await fetch(archive.base + req.url, { redirect: 'manual' });
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (k !== 'content-length' && k !== 'transfer-encoding') headers[k] = v;
      });
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wbd-web2-flaky-'));
    const app = await createApp({
      ...configFromEnv({}),
      siteUrl: 'https://zplus.example',
      dataDir,
      archiveBase: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      archiveDelayMs: 0,
      archiveBackoffMs: 1,
      accessCode: '',
    });
    app.runner.start();
    server = app.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => {
      app.runner.stop();
      app.store.close();
    };
  });

  after(async () => {
    server?.close();
    stop?.();
    proxy?.close();
    await archive?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('does not offer them', async () => {
    const post = (p: string, form: Record<string, string>) =>
      fetch(base + p, { method: 'POST', redirect: 'manual', body: new URLSearchParams(form), headers: { origin: base } });
    const scan = await post('/restore/', { domain: 'flaky.example' });
    const scanUrl = scan.headers.get('location')!;
    const scanId = scanUrl.split('/')[2];
    for (let i = 0; i < 600; i++) {
      const job = (await (await fetch(`${base}/api/jobs/${scanId}`)).json()) as { status: string };
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const html = await (await fetch(base + scanUrl)).text();
    const offered = [...html.matchAll(/<option value="(\d{14})"/g)].map((m) => m[1]);
    assert.ok(offered.length >= 6, offered.join(' '));
    assert.ok(!offered.some((ts) => ts.startsWith('201905') || ts.startsWith('201912')), offered.join(' '));
    assert.match(html, /option value="20191110120000" selected/);
    assert.equal((await post(`/job/${scanId}/restore`, { target: '20190510120000', mode: 'demo' })).status, 422);
    assert.equal((await post(`/job/${scanId}/restore`, { target: '20191210120000', mode: 'demo' })).status, 422);
  });
});
