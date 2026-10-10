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
  /** A health scan made earlier (the web app scans first, then restores). */
  health?: HealthReport;
  zip?: boolean;
  archive?: ArchiveOptions;
  onEvent?: (e: RestoreEvent) => void;
}

// A demo is the homepage and a few pages: it needs no more than this many URLs, and only the
// index entries for the pages it links to.
const DEMO_MAX_URLS = 200;
const DEMO_INDEX_URLS = 5_000;
/**
 * The index keeps about 0.5 KB per URL, so it stops here (some 230 MB). It is not tied to the URL
 * budget: the index is sorted by URL, not by importance. A linked URL past the cut is looked up on
 * its own; only unlinked ones are lost.
 */
const INDEX_CAP = 500_000;

export interface RestoreResult {
  jobDir: string;
  siteDir: string;
  zipFile?: string;
  report: RestoreReport;
}

/** https:// plus a bare host is accepted; anything else that is not an http(s) address is refused. */
export function normalizeSiteUrl(raw: string): string {
  const s = raw.trim();
  let u: URL | undefined;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    // reported below
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.search || u.hash || u.username || u.password) {
    throw new Error(`Not a valid site address: "${raw}". Use for example https://www.example.com`);
  }
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

export async function restore(opts: RestoreOptions): Promise<RestoreResult> {
  const startedAt = Date.now();
  const domain = normalizeDomain(opts.domain);
  // Checked before any download: the site address is only used in the last build step.
  const givenSiteUrl = opts.siteUrl !== undefined ? normalizeSiteUrl(opts.siteUrl) : undefined;
  const demo = opts.maxPages !== undefined;
  const maxUrls = opts.maxUrls !== undefined && Number.isFinite(opts.maxUrls) && opts.maxUrls >= 1 ? Math.floor(opts.maxUrls) : demo ? DEMO_MAX_URLS : 20_000;
  const emit = (phase: Phase, message: string, extra: Partial<RestoreEvent> = {}) => opts.onEvent?.({ phase, message, ...extra });
  const client = new ArchiveClient({ ...opts.archive, log: (m) => emit('download', m) });
  const jobDir = path.resolve(opts.outDir, domain);
  const workDir = path.join(jobDir, '.work');
  await mkdir(workDir, { recursive: true });
  const warnings: string[] = [];

  let health: HealthReport | undefined = opts.health;
  if (!health && !opts.skipHealth) {
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
  const siteUrl = givenSiteUrl ?? `https://${host}`;

  emit('index', 'reading the archive index');
  const indexLimit = demo ? DEMO_INDEX_URLS : INDEX_CAP;
  const index = await buildIndex(client, { domain, target, window, maxIndexUrls: indexLimit, log: (m) => emit('index', m) });
  emit('index', `${index.size} URLs archived in the chosen period`);
  if (index.size === 0) {
    throw new Error(`The Wayback Machine has no captures of ${domain} between ${window.from?.slice(0, 8) ?? 'the start'} and ${window.to?.slice(0, 8) ?? 'today'}.`);
  }

  const manifest = await crawl(client, index, {
    domain,
    target,
    window,
    workDir,
    maxUrls,
    maxPages: opts.maxPages,
    orphans: opts.orphans ?? !demo,
    log: (m) => emit('download', m),
    progress: (p) => emit('download', p.current, { done: p.done, queued: p.queued }),
  });
  if (manifest.truncated) warnings.push(`The URL limit was reached; some archived URLs were not downloaded.`);
  // A demo takes no unlinked URLs, so a cut-short index costs it nothing.
  if (index.truncated && !demo) {
    manifest.truncated = true;
    warnings.push(`The archive lists more than ${indexLimit} URLs for this domain. Every linked URL was still looked up, but unlinked ones were only taken from the first ${indexLimit}.`);
  }
  const refused = manifest.missing.filter((m) => m.transient);
  if (!manifest.resources.some((r) => r.status === 200)) {
    throw new Error(
      refused.length
        ? `Nothing could be downloaded: archive.org refused or failed every request (${refused[0].reason}). Try again later.`
        : `Nothing could be downloaded: no URL of ${domain} that was tried has an archived page or file in the chosen period.`,
    );
  }
  if (refused.length) {
    warnings.push(`${refused.length} URLs could not be downloaded because archive.org refused or failed the request; run the restore again later to fetch them.`);
  }

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
