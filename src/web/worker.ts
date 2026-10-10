// Runs queued jobs in the background, a few at a time (archive.org punishes anything faster),
// and deletes finished jobs after the retention period. Each job runs in its own child process
// (this file, forked), so a job that eats the CPU, hangs or crashes cannot freeze or take down
// the web server. A job whose process dies or stops responding is retried up to MAX_ATTEMPTS times.

import { fork, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ArchiveClient, type ArchiveOptions } from '../engine/archive.ts';
import { scanHealth, type HealthReport } from '../engine/health.ts';
import type { RestoreReport } from '../engine/report.ts';
import { restore } from '../engine/restore.ts';
import type { Job, JobStore } from './db.ts';

export interface ScanResult {
  health: HealthReport;
}

export interface RestoreJobResult {
  report: RestoreReport;
  /** Paths relative to the job folder. */
  zip?: string;
  reportHtml: string;
}

export interface RunnerOptions {
  workers: number;
  archive: ArchiveOptions;
  retentionDays: number;
  /** A job process that sends nothing for this long is hung (its event loop is blocked) and is killed. Default 10 minutes. */
  stallMs?: number;
  log?: (msg: string) => void;
}

/** What the server sends to a job process. */
interface JobInput {
  job: Pick<Job, 'id' | 'kind' | 'domain' | 'target' | 'max_pages'>;
  dir: string;
  health?: HealthReport;
  archive: ArchiveOptions;
  heartbeatMs: number;
}

/** What a job process sends back. */
type JobMessage =
  | { type: 'alive' }
  | { type: 'progress'; phase: string; message: string; done?: number; queued?: number }
  | { type: 'done'; result: ScanResult | RestoreJobResult }
  | { type: 'error'; message: string; stack?: string };

export class JobRunner {
  readonly store: JobStore;
  readonly dataDir: string;
  readonly opts: RunnerOptions;
  #running = 0;
  #stopped = false;
  #processes = new Map<string, ChildProcess>();
  #timers: NodeJS.Timeout[] = [];

  constructor(store: JobStore, dataDir: string, opts: RunnerOptions) {
    this.store = store;
    this.dataDir = dataDir;
    this.opts = opts;
  }

  jobDir(id: string): string {
    return path.join(this.dataDir, 'jobs', id);
  }

  start(): void {
    this.#stopped = false;
    const { requeued, failed } = this.store.requeueRunning();
    if (requeued) this.opts.log?.(`requeued ${requeued} interrupted job(s)`);
    if (failed) this.opts.log?.(`gave up on ${failed} job(s) interrupted too often`);
    this.#timers.push(setInterval(() => this.tick(), 1000));
    this.#timers.push(setInterval(() => void this.sweep(), 60 * 60 * 1000));
    void this.sweep();
    this.tick();
  }

