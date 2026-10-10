// The web app with no access code configured: anyone can run a full restore. Also covers the
// snapshot list (only dates restore() can honour), redirects that must stay on this site, the
// homepage alert box, and downloads from a data folder under a dot-directory.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { configFromEnv, createApp } from '../src/web/server.ts';
import { startFakeArchive, type FakeArchive, type FakeCapture } from './fake-archive.ts';

// A bakery that ran 2008-2009 and again 2012-2013, with a parking page in between and after.
const W = 'http://www.twoperiods.example';
const LOREM =
  'Our bakers start at four in the morning. The dough for every loaf rests overnight, which gives the crust its colour and the crumb its open texture. We buy flour from two mills in the valley and use no improvers or preservatives. ';
const page = (m: string) => `<!DOCTYPE html><html lang="en"><head><title>Bakery ${m}</title></head><body>
<nav><a href="/">Home</a> <a href="/about.html">About</a></nav>
<h1>Bakery ${m}</h1><p>${LOREM}</p><p>${LOREM}</p><p>${LOREM}</p></body></html>`;
const PARKED = `<!DOCTYPE html><html><head><title>twoperiods.example</title></head><body><p>This domain may be for sale. Buy this domain today!</p></body></html>`;
const TWO_PERIODS: FakeCapture[] = [];
for (let y = 2008; y <= 2015; y++) {
  for (let mo = 1; mo <= 12; mo++) {
    const m = `${y}${String(mo).padStart(2, '0')}`;
    const good = y <= 2009 || (y >= 2012 && y <= 2013);
    TWO_PERIODS.push({ url: `${W}/`, ts: `${m}10120000`, body: good ? page(m) : PARKED });
    if (good) TWO_PERIODS.push({ url: `${W}/about.html`, ts: `${m}10120000`, body: page(`about ${m}`) });
  }
}

describe('web app without an access code', () => {
  let archive: FakeArchive;
  let tmp: string;
  let server: Server;
  let base: string;
  let stop: () => void;

  before(async () => {
    archive = await startFakeArchive(TWO_PERIODS);
    tmp = await mkdtemp(path.join(os.tmpdir(), 'wbd-open-'));
    // Like WBD_DATA=~/.local/share/wbd: a dot-directory in the data path.
    const dataDir = path.join(tmp, '.local', 'data');
    await mkdir(dataDir, { recursive: true });
    const { app, runner, store } = await createApp({
      ...configFromEnv({}),
      siteUrl: 'https://wayback.example',
      dataDir,
      archiveBase: archive.base,
      archiveDelayMs: 0,
      archiveBackoffMs: 5,
      accessCode: '',
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
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const get = (p: string) => fetch(base + p, { redirect: 'manual' });
  const post = (p: string, form: Record<string, string>) =>
    fetch(base + p, { method: 'POST', redirect: 'manual', body: new URLSearchParams(form), headers: { origin: base } });
  // fetch() would normalise "//host" paths, so these go out exactly as written.
  const raw = (p: string) =>
    new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const u = new URL(base);
      http
        .get({ host: u.hostname, port: u.port, path: p }, (res) => {
          res.resume();
          resolve({ status: res.statusCode!, location: res.headers.location });
        })
        .on('error', reject);
    });

  async function waitFor(id: string): Promise<{ status: string; error?: string }> {
    for (let i = 0; i < 400; i++) {
      const job = (await (await get(`/api/jobs/${id}`)).json()) as { status: string; error?: string };
      if (job.status === 'done' || job.status === 'failed') return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('job did not finish');
  }

  it('never redirects to another site', async () => {
    for (const p of ['//evil.example/login', '//evil.example/x?y=1', '///evil.example/x', '/\\evil.example/x']) {
      const res = await raw(p);
      assert.equal(res.status, 404, p);
      assert.equal(res.location, undefined, p);
    }
    assert.deepEqual(await raw('/faq'), { status: 301, location: '/faq/' });
  });

  it('does not show text from the query string as an alert', async () => {
    const home = await (await get('/?error=Service%20moved.%20Continue%20at%20https://evil.example')).text();
    assert.doesNotMatch(home, /Service moved/);
    assert.doesNotMatch(home, /role="alert"/);
    assert.doesNotMatch(home, /Free:/);
  });

  it('answers client errors with their own status', async () => {
    const big = await post('/restore/', { domain: 'x'.repeat(10_000) });
    assert.equal(big.status, 413);
  });

  it('offers only snapshots from the healthy period, and a full restore without a code', async () => {
    const scan = await post('/restore/', { domain: 'twoperiods.example' });
    assert.equal(scan.status, 303);
    const scanUrl = scan.headers.get('location')!;
    const scanId = scanUrl.split('/')[2];
    assert.equal((await waitFor(scanId)).status, 'done');

    const html = await (await get(scanUrl)).text();
    const offered = [...html.matchAll(/<option value="(\d{14})"/g)].map((m) => m[1]);
    assert.ok(offered.length > 0);
    assert.ok(offered.every((ts) => ts >= '20120101000000' && ts <= '20131231235959'), `offered ${offered.join(' ')}`);
    assert.match(html, /name="mode" value="full"/);
    assert.doesNotMatch(html, /name="code"/);

    // A healthy month of the earlier period cannot be restored from this window, so it is refused.
    assert.equal((await post(`/job/${scanId}/restore`, { target: '20090110120000', mode: 'demo' })).status, 422);
    // So is a parked month.
    assert.equal((await post(`/job/${scanId}/restore`, { target: '20150110120000', mode: 'demo' })).status, 422);

    const full = await post(`/job/${scanId}/restore`, { target: '20131210120000', mode: 'full' });
    assert.equal(full.status, 303);
    const restoreId = full.headers.get('location')!.split('/')[2];
    assert.equal((await waitFor(restoreId)).status, 'done');
    const result = await (await get(`/job/${restoreId}/`)).text();
    assert.match(result, /Full restore/);
    assert.match(result, /The site is ready/);

    // The data folder is under ".local": both files are still served.
    const zip = await get(`/job/${restoreId}/download`);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get('content-disposition') ?? '', /twoperiods\.example-restored\.zip/);
    assert.ok((await zip.arrayBuffer()).byteLength > 500);
    const report = await get(`/job/${restoreId}/report`);
    assert.equal(report.status, 200);
    assert.match(await report.text(), /twoperiods/);
  });
});
