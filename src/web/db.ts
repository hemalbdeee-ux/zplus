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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS jobs_domain ON jobs (domain, kind, created_at);
CREATE INDEX IF NOT EXISTS jobs_ip ON jobs (ip, created_at);
`;

export class JobStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
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

  /** Takes the oldest queued job and marks it running. */
  claim(): Job | undefined {
    const now = Date.now();
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'running', updated_at = ?
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

  /** After a restart, running jobs go back to the queue; restores resume from their work folder. */
  requeueRunning(): number {
    return Number(this.db.prepare(`UPDATE jobs SET status = 'queued' WHERE status = 'running'`).run().changes);
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
