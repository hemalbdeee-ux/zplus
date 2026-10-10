// One restore job, start to finish: health scan -> archive index -> download -> build -> package.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ArchiveClient, type ArchiveOptions } from './archive.ts';
import { buildSite } from './build.ts';
import { buildIndex, crawl } from './crawl.ts';
import { scanHealth, type HealthReport } from './health.ts';
import { makeReport, reportHtml, type RestoreReport } from './report.ts';
import { normalizeDomain, parseTimestamp } from './url.ts';
import { zipPaths } from './zip.ts';

export type Phase = 'health' | 'index' | 'download' | 'build' | 'package' | 'done';

export interface RestoreEvent {
  phase: Phase;
  message: string;
  done?: number;
  queued?: number;
}

export interface RestoreOptions {
  domain: string;
  outDir: string;
  /** Date or 14-digit timestamp. Default: the last good snapshot found by the health scan. */
  target?: string;
  from?: string;
  to?: string;
  /** Default: https:// plus the host form (www or not) the site used. */
  siteUrl?: string;
  maxUrls?: number;
  /** Demo: stop after this many HTML pages. */
  maxPages?: number;
  orphans?: boolean;
  stripTracking?: boolean;
  skipHealth?: boolean;
  zip?: boolean;
  archive?: ArchiveOptions;
  onEvent?: (e: RestoreEvent) => void;
}

export interface RestoreResult {
  jobDir: string;
  siteDir: string;
  zipFile?: string;
  report: RestoreReport;
}

export async function restore(opts: RestoreOptions): Promise<RestoreResult> {
  const startedAt = Date.now();
  const domain = normalizeDomain(opts.domain);
  const emit = (phase: Phase, message: string, extra: Partial<RestoreEvent> = {}) => opts.onEvent?.({ phase, message, ...extra });
  const client = new ArchiveClient({ ...opts.archive, log: (m) => emit('download', m) });
  const jobDir = path.resolve(opts.outDir, domain);
  const workDir = path.join(jobDir, '.work');
  await mkdir(workDir, { recursive: true });
  const warnings: string[] = [];

  let health: HealthReport | undefined;
  if (!opts.skipHealth) {
    emit('health', `checking how ${domain} looked over the years`);
    health = await scanHealth(client, domain, { log: (m) => emit('health', m) });
    await writeFile(path.join(workDir, 'health.json'), JSON.stringify(health, null, 1));
    if (health.lastGood) emit('health', `last good snapshot: ${health.lastGood.timestamp} (score ${health.lastGood.score})`);
  }

  const target = opts.target ? parseTimestamp(opts.target) : health?.lastGood?.timestamp;
  if (!target) {
    throw new Error(
      health?.months.length
        ? `No capture of ${domain} looks like a real website. Pass a date with --target to restore anyway.`
        : `The Wayback Machine has no captures of ${domain}.`,
    );
  }
  const window = {
    from: opts.from ? parseTimestamp(opts.from) : health?.window.from,
    to: opts.to ? parseTimestamp(opts.to, true) : health?.window.to,
  };
  if (opts.target && ((window.from && target < window.from) || (window.to && target > window.to))) {
    warnings.push(`The chosen date ${target.slice(0, 8)} is outside the period the site looked healthy; pages were taken from that period instead.`);
  }
  const host = health?.host ?? domain;
  const siteUrl = (opts.siteUrl ?? `https://${host}`).replace(/\/+$/, '');

  emit('index', 'reading the archive index');
  const index = await buildIndex(client, { domain, target, window, log: (m) => emit('index', m) });
  emit('index', `${index.size} URLs archived in the chosen period`);

  const manifest = await crawl(client, index, {
    domain,
    target,
    window,
    workDir,
    maxUrls: opts.maxUrls ?? 20_000,
    maxPages: opts.maxPages,
    orphans: opts.orphans ?? true,
    log: (m) => emit('download', m),
    progress: (p) => emit('download', p.current, { done: p.done, queued: p.queued }),
  });
  if (manifest.truncated) warnings.push(`The URL limit was reached; some archived URLs were not downloaded.`);

  emit('build', 'building the site');
  const siteDir = path.join(jobDir, 'site');
  const build = await buildSite(manifest, {
    domain,
    siteUrl,
    workDir,
    outDir: siteDir,
    serverDir: path.join(jobDir, 'server'),
    stripTracking: opts.stripTracking ?? true,
    log: (m) => emit('build', m),
  });

  const report = makeReport({ manifest, build, health, siteUrl, startedAt, archiveRequests: client.requests, warnings });
  await writeFile(path.join(jobDir, 'report.json'), JSON.stringify(report, null, 1));
  await writeFile(path.join(jobDir, 'report.html'), reportHtml(report));

  let zipFile: string | undefined;
  if (opts.zip ?? true) {
    emit('package', 'creating the ZIP file');
    zipFile = path.join(jobDir, `${domain}-site.zip`);
    await zipPaths({ site: siteDir, server: path.join(jobDir, 'server'), 'report.html': path.join(jobDir, 'report.html') }, zipFile);
  }
  emit('done', `done: ${report.counts.pages} pages, ${report.counts.files} files`);
  return { jobDir, siteDir, zipFile, report };
}
