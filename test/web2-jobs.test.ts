// Jobs that end early: a cancelled or failed job stops every archive request it made, users see
// a message without server paths, and a demo job asks restore() for a demo's limits itself.

import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { JobStore } from '../src/web/db.ts';
import { JOB_FAILED, JobRunner, publicError, redactPaths, restoreOptions, type JobInput } from '../src/web/worker.ts';
import { startFakeArchive, type FakeCapture } from './fake-archive.ts';

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

describe('job errors shown to users', () => {
  it('keeps the engine messages and drops server paths', () => {
    assert.equal(publicError(new Error('The Wayback Machine has no captures of nothing.example.')), 'The Wayback Machine has no captures of nothing.example.');
    const disk = Object.assign(new Error("ENOSPC: no space left on device, write '/data/jobs/abc/x.example/.work/manifest.json.tmp'"), { code: 'ENOSPC' });
    assert.equal(publicError(disk), JOB_FAILED);
    assert.equal(publicError(new TypeError("Cannot read properties of undefined (reading 'x')")), JOB_FAILED);
    assert.equal(publicError(new DOMException('This operation was aborted', 'AbortError')), JOB_FAILED);
    assert.equal(publicError('a string'), JOB_FAILED);
    assert.equal(publicError(new Error('')), JOB_FAILED);
    // An engine message that quotes another error keeps its text but not the path.
    assert.equal(
      publicError(new Error("Nothing could be downloaded: archive.org refused or failed every request (EACCES: permission denied, open '/home/app/data/jobs/abc/x.example/.work/raw/12')")),
      "Nothing could be downloaded: archive.org refused or failed every request (EACCES: permission denied, open '12')",
    );
  });

  it('removes file paths but leaves web addresses alone', () => {
    assert.equal(
      redactPaths("could not save progress: ENOENT: no such file or directory, rename '/data/jobs/a/b.example/.work/manifest.json.tmp' -> '/data/jobs/a/b.example/.work/manifest.json'"),
      "could not save progress: ENOENT: no such file or directory, rename 'manifest.json.tmp' -> 'manifest.json'",
    );
    assert.equal(redactPaths('open /var/lib/wbd/jobs/x/ failed'), 'open … failed');
    for (const keep of ['http://www.example.com/blog/2019/05/rye-bread', 'request failed (fetch failed); retrying in 2s', 'https://x.example/a/b.html?q=/c/d', 'HTTP 503']) {
      assert.equal(redactPaths(keep), keep);
    }
  });
});

describe('restore options for a job', () => {
  const input = (maxPages: number | null): JobInput => ({
    type: 'start',
    job: { id: 'j', kind: 'restore', domain: 'demo.example', target: '20200101000000', max_pages: maxPages },
    dir: '/tmp/x',
    archive: { base: 'http://127.0.0.1:9', minIntervalMs: 0 },
    heartbeatMs: 1000,
  });

  it('gives a demo no unlinked files and few URLs, and every job the abort signal', () => {
    const signal = new AbortController().signal;
    const demo = restoreOptions(input(4), signal);
    assert.equal(demo.maxPages, 4);
    assert.equal(demo.orphans, false);
    assert.equal(demo.maxUrls, 200);
    assert.equal(demo.archive?.signal, signal);
    assert.equal(demo.archive?.base, 'http://127.0.0.1:9');

    const full = restoreOptions(input(null), signal);
    assert.equal(full.maxPages, undefined);
    assert.equal(full.orphans, undefined);
    assert.equal(full.maxUrls, undefined);
    assert.equal(full.archive?.signal, signal);
  });
});

