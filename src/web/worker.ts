// Runs queued jobs in the background, a few at a time (archive.org punishes anything faster),
// and deletes finished jobs after the retention period. Each job runs in its own child process
// (this file, forked), so a job that eats the CPU, hangs or crashes cannot freeze or take down
// the web server. A job whose process dies or stops responding is retried up to MAX_ATTEMPTS times.
// A job that fails or is cancelled aborts every archive request it still has open.

import { fork, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ArchiveClient, type ArchiveOptions } from '../engine/archive.ts';
import { scanHealth, type HealthReport } from '../engine/health.ts';
import type { RestoreReport } from '../engine/report.ts';
import { restore, type RestoreOptions } from '../engine/restore.ts';
import type { Job, JobStore } from './db.ts';

/** What a user is told when a job fails for a reason that is not theirs to fix. */
export const JOB_FAILED = 'Something went wrong on our side while running this job. Please try again later.';
/** A demo is the homepage and the pages it links to, so it needs few URLs and no unlinked files. */
const DEMO_MAX_URLS = 200;
/** How long a cancelled or failed job's process has to stop on its own before it is killed. */
const ABORT_GRACE_MS = 5000;

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

/** What the server sends to a job process: the job, then maybe a request to stop it. */
export interface JobInput {
  type: 'start';
  job: Pick<Job, 'id' | 'kind' | 'domain' | 'target' | 'max_pages'>;
  dir: string;
  health?: HealthReport;
  archive: ArchiveOptions;
  heartbeatMs: number;
}
type ToJob = JobInput | { type: 'abort' };

/** What a job process sends back. `message` is for the user, `detail` only for the server log. */
type JobMessage =
  | { type: 'alive' }
  | { type: 'progress'; phase: string; message: string; done?: number; queued?: number }
  | { type: 'done'; result: ScanResult | RestoreJobResult }
  | { type: 'error'; message: string; detail?: string };

