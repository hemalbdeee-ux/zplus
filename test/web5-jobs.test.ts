// Jobs that wait, stop and run again. A snapshot check or demo never waits for a full restore; a
// shutdown (a deploy) puts running jobs back in the queue without using up an attempt; a failed
// restore runs again under the same id and continues where it stopped, for as long as the scan it
// was made from is kept; a scan that archive.org partly refused says so and is not reused. Also the
// deploy files that make these work.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { JobStore, MAX_RETRIES, type Job } from '../src/web/db.ts';
import { configFromEnv, createApp } from '../src/web/server.ts';
import { JobRunner, scanGone } from '../src/web/worker.ts';
import { startFakeArchive, type FakeArchive, type FakeCapture } from './fake-archive.ts';
import { OLD_BAKERY } from './fixtures/oldbakery.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const TS = '20200101000000';
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** An archive that never answers: a job stays busy on its first request. */
async function hangingArchive() {
  let seen = 0;
  const server = http.createServer(() => {
    seen++;
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen: () => seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Forwards to the fake archive, but answers 503 for the playback requests `refuse` picks. */
async function refusingProxy(archive: FakeArchive, refuse: (url: string) => boolean) {
  const log: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    log.push(url);
    if (refuse(url)) {
      res.writeHead(503);
      res.end('unavailable');
      return;
    }
    const r = await fetch(archive.base + url, { redirect: 'manual' });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (k !== 'content-length' && k !== 'transfer-encoding') headers[k] = v;
    });
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log, close: () => server.close() };
}

describe('job queue: scans and demos have a slot of their own', () => {
  let dir: string;
  let archive: Awaited<ReturnType<typeof hangingArchive>>;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-web5-lanes-'));
    archive = await hangingArchive();
  });
  after(async () => {
    archive?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('takes scans and demos past waiting full restores, and counts the line per kind', async () => {
    const store = new JobStore(path.join(dir, 'store.sqlite'));
    const jobs: Job[] = [];
    // Created a moment apart, so the order in the line is certain.
    for (const input of [
      { kind: 'restore' as const, domain: 'big.example', target: TS },
      { kind: 'restore' as const, domain: 'bigger.example', target: TS },
      { kind: 'scan' as const, domain: 'scan.example' },
      { kind: 'restore' as const, domain: 'demo.example', target: TS, maxPages: 4 },
    ]) {
      jobs.push(store.create(input));
      await sleep(3);
    }
    const [full, full2, scan, demo] = jobs;
    assert.deepEqual(
      jobs.map((j) => store.queuePosition(j.id)),
      [1, 2, 1, 2],
    );
    assert.equal(store.claim(true)?.id, scan.id);
    assert.equal(store.claim(true)?.id, demo.id);
    assert.equal(store.claim(true), undefined);
    assert.equal(store.claim()?.id, full.id);
    assert.equal(store.queuePosition(full2.id), 1);
    store.close();
  });

  it('runs a snapshot check while a full restore holds the only worker', async () => {
    const store = new JobStore(path.join(dir, 'runner.sqlite'));
    const runner = new JobRunner(store, path.join(dir, 'runner'), { workers: 1, retentionDays: 7, archive: { base: archive.base, minIntervalMs: 0 }, log: () => {} });
    const full = store.create({ kind: 'restore', domain: 'big.example', target: TS });
    await sleep(3);
    const full2 = store.create({ kind: 'restore', domain: 'bigger.example', target: TS });
    await sleep(3);
    const scan = store.create({ kind: 'scan', domain: 'scan.example' });
    await sleep(3);
    const demo = store.create({ kind: 'restore', domain: 'demo.example', target: TS, maxPages: 4 });
    runner.start();
    try {
      await until('the restore and the scan to run', () => runner.processes.has(full.id) && runner.processes.has(scan.id));
      assert.equal(runner.running, 2);
      assert.equal(store.get(full2.id)?.status, 'queued');
      // Neither the demo nor the second restore has a job ahead of it in its line.
      assert.equal(store.queuePosition(demo.id), 1);
      assert.equal(store.queuePosition(full2.id), 1);

      // When the scan ends, the demo takes its slot; a full restore never does.
      runner.cancel(scan.id);
      await until('the demo to run', () => runner.processes.has(demo.id));
      runner.cancel(demo.id);
      await until('the demo to end', () => !runner.processes.has(demo.id) && runner.running === 1);
      await sleep(1200);
      assert.equal(store.get(full2.id)?.status, 'queued');
      assert.equal(store.get(full.id)?.status, 'running');
    } finally {
      runner.stop();
      store.close();
    }
  });
});