describe('job runner: jobs that end early', () => {
  let dir: string;
  let hang: http.Server;
  let hangBase: string;
  let open = 0;
  let seen = 0;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-web2-jobs-'));
    // An archive that never answers: a job stays busy on its first request.
    hang = http.createServer((req) => {
      open++;
      seen++;
      req.socket.once('close', () => open--);
    });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    hangBase = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
  });
  after(async () => {
    hang?.closeAllConnections();
    hang?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const setup = (name: string, base: string, workers = 1) => {
    const store = new JobStore(path.join(dir, `${name}.sqlite`));
    const logs: string[] = [];
    const runner = new JobRunner(store, path.join(dir, name), {
      workers,
      retentionDays: 7,
      archive: { base, minIntervalMs: 0, backoffMs: 5, retries: 0 },
      log: (m) => logs.push(m),
    });
    return { store, runner, logs };
  };

  it('cancels running jobs: their processes abort the requests and exit by themselves', async () => {
    const { store, runner } = setup('cancel', hangBase, 2);
    const scan = store.create({ kind: 'scan', domain: 'scan.example' });
    const restore = store.create({ kind: 'restore', domain: 'restore.example', maxPages: 4 });
    runner.start();
    try {
      const exits = new Map<string, Promise<{ code: number | null; signal: string | null }>>();
      for (const job of [scan, restore]) {
        const child = await until(`a process for ${job.domain}`, () => runner.processes.get(job.id));
        exits.set(job.id, new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))));
      }
      await until('both jobs to wait on the archive', () => open >= 2);

      const started = Date.now();
      assert.equal(runner.cancel(scan.id), true);
      assert.equal(runner.cancel(restore.id, 'Stopped by the operator.'), true);
      for (const job of [scan, restore]) {
        // Exit code 0: the process stopped on its own, well before it would have been killed.
        assert.deepEqual(await exits.get(job.id), { code: 0, signal: null });
      }
      assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
      await until('the archive connections to close', () => open === 0, 5000);
      assert.equal(store.get(scan.id)?.status, 'failed');
      assert.equal(store.get(scan.id)?.error, 'The job was cancelled.');
      assert.equal(store.get(restore.id)?.error, 'Stopped by the operator.');
      await until('the worker slots to be free', () => runner.running === 0 && runner.processes.size === 0);
      // A cancelled job is not requeued.
      const before = seen;
      await sleep(300);
      assert.equal(seen, before);
      assert.equal(store.get(scan.id)?.status, 'failed');
    } finally {
      runner.stop();
      store.close();
    }
  });

  it('cancels a queued job, and nothing that has ended', async () => {
    const { store, runner } = setup('cancel-queued', hangBase);
    const queued = store.create({ kind: 'scan', domain: 'queued.example' });
    assert.equal(runner.cancel(queued.id), true);
    assert.equal(store.get(queued.id)?.status, 'failed');
    assert.equal(runner.cancel(queued.id), false);
    assert.equal(runner.cancel('no-such-job-0000'), false);
    // The runner does not pick it up any more.
    runner.start();
    try {
      await sleep(300);
      assert.equal(runner.processes.size, 0);
    } finally {
      runner.stop();
      store.close();
    }
  });

  it('shows a generic message for a system error and logs the full one', async () => {
    const archive = await startFakeArchive([{ url: 'http://broken.example/', ts: '20200101000000', body: '<p>hi</p>' }]);
    const { store, runner, logs } = setup('syserror', archive.base);
    const job = store.create({ kind: 'restore', domain: 'broken.example', target: '20200101000000', maxPages: 4 });
    // A file where the job folder should be: creating the work folder fails with the full path.
    await mkdir(path.join(dir, 'syserror', 'jobs'), { recursive: true });
    await writeFile(runner.jobDir(job.id), 'not a folder');
    runner.start();
    try {
      const failed = await until('the job to fail', () => (store.get(job.id)?.status === 'failed' ? store.get(job.id) : undefined));
      assert.equal(failed!.error, JOB_FAILED);
      assert.ok(!failed!.error!.includes(dir));
      const logged = logs.find((l) => l.includes(job.id) && l.includes('failed'));
      assert.ok(logged?.includes(runner.jobDir(job.id)), `log: ${logs.join('\n')}`);
    } finally {
      runner.stop();
      store.close();
      await archive.close();
    }
  });

  it('keeps the message of an engine error', async () => {
    const archive = await startFakeArchive([]);
    const { store, runner } = setup('engine-error', archive.base);
    const job = store.create({ kind: 'restore', domain: 'nothing.example', maxPages: 4 });
    runner.start();
    try {
      const failed = await until('the job to fail', () => (store.get(job.id)?.status === 'failed' ? store.get(job.id) : undefined));
      assert.equal(failed!.error, 'The Wayback Machine has no captures of nothing.example.');
    } finally {
      runner.stop();
      store.close();
      await archive.close();
    }
  });

  it('stops every request of a restore that failed', async () => {
    const TS = '20200101000000';
    const caps: FakeCapture[] = [{ url: 'http://busy.example/', ts: TS, body: '<html><body><p>home</p></body></html>' }];
    for (let i = 0; i < 300; i++) caps.push({ url: `http://busy.example/p${i}.html`, ts: TS, body: `<p>${i}</p>` });
    const archive = await startFakeArchive(caps);
    const { store, runner } = setup('failed', archive.base);
    const health = { domain: 'busy.example', months: [], window: {}, host: 'busy.example', probes: 0 };
    const scan = store.create({ kind: 'scan', domain: 'busy.example' });
    store.claim();
    store.finish(scan.id, { health });
    // Every download is refused: the crawl gives up after a streak of failures.
    archive.failNext(503, 1_000_000);
    const job = store.create({ kind: 'restore', domain: 'busy.example', target: TS, parentId: scan.id });
    runner.start();
    try {
      const failed = await until('the job to fail', () => (store.get(job.id)?.status === 'failed' ? store.get(job.id) : undefined));
      assert.match(failed!.error ?? '', /archive\.org refused or failed the last \d+ downloads/);
      await until('the job process to end', () => runner.processes.size === 0);
      const atEnd = archive.requests.length;
      await sleep(1000);
      assert.equal(archive.requests.length, atEnd);
    } finally {
      runner.stop();
      store.close();
      await archive.close();
    }
  });

  it('downloads only linked files for a demo', async () => {
    const TS = '20200101000000';
    const links = Array.from({ length: 6 }, (_, i) => `<a href="/page${i}.html">page ${i}</a>`).join(' ');
    const caps: FakeCapture[] = [{ url: 'http://demo.example/', ts: TS, body: `<html><head><title>Home</title></head><body>${links}</body></html>` }];
    for (let i = 0; i < 6; i++) caps.push({ url: `http://demo.example/page${i}.html`, ts: TS, body: `<html><body><p>page ${i}</p></body></html>` });
    // Unlinked files, and linked-looking pages the index lists as revisits.
    for (let i = 0; i < 40; i++) caps.push({ url: `http://demo.example/files/doc${i}.pdf`, ts: TS, type: 'application/pdf', body: Buffer.alloc(500, 65) });
    for (let i = 0; i < 10; i++) caps.push({ url: `http://demo.example/old${i}.html`, ts: TS, revisit: true, body: `<p>old ${i}</p>` });
    const archive = await startFakeArchive(caps);
    const { store, runner } = setup('demo', archive.base);
    const job = store.create({ kind: 'restore', domain: 'demo.example', target: TS, maxPages: 4 });
    runner.start();
    try {
      const done = await until('the demo to finish', () => (['done', 'failed'].includes(store.get(job.id)!.status) ? store.get(job.id) : undefined), 30_000);
      assert.equal(done!.status, 'done', done!.error ?? '');
      const manifest = JSON.parse(await readFile(path.join(runner.jobDir(job.id), 'demo.example', '.work', 'manifest.json'), 'utf8')) as { resources: { url: string }[] };
      const urls = manifest.resources.map((r) => r.url);
      assert.ok(urls.length <= 4, urls.join(' '));
      assert.ok(!urls.some((u) => /\.pdf$|\/old\d/.test(u)), urls.join(' '));
      assert.ok(!archive.requests.some((r) => /\/files\/doc|\/old\d/.test(r) && r.startsWith('/web/')));
    } finally {
      runner.stop();
      store.close();
      await archive.close();
    }
  });
});