  /** Stops claiming jobs and kills running job processes; their jobs are requeued on the next start. */
  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const child of this.#processes.values()) child.kill('SIGKILL');
  }

  get running(): number {
    return this.#running;
  }

  /** The process of each running job, by job id. */
  get processes(): ReadonlyMap<string, ChildProcess> {
    return this.#processes;
  }

  tick(): void {
    while (!this.#stopped && this.#running < this.opts.workers) {
      const job = this.store.claim();
      if (!job) return;
      this.#running++;
      void this.run(job).finally(() => {
        this.#running--;
        this.tick();
      });
    }
  }

  /** Runs one job in a child process and records how it ended. */
  run(job: Job): Promise<void> {
    const parent = job.kind === 'restore' && job.parent_id ? this.store.get(job.parent_id) : undefined;
    const stallMs = this.opts.stallMs ?? 10 * 60_000;
    const input: JobInput = {
      job: { id: job.id, kind: job.kind, domain: job.domain, target: job.target, max_pages: job.max_pages },
      dir: this.jobDir(job.id),
      health: parent?.result ? (JSON.parse(parent.result) as ScanResult).health : undefined,
      archive: this.opts.archive,
      heartbeatMs: Math.max(50, Math.min(5000, Math.floor(stallMs / 4))),
    };

    return new Promise((resolve) => {
      const child = fork(import.meta.filename, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      this.#processes.set(job.id, child);
      let ended = false;
      let stalled = false;
      let watchdog: NodeJS.Timeout | undefined;
      const alive = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          stalled = true;
          child.kill('SIGKILL');
        }, stallMs);
      };
      alive();

      child.on('message', (m: JobMessage) => {
        alive();
        if (this.#stopped || ended) return;
        if (m.type === 'progress') {
          this.store.progress(job.id, { phase: m.phase, message: m.message, done: m.done, queued: m.queued });
        } else if (m.type === 'done') {
          ended = true;
          this.store.finish(job.id, m.result);
        } else if (m.type === 'error') {
          ended = true;
          this.opts.log?.(`job ${job.id} (${job.kind} ${job.domain}) failed: ${m.stack ?? m.message}`);
          this.store.fail(job.id, m.message);
        }
      });
      // 'close' comes after the process exited and after every message it sent.
      const closed = (why?: string) => {
        clearTimeout(watchdog);
        if (this.#processes.get(job.id) === child) this.#processes.delete(job.id);
        if (!this.#stopped && !ended) {
          ended = true;
          const reason = stalled ? 'the job stopped responding' : `the job process stopped unexpectedly (${why})`;
          const now = this.store.interrupted(job.id, reason);
          this.opts.log?.(`job ${job.id} (${job.kind} ${job.domain}): ${reason}; ${now === 'queued' ? 'will retry' : 'giving up'}`);
        }
        resolve();
      };
      child.once('close', (code, signal) => closed(signal ?? `exit code ${code}`));
      child.once('error', (err) => {
        // Only when the process could not be started or signalled; 'close' may then never come.
        if (child.exitCode === null && child.signalCode === null && !child.pid) closed(err.message);
      });
      child.send(input);
    });
  }

  async sweep(): Promise<void> {
    const cutoff = Date.now() - this.opts.retentionDays * 86_400_000;
    for (const job of this.store.finishedBefore(cutoff)) {
      await rm(this.jobDir(job.id), { recursive: true, force: true });
      this.store.delete(job.id);
    }
  }
}

/** The work of one job, inside its child process. */
async function execute(input: JobInput, send: (m: JobMessage) => void): Promise<ScanResult | RestoreJobResult> {
  const { job, dir } = input;
  let lastWrite = 0;
  let lastPhase = '';
  const progress = (phase: string, message: string, done?: number, queued?: number) => {
    const now = Date.now();
    if (phase === lastPhase && now - lastWrite < 1000) return;
    lastWrite = now;
    lastPhase = phase;
    send({ type: 'progress', phase, message: message.slice(0, 300), done, queued });
  };

  if (job.kind === 'scan') {
    progress('health', `checking how ${job.domain} looked over the years`);
    const client = new ArchiveClient({ ...input.archive, log: (m) => progress('health', m) });
    const health = await scanHealth(client, job.domain, { log: (m) => progress('health', m) });
    return { health } satisfies ScanResult;
  }

  const result = await restore({
    domain: job.domain,
    outDir: dir,
    target: job.target ?? undefined,
    maxPages: job.max_pages ?? undefined,
    health: input.health,
    archive: input.archive,
    onEvent: (e) => progress(e.phase, e.message, e.done, e.queued),
  });
  return {
    report: result.report,
    zip: result.zipFile ? path.relative(dir, result.zipFile) : undefined,
    reportHtml: path.relative(dir, path.join(result.jobDir, 'report.html')),
  } satisfies RestoreJobResult;
}

if (process.argv[1] === import.meta.filename && process.send) {
  const send = (m: JobMessage) => new Promise<void>((resolve) => process.send!(m, undefined, {}, () => resolve()));
  // Without the server nobody records the result, and the restarted server runs the job again.
  process.on('disconnect', () => process.exit(1));
  process.once('message', async (input: JobInput) => {
    const heartbeat = setInterval(() => void send({ type: 'alive' }), input.heartbeatMs);
    let last: JobMessage;
    try {
      last = { type: 'done', result: await execute(input, (m) => void send(m)) };
    } catch (err) {
      last = { type: 'error', message: (err as Error).message ?? String(err), stack: (err as Error).stack };
    }
    clearInterval(heartbeat);
    await send(last);
    process.exit(0);
  });
}
