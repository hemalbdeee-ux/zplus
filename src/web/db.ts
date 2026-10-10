// Jobs live in SQLite (Node's built-in driver, no native module to compile), the same way Ghost
// runs on SQLite for single-server installs. The jobs table is also the queue.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export type JobKind = 'scan' | 'restore';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  kind: JobKind;
  domain: string;
  target: string | null;
  max_pages: number | null;
  parent_id: string | null;
  status: JobStatus;
  phase: string | null;
  message: string | null;
  done: number;
  queued: number;
  result: string | null;
  error: string | null;
  ip: string | null;
  /** How many times a worker has started this job. */
  attempts: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  target TEXT,
  max_pages INTEGER,
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT,
  message TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  ip TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_domain ON jobs (domain, kind, created_at);
CREATE INDEX IF NOT EXISTS jobs_ip ON jobs (ip, created_at);
CREATE TABLE IF NOT EXISTS code_failures (ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS code_failures_ip ON code_failures (ip, at);
`;

/** A job is started at most this often; one that keeps crashing or hanging its worker is failed, not retried forever. */
export const MAX_ATTEMPTS = 2;

export class JobStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // CREATE TABLE IF NOT EXISTS leaves databases made before the attempts column as they were.
    const columns = this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'attempts')) this.db.exec('ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  }

  create(input: { kind: JobKind; domain: string; target?: string; maxPages?: number; parentId?: string; ip?: string }): Job {
    const now = Date.now();
    const id = randomBytes(12).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, domain, target, max_pages, parent_id, ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.kind, input.domain, input.target ?? null, input.maxPages ?? null, input.parentId ?? null, input.ip ?? null, now, now);
    return this.get(id)!;
  }

  get(id: string): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
  }

  /** Takes the oldest queued job, marks it running and counts the attempt. */
  claim(): Job | undefined {
    const now = Date.now();
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1)
         RETURNING *`,
      )
      .get(now) as Job | undefined;
  }

  progress(id: string, p: { phase?: string; message?: string; done?: number; queued?: number }): void {
    this.db
      .prepare(
        `UPDATE jobs SET phase = COALESCE(?, phase), message = COALESCE(?, message), done = COALESCE(?, done),
         queued = COALESCE(?, queued), updated_at = ? WHERE id = ?`,
      )
      .run(p.phase ?? null, p.message ?? null, p.done ?? null, p.queued ?? null, Date.now(), id);
  }

  finish(id: string, result: unknown): void {
    const now = Date.now();
    this.db
      .prepare(`UPDATE jobs SET status = 'done', phase = 'done', result = ?, updated_at = ?, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify(result), now, now, id);
  }

  fail(id: string, error: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE jobs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ?`).run(error, now, now, id);
  }

  /**
   * A running job that stopped without a result goes back to the queue (restores resume from their
   * work folder), unless it has used all its attempts: then the same crash would only happen again.
   */
  interrupted(id: string, reason: string): 'queued' | 'failed' {
    const now = Date.now();
    const failed = this.db
      .prepare(`UPDATE jobs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running' AND attempts >= ?`)
      .run(`Stopped after ${MAX_ATTEMPTS} attempts: ${reason}.`, now, now, id, MAX_ATTEMPTS).changes;
    if (failed) return 'failed';
    this.db.prepare(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'running'`).run(now, id);
    return 'queued';
  }

  /** After a restart, every job that was running counts as interrupted. */
  requeueRunning(): { requeued: number; failed: number } {
    const counts = { requeued: 0, failed: 0 };
    const running = this.db.prepare(`SELECT id FROM jobs WHERE status = 'running'`).all() as { id: string }[];
    for (const { id } of running) {
      if (this.interrupted(id, 'the server restarted while it was running') === 'failed') counts.failed++;
      else counts.requeued++;
    }
    return counts;
  }

  recentScan(domain: string, sinceMs: number): Job | undefined {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE domain = ? AND kind = 'scan' AND status IN ('queued', 'running', 'done') AND created_at > ? ORDER BY created_at DESC LIMIT 1`)
      .get(domain, Date.now() - sinceMs) as Job | undefined;
  }

  countByIp(ip: string, sinceMs: number, kind?: JobKind): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ip = ? AND created_at > ? AND (? IS NULL OR kind = ?)`)
      .get(ip, Date.now() - sinceMs, kind ?? null, kind ?? null) as { n: number };
    return Number(row.n);
  }

  /** Wrong access codes are counted per address, so the code cannot be guessed by trying many. */
  recordCodeFailure(ip: string): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM code_failures WHERE at < ?').run(now - 86_400_000);
    this.db.prepare('INSERT INTO code_failures (ip, at) VALUES (?, ?)').run(ip, now);
  }

  codeFailures(ip: string, sinceMs: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM code_failures WHERE ip = ? AND at > ?').get(ip, Date.now() - sinceMs) as { n: number };
    return Number(row.n);
  }

  queuePosition(id: string): number {
    const job = this.get(id);
    if (!job || job.status !== 'queued') return 0;
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND created_at < ?`).get(job.created_at) as { n: number };
    return Number(row.n) + 1;
  }

  finishedBefore(ms: number): Job[] {
    return this.db.prepare(`SELECT * FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?`).all(ms) as unknown as Job[];
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