describe('shutdown: a deploy is not a crash', () => {
  let dir: string;
  let archive: Awaited<ReturnType<typeof hangingArchive>>;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-web5-shutdown-'));
    archive = await hangingArchive();
  });
  after(async () => {
    archive?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('puts a running job back without counting the attempt, however often', async () => {
    const store = new JobStore(path.join(dir, 'runner.sqlite'));
    const job = store.create({ kind: 'restore', domain: 'long.example', target: TS });
    for (let deploy = 1; deploy <= 3; deploy++) {
      const runner = new JobRunner(store, path.join(dir, 'runner'), { workers: 1, retentionDays: 7, archive: { base: archive.base, minIntervalMs: 0 }, log: () => {} });
      runner.start();
      const child = await until('the job process', () => runner.processes.get(job.id));
      assert.equal(store.get(job.id)?.attempts, 1);
      const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      const started = Date.now();
      await runner.shutdown();
      // The process stopped by itself, well before it would have been killed.
      assert.equal(await exit, 0);
      assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
      const now = store.get(job.id)!;
      assert.equal(now.status, 'queued', `deploy ${deploy}: ${now.error}`);
      assert.equal(now.attempts, 0);
      assert.equal(runner.processes.size, 0);
    }
    store.close();
  });

  it('keeps the result of a job that ended before the shutdown', async () => {
    const store = new JobStore(path.join(dir, 'ended.sqlite'));
    const runner = new JobRunner(store, path.join(dir, 'ended'), { workers: 1, retentionDays: 7, archive: { base: archive.base, minIntervalMs: 0 }, log: () => {} });
    const job = store.create({ kind: 'scan', domain: 'cancelled.example' });
    runner.start();
    await until('the job process', () => runner.processes.get(job.id));
    runner.cancel(job.id);
    await runner.shutdown();
    assert.equal(store.get(job.id)?.status, 'failed');
    store.close();
  });

  it('stops the server on SIGTERM or Ctrl-C and puts its jobs back in the queue', async () => {
    const data = path.join(dir, 'server');
    await mkdir(data, { recursive: true });
    const store = new JobStore(path.join(data, 'wbd.sqlite'));
    const job = store.create({ kind: 'restore', domain: 'long.example', target: TS });
    try {
      // Three deploys while the job runs: before the fix the second one failed it for good. The
      // last is a Ctrl-C, which reaches the job's process too.
      for (let deploy = 1; deploy <= 3; deploy++) {
        const ctrlC = deploy === 3;
        const before = archive.seen();
        let log = '';
        const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/web/server.ts'], {
          cwd: ROOT,
          env: { ...process.env, NODE_TEST_CONTEXT: undefined, PORT: '0', WBD_DATA: data, WBD_ARCHIVE: archive.base },
          stdio: ['ignore', 'ignore', 'pipe'],
          detached: ctrlC,
        });
        server.stderr.on('data', (d: Buffer) => (log += d));
        const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => server.once('exit', (code, signal) => resolve({ code, signal })));
        await until('the job to ask the archive', () => store.get(job.id)?.status === 'running' && archive.seen() > before);
        const started = Date.now();
        if (ctrlC) process.kill(-server.pid!, 'SIGINT');
        else server.kill('SIGTERM');
        assert.deepEqual(await exit, { code: 0, signal: null }, log);
        assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
        const now = store.get(job.id)!;
        assert.equal(now.status, 'queued', `deploy ${deploy}: ${now.error} ${log}`);
        assert.equal(now.attempts, 0);
      }
    } finally {
      store.close();
    }
  });
});