// An absolute file path in a message ('/data/jobs/x/site/a.html'): only its last part is shown. A
// URL does not match, as its slashes follow "http:" or another slash.
const FILE_PATH = /(^|[\s'"`(])\/[^\s'"`)]*\/([^\s'"`)/]*)/g;

/** Removes server paths from text that users see. */
export function redactPaths(text: string): string {
  return text.replace(FILE_PATH, (_m, pre: string, name: string) => pre + (name || '…'));
}

/**
 * The message a user sees for a failed job. The engine's own errors explain what happened and are
 * kept; a system error (disk, network), an abort or a bug says nothing useful to the user and can
 * carry server paths, so it is only logged.
 */
export function publicError(err: unknown): string {
  if (!(err instanceof Error) || Object.getPrototypeOf(err) !== Error.prototype || 'code' in err || 'errno' in err || 'syscall' in err) return JOB_FAILED;
  const message = redactPaths(err.message).trim();
  return message ? message.slice(0, 500) : JOB_FAILED;
}

/** restore() options for a job. A demo also gets its limits here, whatever restore() would default to. */
export function restoreOptions(input: JobInput, signal: AbortSignal, onEvent?: RestoreOptions['onEvent']): RestoreOptions {
  const { job, dir } = input;
  const demo = job.max_pages !== null;
  return {
    domain: job.domain,
    outDir: dir,
    target: job.target ?? undefined,
    maxPages: job.max_pages ?? undefined,
    ...(demo ? { orphans: false, maxUrls: DEMO_MAX_URLS } : {}),
    health: input.health,
    archive: { ...input.archive, signal },
    onEvent,
  };
}

export class JobRunner {
  readonly store: JobStore;
  readonly dataDir: string;
  readonly opts: RunnerOptions;
  #running = 0;
  #stopped = false;
  #processes = new Map<string, ChildProcess>();
  #aborts = new Map<string, AbortController>();
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

  /**
   * Stops a job and marks it failed. A running job's process aborts its archive requests and exits;
   * one that does not is killed. False when the job is neither queued nor running.
   */
  cancel(id: string, reason = 'The job was cancelled.'): boolean {
    const status = this.store.get(id)?.status;
    const running = this.#aborts.get(id);
    if (status === 'running' && running && !running.signal.aborted) {
      running.abort(reason);
      return true;
    }
    if (status !== 'queued') return false;
    this.store.fail(id, reason);
    return true;
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
      type: 'start',
      job: { id: job.id, kind: job.kind, domain: job.domain, target: job.target, max_pages: job.max_pages },
      dir: this.jobDir(job.id),
      health: parent?.result ? (JSON.parse(parent.result) as ScanResult).health : undefined,
      archive: this.opts.archive,
      heartbeatMs: Math.max(50, Math.min(5000, Math.floor(stallMs / 4))),
    };

    return new Promise((resolve) => {
      const child = fork(import.meta.filename, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      const controller = new AbortController();
      this.#processes.set(job.id, child);
      this.#aborts.set(job.id, controller);
      let ended = false;
      let stalled = false;
      let watchdog: NodeJS.Timeout | undefined;
      let killer: NodeJS.Timeout | undefined;
      // Cancelled or failed: nothing of the job may keep running. The process aborts its requests
      // and exits; if it does not, it is killed.
      controller.signal.addEventListener(
        'abort',
        () => {
          if (!ended) {
            ended = true;
            this.store.fail(job.id, String(controller.signal.reason));
          }
          if (child.exitCode !== null || child.signalCode !== null) return;
          if (child.connected) child.send({ type: 'abort' } satisfies ToJob, () => {});
          killer = setTimeout(() => child.kill('SIGKILL'), ABORT_GRACE_MS);
        },
        { once: true },
      );
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
          // The full error can name server paths: it goes to the log, the user gets the short message.
          this.opts.log?.(`job ${job.id} (${job.kind} ${job.domain}) failed: ${m.detail ?? m.message}`);
          this.store.fail(job.id, m.message);
          controller.abort();
        }
      });
      // 'close' comes after the process exited and after every message it sent.
      const closed = (why?: string) => {
        clearTimeout(watchdog);
        clearTimeout(killer);
        if (this.#processes.get(job.id) === child) this.#processes.delete(job.id);
        if (this.#aborts.get(job.id) === controller) this.#aborts.delete(job.id);
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

/** The work of one job, inside its child process. Every archive request ends when `signal` aborts. */
async function execute(input: JobInput, send: (m: JobMessage) => void, signal: AbortSignal): Promise<ScanResult | RestoreJobResult> {
  const { job, dir } = input;
  let lastWrite = 0;
  let lastPhase = '';
  const progress = (phase: string, message: string, done?: number, queued?: number) => {
    const now = Date.now();
    if (phase === lastPhase && now - lastWrite < 1000) return;
    lastWrite = now;
    lastPhase = phase;
    send({ type: 'progress', phase, message: redactPaths(message).slice(0, 300), done, queued });
  };

  if (job.kind === 'scan') {
    progress('health', `checking how ${job.domain} looked over the years`);
    const client = new ArchiveClient({ ...input.archive, signal, log: (m) => progress('health', m) });
    const health = await scanHealth(client, job.domain, { log: (m) => progress('health', m) });
    return { health } satisfies ScanResult;
  }

  const result = await restore(restoreOptions(input, signal, (e) => progress(e.phase, e.message, e.done, e.queued)));
  return {
    report: result.report,
    zip: result.zipFile ? path.relative(dir, result.zipFile) : undefined,
    reportHtml: path.relative(dir, path.join(result.jobDir, 'report.html')),
  } satisfies RestoreJobResult;
}

if (process.argv[1] === import.meta.filename && process.send) {
  const send = (m: JobMessage) => new Promise<void>((resolve) => process.send!(m, undefined, {}, () => resolve()));
  const controller = new AbortController();
  let started = false;
  // Without the server nobody records the result, and the restarted server runs the job again.
  process.on('disconnect', () => process.exit(1));
  process.on('message', async (m: ToJob) => {
    if (m.type === 'abort') return controller.abort();
    if (started) return;
    started = true;
    const heartbeat = setInterval(() => void send({ type: 'alive' }), m.heartbeatMs);
    let last: JobMessage;
    try {
      last = { type: 'done', result: await execute(m, (x) => void send(x), controller.signal) };
    } catch (err) {
      // Parts of the job that are still running (other downloads, retries) stop before it reports.
      controller.abort();
      last = { type: 'error', message: publicError(err), detail: (err as Error)?.stack ?? String(err) };
    }
    clearInterval(heartbeat);
    await send(last);
    process.exit(0);
  });
}
