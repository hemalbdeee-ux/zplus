// The job queue: a job that crashes or hangs runs in its own process, so the server keeps
// serving, and it is tried at most MAX_ATTEMPTS times instead of looping forever.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { JobStore, MAX_ATTEMPTS, type Job } from '../src/web/db.ts';
import { JobRunner } from '../src/web/worker.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe('job store', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-jobs-'));
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('requeues an interrupted job once, then gives up on it', () => {
    const store = new JobStore(path.join(dir, 'a.sqlite'));
    const job = store.create({ kind: 'scan', domain: 'poison.example' });
    const other = store.create({ kind: 'scan', domain: 'healthy.example' });

    assert.equal(store.claim()?.id, job.id);
    assert.deepEqual(store.requeueRunning(), { requeued: 1, failed: 0 });
    assert.equal(store.get(job.id)?.status, 'queued');

    const again = store.claim()!;
    assert.equal(again.id, job.id);
    assert.equal(again.attempts, MAX_ATTEMPTS);
    assert.deepEqual(store.requeueRunning(), { requeued: 0, failed: 1 });
    const failed = store.get(job.id)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /Stopped after 2 attempts: the server restarted/);
    assert.ok(failed.finished_at);

    // The queue moves on.
    assert.equal(store.claim()?.id, other.id);
    store.close();
  });

  it('adds the attempts column to a database made before it existed', () => {
    const file = path.join(dir, 'old.sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, domain TEXT NOT NULL, target TEXT, max_pages INTEGER,
      parent_id TEXT, status TEXT NOT NULL DEFAULT 'queued', phase TEXT, message TEXT, done INTEGER NOT NULL DEFAULT 0,
      queued INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, ip TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      finished_at INTEGER)`);
    old.prepare(`INSERT INTO jobs (id, kind, domain, status, created_at, updated_at) VALUES ('j1', 'scan', 'old.example', 'running', 1, 1)`).run();
    old.close();

    const store = new JobStore(file);
    assert.deepEqual(store.requeueRunning(), { requeued: 1, failed: 0 });
    assert.equal(store.claim()?.attempts, 1);
    store.close();
  });

  it('counts wrong access codes per address', () => {
    const store = new JobStore(path.join(dir, 'c.sqlite'));
    store.recordCodeFailure('10.0.0.1');
    store.recordCodeFailure('10.0.0.1');
    assert.equal(store.codeFailures('10.0.0.1', 3600_000), 2);
    assert.equal(store.codeFailures('10.0.0.2', 3600_000), 0);
    store.close();
  });
});

describe('job runner', () => {
  let dir: string;
  let archive: http.Server;
  let archiveBase: string;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-runner-'));
    // An archive that never answers keeps a job busy until the test interferes.
    archive = http.createServer(() => {});
    archive.listen(0, '127.0.0.1');
    await new Promise((r) => archive.once('listening', r));
    archiveBase = `http://127.0.0.1:${(archive.address() as AddressInfo).port}`;
  });
  after(async () => {
    archive?.closeAllConnections();
    archive?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const setup = (name: string, stallMs?: number) => {
    const store = new JobStore(path.join(dir, `${name}.sqlite`));
    const runner = new JobRunner(store, path.join(dir, name), { workers: 1, retentionDays: 7, archive: { base: archiveBase, minIntervalMs: 0 }, stallMs, log: () => {} });
    const pidOf = (id: string, not?: number) => until(`a process for ${id}`, () => {
      const pid = runner.processes.get(id)?.pid;
      return pid !== undefined && pid !== not ? pid : undefined;
    });
    return { store, runner, pidOf };
  };

  it('keeps the server alive when a job process crashes, and stops retrying it', async () => {
    const { store, runner, pidOf } = setup('crash');
    const poison = store.create({ kind: 'scan', domain: 'poison.example' });
    const next = store.create({ kind: 'scan', domain: 'next.example' });
    runner.start();
    try {
      const first = await pidOf(poison.id);
      process.kill(first, 'SIGKILL');
      const second = await pidOf(poison.id, first);
      assert.equal(store.get(poison.id)?.attempts, 2);
      process.kill(second, 'SIGKILL');

      const failed = await until('the job to fail', () => (store.get(poison.id)?.status === 'failed' ? store.get(poison.id) : undefined));
      assert.match(failed!.error ?? '', /Stopped after 2 attempts: the job process stopped unexpectedly \(SIGKILL\)/);
      // The job behind it is not starved.
      await until('the next job to start', () => store.get(next.id)?.status === 'running');
    } finally {
      runner.stop();
      store.close();
    }
  });

  it('kills a job whose process stops responding', async () => {
    const { store, runner, pidOf } = setup('hang', 1500);
    const job = store.create({ kind: 'scan', domain: 'hang.example' });
    runner.start();
    try {
      // A stopped process sends no heartbeat, like one stuck in a CPU loop.
      const first = await pidOf(job.id);
      process.kill(first, 'SIGSTOP');
      const second = await pidOf(job.id, first);
      process.kill(second, 'SIGSTOP');

      const failed = await until('the job to fail', () => (store.get(job.id)?.status === 'failed' ? (store.get(job.id) as Job) : undefined));
      assert.match(failed.error ?? '', /Stopped after 2 attempts: the job stopped responding/);
      await until('the worker slot to be free', () => runner.running === 0 && runner.processes.size === 0);
    } finally {
      runner.stop();
      store.close();
    }
  });
});