describe('web app: a failed restore runs again where it stopped', () => {
  const W = 'http://www.long.example';
  const PAGES = 60;
  const links = Array.from({ length: PAGES }, (_, i) => `<li><a href="/p${i}.html">Page ${i}</a></li>`).join('');
  const caps: FakeCapture[] = [{ url: `${W}/`, ts: TS, body: `<html><head><title>Long</title></head><body><ul>${links}</ul></body></html>` }];
  for (let i = 0; i < PAGES; i++) caps.push({ url: `${W}/p${i}.html`, ts: TS, body: `<html><head><title>Page ${i}</title></head><body><p>Page ${i}</p></body></html>` });

  let archive: FakeArchive;
  let proxy: Awaited<ReturnType<typeof refusingProxy>>;
  let refusing = true;
  let dataDir: string;
  let server: Server;
  let base: string;
  let store: JobStore;
  let runner: JobRunner;
  let stop: () => void;
  let scanId: string;

  before(async () => {
    archive = await startFakeArchive(caps);
    // archive.org refuses the pages from p20 on, so the crawl stops after a run of refusals.
    proxy = await refusingProxy(archive, (url) => refusing && /id_\/.*\/p([2-9]\d)\.html$/.test(url));
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wbd-web5-retry-'));
    const app = await createApp({ ...configFromEnv({}), dataDir, archiveBase: proxy.base, archiveDelayMs: 0, archiveBackoffMs: 5, accessCode: '' });
    // A refusal is final at once (archive.org gets five tries with backoff).
    Object.assign(app.runner.opts.archive, { retries: 0 });
    store = app.store;
    runner = app.runner;
    app.runner.start();
    server = app.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => {
      app.runner.stop();
      store.close();
    };
    const scan = store.create({ kind: 'scan', domain: 'long.example' });
    store.claim();
    store.finish(scan.id, {
      health: {
        domain: 'long.example',
        months: [{ month: '202001', captures: 1, timestamp: TS, score: 90, verdict: 'good', reasons: [], probed: true }],
        lastGood: { month: '202001', timestamp: TS, score: 90, original: `${W}/` },
        window: {},
        host: 'www.long.example',
        probes: 1,
      },
    });
    scanId = scan.id;
  });
  after(async () => {
    server?.close();
    stop?.();
    proxy?.close();
    await archive?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const post = (p: string, form: Record<string, string>) =>
    fetch(base + p, { method: 'POST', redirect: 'manual', body: new URLSearchParams(form), headers: { origin: base } });
  const ended = (id: string) => until(`job ${id} to end`, () => (['done', 'failed'].includes(store.get(id)!.status) ? store.get(id) : undefined), 30_000);
  const fetches = (page: string) => proxy.log.filter((u) => u.includes('id_/') && u.endsWith(`/${page}`)).length;

  it('offers to try again, and continues from the downloads it has', async () => {
    const res = await post(`/job/${scanId}/restore`, { target: TS, mode: 'full' });
    assert.equal(res.status, 303);
    const id = res.headers.get('location')!.split('/')[2];
    const failed = await ended(id);
    assert.equal(failed!.status, 'failed');
    assert.match(failed!.error ?? '', /refused or failed the last \d+ downloads/);
    assert.equal(fetches('p5.html'), 1);

    const page = await (await fetch(`${base}/job/${id}/`)).text();
    assert.match(page, new RegExp(`<form method="post" action="/job/${id}/retry">`));
    assert.match(page, /Try again/);

    refusing = false;
    const retry = await post(`/job/${id}/retry`, {});
    assert.equal(retry.status, 303);
    assert.equal(retry.headers.get('location'), `/job/${id}/`);
    const done = await ended(id);
    assert.equal(done!.status, 'done', done!.error ?? '');
    assert.equal(done!.retries, 1);
    assert.equal(done!.error, null);
    // What the first run downloaded was not downloaded again, and the refused pages were.
    assert.equal(fetches('p5.html'), 1);
    assert.equal(fetches('p20.html'), 2);
    const manifest = JSON.parse(await readFile(path.join(dataDir, 'jobs', id, 'long.example', '.work', 'manifest.json'), 'utf8')) as { resources: unknown[] };
    assert.equal(manifest.resources.length, PAGES + 1);
    // Still one restore for the daily limit.
    assert.equal(store.countByIp('127.0.0.1', 24 * 3600_000, 'restore'), 1);
    assert.match(await (await fetch(`${base}/job/${id}/`)).text(), /The site is ready/);

    // A job that is not a failed restore is left alone.
    assert.equal((await post(`/job/${id}/retry`, {})).status, 303);
    assert.equal(store.get(id)?.status, 'done');
    assert.equal(store.get(id)?.retries, 1);
    assert.equal((await post(`/job/${scanId}/retry`, {})).status, 303);
    assert.equal(store.get(scanId)?.status, 'done');
  });

  it('lets a failed restore run again only a few times', () => {
    const job = store.create({ kind: 'restore', domain: 'other.example', target: TS, maxPages: 4 });
    assert.equal(store.retry(job.id), false);
    store.db.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(job.id);
    assert.equal(store.retry(job.id), false);
    for (let i = 0; i < MAX_RETRIES; i++) {
      store.fail(job.id, 'archive.org refused');
      assert.equal(store.retry(job.id), true);
      const again = store.get(job.id)!;
      assert.deepEqual([again.status, again.attempts, again.error, again.finished_at], ['queued', 0, null, null]);
    }
    store.fail(job.id, 'archive.org refused');
    assert.equal(store.retry(job.id), false);
    assert.equal(store.get(job.id)?.status, 'failed');
  });

  it('says when a restore has been run again as often as it can be', async () => {
    const job = store.create({ kind: 'restore', domain: 'long.example', target: TS, parentId: scanId });
    store.db.prepare(`UPDATE jobs SET status = 'failed', retries = ?, error = 'archive.org refused' WHERE id = ?`).run(MAX_RETRIES, job.id);
    const page = await (await fetch(`${base}/job/${job.id}/`)).text();
    assert.doesNotMatch(page, /\/retry"/);
    assert.match(page, new RegExp(`already been run again ${MAX_RETRIES} times`));
    assert.match(page, new RegExp(`href="/job/${scanId}/">Back to the snapshots`));
    store.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  });

  it('goes to the back of the line when it runs again', async () => {
    const local = new JobStore(':memory:');
    const failed = local.create({ kind: 'restore', domain: 'a.example', target: TS, ip: 'x' });
    local.fail(failed.id, 'archive.org refused');
    await sleep(3);
    const waiting = local.create({ kind: 'restore', domain: 'b.example', target: TS });
    await sleep(3);
    assert.equal(local.retry(failed.id), true);
    assert.equal(local.queuePosition(failed.id), 2);
    assert.equal(local.claim()?.id, waiting.id);
    assert.equal(local.claim()?.id, failed.id);
    // Still one restore for the daily limit.
    assert.equal(local.countByIp('x', DAY, 'restore'), 1);
    local.close();
  });

  // Last: it ends with the scan swept.
  it('keeps the snapshots while a restore made from them is kept, so trying again a week later uses them', async () => {
    refusing = true;
    const res = await post(`/job/${scanId}/restore`, { target: TS, mode: 'full' });
    const id = res.headers.get('location')!.split('/')[2];
    assert.equal((await ended(id))!.status, 'failed');
    // A week on, the scan is past the retention period; the failed restore, which ended later, not yet.
    store.db.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(Date.now() - 8 * DAY, scanId);
    await runner.sweep();
    assert.equal(store.get(scanId)?.status, 'done');
    const page = await (await fetch(`${base}/job/${id}/`)).text();
    assert.match(page, new RegExp(`action="/job/${id}/retry"`));
    assert.match(page, new RegExp(`href="/job/${scanId}/">Back to the snapshots`));

    refusing = false;
    assert.equal((await post(`/job/${id}/retry`, {})).status, 303);
    const done = await ended(id);
    assert.equal(done!.status, 'done', done!.error ?? '');
    // The healthy period came from the scan: the restore did not check the homepages again.
    assert.equal(existsSync(path.join(dataDir, 'jobs', id, 'long.example', '.work', 'health.json')), false);

    // Once its restores are past the retention period too, the scan goes in the same sweep.
    store.db.prepare('UPDATE jobs SET finished_at = ? WHERE parent_id = ?').run(Date.now() - 8 * DAY, scanId);
    await runner.sweep();
    assert.equal(store.get(id), undefined);
    assert.equal(store.get(scanId), undefined);
    assert.equal(existsSync(path.join(dataDir, 'jobs', id)), false);
  });
});

describe('a restore whose snapshot check is gone', () => {
  let dir: string;
  let archive: Awaited<ReturnType<typeof hangingArchive>>;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-web5-orphan-'));
    archive = await hangingArchive();
  });
  after(async () => {
    archive?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A scan that found a healthy period, and a restore made from it. */
  const scanAndRestore = (store: JobStore) => {
    const scan = store.create({ kind: 'scan', domain: 'gone.example' });
    store.finish(scan.id, { health: { domain: 'gone.example', months: [], lastGood: { month: '202001', timestamp: TS, score: 90, original: 'http://gone.example/' }, window: { to: '20200301000000' }, host: 'gone.example', probes: 1 } });
    const restore = store.create({ kind: 'restore', domain: 'gone.example', target: TS, parentId: scan.id });
    return { scan, restore };
  };

  it('is kept by the sweep together with its scan, and an old scan without restores is not', async () => {
    const store = new JobStore(':memory:');
    const runner = new JobRunner(store, dir, { workers: 1, retentionDays: 7, archive: { base: archive.base, minIntervalMs: 0 }, log: () => {} });
    const { scan, restore } = scanAndRestore(store);
    store.fail(restore.id, 'archive.org refused');
    const lone = store.create({ kind: 'scan', domain: 'lone.example' });
    store.finish(lone.id, { health: { domain: 'lone.example', months: [], window: {}, host: 'lone.example', probes: 0 } });
    await mkdir(runner.jobDir(restore.id), { recursive: true });
    await writeFile(path.join(runner.jobDir(restore.id), 'kept'), 'x');
    store.db.prepare('UPDATE jobs SET finished_at = ? WHERE id IN (?, ?)').run(Date.now() - 8 * DAY, scan.id, lone.id);
    store.db.prepare('UPDATE jobs SET finished_at = ? WHERE id = ?').run(Date.now() - 6 * DAY, restore.id);
    await runner.sweep();
    assert.equal(store.get(lone.id), undefined);
    assert.equal(store.get(scan.id)?.status, 'done');
    assert.equal(store.get(restore.id)?.status, 'failed');
    assert.equal(existsSync(path.join(runner.jobDir(restore.id), 'kept')), true);
    assert.equal(store.canRetry(restore.id), true);
    store.close();
  });

  it('is not run again: it fails at once instead of checking the homepages again', async () => {
    // A database swept before scans were kept: the server was down, the scan is gone, the restore
    // was running and is put back in the line when the server starts.
    const store = new JobStore(path.join(dir, 'orphan.sqlite'));
    const { scan, restore } = scanAndRestore(store);
    store.fail(restore.id, 'archive.org refused');
    store.db.prepare('DELETE FROM jobs WHERE id = ?').run(scan.id);
    assert.equal(store.canRetry(restore.id), false);
    assert.equal(store.retry(restore.id), false);
    store.db.prepare(`UPDATE jobs SET status = 'running', error = NULL, finished_at = NULL WHERE id = ?`).run(restore.id);
    const runner = new JobRunner(store, path.join(dir, 'orphan'), { workers: 1, retentionDays: 7, archive: { base: archive.base, minIntervalMs: 0 }, log: () => {} });
    runner.start();
    try {
      const failed = await until('the restore to end', () => (store.get(restore.id)?.status === 'failed' ? store.get(restore.id) : undefined));
      assert.equal(failed.error, scanGone('gone.example'));
      assert.equal(archive.seen(), 0);
      assert.equal(runner.processes.size, 0);
    } finally {
      runner.stop();
      store.close();
    }
  });

  it('offers to check the domain again instead of trying again', async () => {
    const dataDir = path.join(dir, 'web');
    const app = await createApp({ ...configFromEnv({}), dataDir, archiveBase: archive.base, accessCode: '' });
    const { scan, restore } = scanAndRestore(app.store);
    app.store.fail(restore.id, scanGone('gone.example'));
    app.store.db.prepare('DELETE FROM jobs WHERE id = ?').run(scan.id);
    const server = app.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await (await fetch(`${base}/job/${restore.id}/`)).text();
      assert.doesNotMatch(page, /\/retry"/);
      assert.doesNotMatch(page, /Back to the snapshots/);
      assert.match(page, /<form method="post" action="\/restore\/"><input type="hidden" name="domain" value="gone.example">/);
      const res = await fetch(`${base}/job/${restore.id}/retry`, { method: 'POST', redirect: 'manual', headers: { origin: base } });
      assert.equal(res.status, 303);
      assert.equal(app.store.get(restore.id)?.status, 'failed');
      assert.equal(app.store.get(restore.id)?.retries, 0);
    } finally {
      server.close();
      app.store.close();
    }
  });
});

describe('web app: a scan archive.org partly refused', () => {
  const W = 'http://www.oldbakery.example';
  const PARKED = String(OLD_BAKERY.find((c) => c.ts === '20210320101010')!.body);
  // Good 2018-2020 (three homepage captures), then parked.
  const caps: FakeCapture[] = OLD_BAKERY.filter((c) => c.url !== `${W}/` || (c.ts >= '20180101000000' && c.ts < '20201101000000'));
  for (const ts of ['20210320101010', '20210601101010', '20210915101010', '20211201101010', '20220310101010', '20220610101010', '20221010101010', '20230301101010', '20230801101010']) {
    caps.push({ url: `${W}/`, ts, body: PARKED });
  }
  const GOOD = /^\/web\/(20180815120000|20190920120000|20200406120000)id_\//;

  let archive: FakeArchive;
  let proxy: Awaited<ReturnType<typeof refusingProxy>>;
  let refuse: (url: string) => boolean = () => false;
  let dataDir: string;
  let server: Server;
  let base: string;
  let store: JobStore;
  let stop: () => void;

  before(async () => {
    archive = await startFakeArchive(caps);
    proxy = await refusingProxy(archive, (url) => refuse(url));
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wbd-web5-refused-'));
    const app = await createApp({ ...configFromEnv({}), dataDir, archiveBase: proxy.base, archiveDelayMs: 0, archiveBackoffMs: 5 });
    Object.assign(app.runner.opts.archive, { retries: 0 });
    store = app.store;
    app.runner.start();
    server = app.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => {
      app.runner.stop();
      store.close();
    };
  });
  after(async () => {
    server?.close();
    stop?.();
    proxy?.close();
    await archive?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const scan = async () => {
    const res = await fetch(`${base}/restore/`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ domain: 'oldbakery.example' }), headers: { origin: base } });
    assert.equal(res.status, 303);
    const id = res.headers.get('location')!.split('/')[2];
    const job = await until(`scan ${id} to end`, () => (['done', 'failed'].includes(store.get(id)!.status) ? store.get(id) : undefined), 30_000);
    return { id, job: job!, page: await (await fetch(`${base}/job/${id}/`)).text() };
  };
  const recheck = /<form method="post" action="\/restore\/"><input type="hidden" name="domain" value="oldbakery\.example"><button class="btn" type="submit">Check again<\/button><\/form>/;

  it('says archive.org refused captures instead of "nothing worth restoring", and is not reused', async () => {
    // archive.org fails exactly the good homepage captures: fewer than half of those checked.
    refuse = (url) => GOOD.test(url);
    const first = await scan();
    assert.equal(first.job.status, 'done');
    assert.equal(JSON.parse(first.job.result!).health.lastGood, undefined);
    assert.doesNotMatch(first.page, /nothing worth restoring/);
    assert.match(first.page, /archive\.org refused 3 of the \d+ captures we asked for \(HTTP 503\)/);
    assert.match(first.page, recheck);

    // archive.org plays them back again: asking again gets a new scan, which finds the site.
    refuse = () => false;
    const second = await scan();
    assert.notEqual(second.id, first.id);
    assert.equal(second.job.status, 'done');
    assert.equal(JSON.parse(second.job.result!).health.lastGood?.timestamp, '20200406120000');
    // A scan that found the site is reused as before.
    const third = await scan();
    assert.equal(third.id, second.id);
  });

  it('offers to check again after a scan archive.org refused', async () => {
    store.db.prepare(`DELETE FROM jobs`).run();
    refuse = (url) => /^\/web\/\d{14}id_\//.test(url);
    const failed = await scan();
    assert.equal(failed.job.status, 'failed');
    assert.match(failed.job.error ?? '', /archive\.org refused or failed/);
    assert.match(failed.page, recheck);
    refuse = () => false;
  });
});

describe('deploy files', () => {
  it('checks a new container every few seconds until it is healthy', async () => {
    const dockerfile = await readFile(path.join(ROOT, 'Dockerfile'), 'utf8');
    const line = dockerfile.split('\n').find((l) => l.startsWith('HEALTHCHECK '))!;
    // Traefik sends no traffic to a container until it is healthy: without these the first check
    // comes after the full interval, and the site is down that long after every start.
    assert.match(line, /--start-period=\d+s/);
    const interval = /--start-interval=(\d+)s/.exec(line);
    assert.ok(interval && Number(interval[1]) <= 5, line);
  });

  it('passes every setting an operator may change from .env into the container', async () => {
    const compose = await readFile(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const example = await readFile(path.join(ROOT, '.env.example'), 'utf8');
    const server = await readFile(path.join(ROOT, 'src', 'web', 'server.ts'), 'utf8');
    // Set by the image (paths, port) or only for tests: not for the operator.
    const internal = new Set(['WBD_DATA', 'WBD_CONTENT', 'WBD_THEME', 'WBD_ARCHIVE', 'WBD_SITE_URL']);
    const read = [...new Set([...server.matchAll(/env\.(WBD_[A-Z_]+)/g)].map((m) => m[1]))].filter((v) => !internal.has(v));
    assert.ok(read.includes('WBD_SCAN_LIMIT') && read.includes('WBD_RESTORE_LIMIT'), read.join(' '));
    const defaults = configFromEnv({});
    const key: Record<string, keyof typeof defaults> = {
      WBD_ACCESS_CODE: 'accessCode',
      WBD_WORKERS: 'workers',
      WBD_RETENTION_DAYS: 'retentionDays',
      WBD_SCAN_LIMIT: 'scanLimit',
      WBD_RESTORE_LIMIT: 'restoreLimit',
    };
    for (const name of read) {
      const m = new RegExp(`^\\s+${name}: \\$\\{${name}:-([^}]*)\\}$`, 'm').exec(compose);
      assert.ok(m, `docker-compose.yml does not pass ${name}`);
      assert.equal(m[1], String(defaults[key[name]]), name);
      assert.match(example, new RegExp(`^${name}=`, 'm'), `.env.example does not list ${name}`);
    }
    // docker stop's SIGTERM reaches the server, which puts running jobs back before it exits.
    assert.match(compose, /^\s+init: true$/m);
  });
});
