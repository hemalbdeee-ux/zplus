// The web app with WBD_ACCESS_CODE set: a full restore needs the code, and the code cannot be
// guessed by trying many, nor tested once the restore limit is used up.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { configFromEnv, createApp } from '../src/web/server.ts';
import type { JobStore } from '../src/web/db.ts';
import { startFakeArchive, type FakeArchive } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

describe('web app with an access code', () => {
  let archive: FakeArchive;
  let dataDir: string;
  let server: Server;
  let base: string;
  let store: JobStore;
  let stop: () => void;
  let scanId: string;

  before(async () => {
    archive = await startFakeArchive(OLD_BAKERY);
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wbd-code-'));
    const app = await createApp({
      ...configFromEnv({}),
      siteUrl: 'https://wayback.example',
      dataDir,
      archiveBase: archive.base,
      archiveDelayMs: 0,
      archiveBackoffMs: 5,
      accessCode: 'letmein',
      restoreLimit: 2,
    });
    store = app.store;
    // The runner stays stopped: these tests only look at which requests may start a job.
    app.runner.stop();
    server = app.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => store.close();

    const scan = store.create({ kind: 'scan', domain: 'oldbakery.example' });
    store.claim();
    const health = {
      domain: 'oldbakery.example',
      months: [{ month: '202011', captures: 1, timestamp: '20201114083015', score: 92, verdict: 'good', reasons: [], probed: true }],
      lastGood: { month: '202011', timestamp: '20201114083015', score: 92, original: 'http://oldbakery.example/' },
      window: {},
      host: 'oldbakery.example',
      probes: 1,
    };
    store.finish(scan.id, { health });
    scanId = scan.id;
  });

  after(async () => {
    server?.close();
    stop?.();
    await archive?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  // The app trusts X-Forwarded-For from loopback (Traefik), so each test can be its own address.
  const restore = (ip: string, form: Record<string, string>) =>
    fetch(`${base}/job/${scanId}/restore`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ target: '20201114083015', ...form }),
      headers: { origin: base, 'x-forwarded-for': ip },
    });

  it('asks for the code on the snapshot page', async () => {
    const html = await (await fetch(`${base}/job/${scanId}/`)).text();
    assert.match(html, /name="mode" value="full"/);
    assert.match(html, /name="code"/);
  });

  it('stops answering code guesses after a few wrong ones', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await restore('10.0.0.1', { mode: 'full', code: `guess${i}` })).status, 403);
    // From now on a right and a wrong code get the same answer.
    assert.equal((await restore('10.0.0.1', { mode: 'full', code: 'guess9' })).status, 429);
    assert.equal((await restore('10.0.0.1', { mode: 'full', code: 'letmein' })).status, 429);
    // Other addresses are not affected, and the code works.
    assert.equal((await restore('10.0.0.2', { mode: 'full', code: 'letmein' })).status, 303);
  });

  it('applies the restore limit before looking at the code', async () => {
    assert.equal((await restore('10.0.0.3', { mode: 'demo' })).status, 303);
    assert.equal((await restore('10.0.0.3', { mode: 'demo' })).status, 303);
    assert.equal((await restore('10.0.0.3', { mode: 'full', code: 'wrong' })).status, 429);
    assert.equal((await restore('10.0.0.3', { mode: 'full', code: 'letmein' })).status, 429);
    assert.equal(store.codeFailures('10.0.0.3', 3600_000), 0);
  });
});
