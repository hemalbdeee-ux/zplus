// Runs queued jobs in the background, a few at a time (archive.org punishes anything faster),
// and deletes finished jobs after the retention period.

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
  log?: (msg: string) => void;
}

export class JobRunner {
  readonly store: JobStore;
  readonly dataDir: string;
  readonly opts: RunnerOptions;
  #running = 0;
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
    const n = this.store.requeueRunning();
    if (n) this.opts.log?.(`requeued ${n} interrupted job(s)`);
    this.#timers.push(setInterval(() => this.tick(), 1000));
    this.#timers.push(setInterval(() => void this.sweep(), 60 * 60 * 1000));
    void this.sweep();
    this.tick();
  }

  stop(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }

  get running(): number {
    return this.#running;
  }

  tick(): void {
    while (this.#running < this.opts.workers) {
      const job = this.store.claim();
      if (!job) return;
      this.#running++;
      void this.run(job).finally(() => {
        this.#running--;
        this.tick();
      });
    }
  }

  async run(job: Job): Promise<void> {
    let lastWrite = 0;
    let lastPhase = '';
    const progress = (phase: string, message: string, done?: number, queued?: number) => {
      const now = Date.now();
      if (phase === lastPhase && now - lastWrite < 1000) return;
      lastWrite = now;
      lastPhase = phase;
      this.store.progress(job.id, { phase, message: message.slice(0, 300), done, queued });
    };

    try {
      if (job.kind === 'scan') {
        progress('health', `checking how ${job.domain} looked over the years`);
        const client = new ArchiveClient({ ...this.opts.archive, log: (m) => progress('health', m) });
        const health = await scanHealth(client, job.domain, { log: (m) => progress('health', m) });
        this.store.finish(job.id, { health } satisfies ScanResult);
        return;
      }

      const parent = job.parent_id ? this.store.get(job.parent_id) : undefined;
      const health = parent?.result ? (JSON.parse(parent.result) as ScanResult).health : undefined;
      const dir = this.jobDir(job.id);
      const result = await restore({
        domain: job.domain,
        outDir: dir,
        target: job.target ?? undefined,
        maxPages: job.max_pages ?? undefined,
        health,
        archive: this.opts.archive,
        onEvent: (e) => progress(e.phase, e.message, e.done, e.queued),
      });
      this.store.finish(job.id, {
        report: result.report,
        zip: result.zipFile ? path.relative(dir, result.zipFile) : undefined,
        reportHtml: path.relative(dir, path.join(result.jobDir, 'report.html')),
      } satisfies RestoreJobResult);
    } catch (err) {
      this.opts.log?.(`job ${job.id} (${job.kind} ${job.domain}) failed: ${(err as Error).stack ?? err}`);
      this.store.fail(job.id, (err as Error).message);
    }
  }

  async sweep(): Promise<void> {
    const cutoff = Date.now() - this.opts.retentionDays * 86_400_000;
    for (const job of this.store.finishedBefore(cutoff)) {
      await rm(this.jobDir(job.id), { recursive: true, force: true });
      this.store.delete(job.id);
    }
  }
}
