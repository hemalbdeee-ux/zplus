// One restore job, start to finish: health scan -> archive index -> download -> build -> package.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ArchiveClient, type ArchiveOptions } from './archive.ts';
import { buildSite } from './build.ts';
import { buildIndex, crawl, type Manifest } from './crawl.ts';
import { scanHealth, type HealthReport, type MonthHealth } from './health.ts';
import { hostingNotes, makeReport, reportHtml, type RestoreReport } from './report.ts';
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

/** Reasons the health scan gives for another owner's homepage (NEW_OWNER in health.ts). */
const NEW_OWNER = /parked|redirects to|sends visitors|spam/;
/** The reason the health scan gives a month it neither probed nor could estimate from its neighbours. */
const UNCHECKED = 'not checked; near a change';

type Window = { from?: string; to?: string };

const inWindow = (ts: string, w: Window) => (!w.from || ts >= w.from) && (!w.to || ts <= w.to);

/** YYYYMM moved by a number of months. */
function addMonths(month: string, n: number): string {
  const i = Number(month.slice(0, 4)) * 12 + Number(month.slice(4, 6)) - 1 + n;
  return `${Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, '0')}`;
}

/** A timestamp as YYYY-MM-DD. */
const day = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

/**
 * The period around a date the user picked in which the site was itself, when the health scan found
 * no good month: the walk scanHealth makes from its last good one. It ends before the first bad
 * month after the date and starts after the last stretch of bad months before it that was not an
 * outage of the site. Without a good month the scan never narrows down where the site turned bad, so
 * the months it left unchecked just before that bad month are left out too. null when the date falls
 * in a stretch of bad months the scan found parked or run by another owner.
 */
export function windowAround(months: MonthHealth[], target: string): Window | null {
  let i = -1;
  while (i + 1 < months.length && months[i + 1].month <= target.slice(0, 6)) i++;
  const newOwner = (m: MonthHealth) => m.reasons.some((r) => NEW_OWNER.test(r));
  if (i >= 0 && months[i].verdict === 'bad') {
    // A month estimated from the probes around it does not carry their reasons, so the whole stretch
    // of bad months decides, as in the walk back.
    let k = i;
    while (k > 0 && months[k - 1].verdict === 'bad') k--;
    let j = i;
    while (j + 1 < months.length && months[j + 1].verdict === 'bad') j++;
    if (months.slice(k, j + 1).some(newOwner)) return null;
  }
  const window: Window = {};
  let end = months.findIndex((m, n) => n > i && m.verdict === 'bad');
  if (end >= 0) {
    while (end > 0 && months[end - 1].reasons.includes(UNCHECKED)) end--;
    const last = addMonths(months[end].month, -1);
    const lastDay = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(4, 6)), 0)).getUTCDate();
    window.to = `${last}${lastDay}235959`;
  }
  for (let j = i - 1; j >= 0; j--) {
    if (months[j].verdict !== 'bad') continue;
    let k = j;
    while (k > 0 && months[k - 1].verdict === 'bad') k--;
    const run = months.slice(k, j + 1);
    const outage = !run.some(newOwner) && (run.length === 1 || (monthsBetween(months[k].month, months[j].month) < 6 && months.slice(0, k).some((m) => m.verdict === 'good')));
    if (!outage) {
      window.from = `${addMonths(months[j].month, 1)}01000000`;
      break;
    }
    j = k;
  }
  return window;
}

function monthsBetween(a: string, b: string): number {
  return Number(b.slice(0, 4)) * 12 + Number(b.slice(4, 6)) - (Number(a.slice(0, 4)) * 12 + Number(a.slice(4, 6)));
}

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
  // Checked before any download: the site address is only used in the last build step, the dates
  // after the health scan.
  const givenSiteUrl = opts.siteUrl !== undefined ? normalizeSiteUrl(opts.siteUrl) : undefined;
  const givenTarget = opts.target ? parseTimestamp(opts.target) : undefined;
  const givenFrom = opts.from ? parseTimestamp(opts.from) : undefined;
  const givenTo = opts.to ? parseTimestamp(opts.to, true) : undefined;
  if (givenFrom && givenTo && givenFrom > givenTo) throw new Error(`The --from date ${opts.from} is after the --to date ${opts.to}.`);
  const demo = opts.maxPages !== undefined;
  const maxUrls = opts.maxUrls !== undefined && Number.isFinite(opts.maxUrls) && opts.maxUrls >= 1 ? Math.floor(opts.maxUrls) : demo ? DEMO_MAX_URLS : 20_000;
  const emit = (phase: Phase, message: string, extra: Partial<RestoreEvent> = {}) => opts.onEvent?.({ phase, message, ...extra });
  const client = new ArchiveClient({ ...opts.archive, log: (m) => emit('download', m) });
  const jobDir = path.resolve(opts.outDir, domain);
  const workDir = path.join(jobDir, '.work');
  await mkdir(workDir, { recursive: true });
  const warnings: string[] = [];
  const earlier = await readFile(path.join(workDir, 'manifest.json'), 'utf8')
    .then((text) => JSON.parse(text) as Manifest | null)
    .catch(() => null);

  let health: HealthReport | undefined = opts.health;
  if (!health && !opts.skipHealth) {
    emit('health', `checking how ${domain} looked over the years`);
    health = await scanHealth(client, domain, { log: (m) => emit('health', m) });
    await writeFile(path.join(workDir, 'health.json'), JSON.stringify(health, null, 1));
    if (health.lastGood) emit('health', `last good snapshot: ${health.lastGood.timestamp} (score ${health.lastGood.score})`);
  }

  let target = givenTarget ?? health?.lastGood?.timestamp;
  // A re-run continues the earlier one, whose downloads crawl() reuses for the same snapshot only.
  // A new scan can pick another last good month (one more capture indexed, a probe refused this
  // time), so the snapshot an earlier scan picked (a homepage capture, not a date the user gave) is
  // kept while it is still in the period this scan finds the site was itself.
  if (!givenTarget && health?.lastGood && earlier?.domain === domain && earlier.target !== target) {
    const scanned = health.months.some((m) => m.timestamp === earlier.target && m.verdict !== 'bad');
    if (scanned && inWindow(earlier.target, { from: givenFrom ?? health.window.from, to: givenTo ?? health.window.to })) {
      emit('health', `continuing the earlier run, which restores the snapshot of ${earlier.target} (this scan picks ${target})`);
      target = earlier.target;
    }
  }
  if (!target) {
    // A scan whose captures archive.org would not play back says nothing about the site.
    if (client.playbackRefused) {
      throw new Error(`archive.org refused or failed every request to play back ${domain}'s captures (${client.lastRefusal}), so its history could not be checked. Try again later.`);
    }
    const refusedSome = client.refused ? ` archive.org refused ${client.refused} of the ${client.refused + client.played} captures checked, so trying again later may find one.` : '';
    throw new Error(
      health?.months.length
        ? `No capture of ${domain} looks like a real website. Pass a date with --target to restore anyway.${refusedSome}`
        : `The Wayback Machine has no captures of ${domain}.`,
    );
  }
  let bounds: Window = health?.window ?? {};
  let around: Window | null = null;
  if (health?.months.length && !health.lastGood && !(givenFrom && givenTo)) {
    // The user picked the date after the scan found no good month. The window still ends at the
    // months it found parked or taken over, or the later owner's pages would come back as the site.
    around = windowAround(health.months, target);
    if (!around) {
      throw new Error(`The health scan found ${domain} parked or run by another owner around ${day(target)}. Pick a date when it was still the old site, or pass --from and --to to restore that period anyway.`);
    }
    bounds = around;
  }
  const window: Window = { from: givenFrom ?? bounds.from, to: givenTo ?? bounds.to };
  if (around) {
    if (window.from && window.to && window.from > window.to) {
      throw new Error(`The health scan cannot vouch for ${domain} around ${day(target)}: the months around it were bad or not checked, so the period to restore would run from ${day(window.from)} to ${day(window.to)}. Pick a date when it was still the old site, or pass --from and --to to restore that period anyway.`);
    }
    emit('health', `no capture looks like a real website: pages are taken from ${window.from?.slice(0, 8) ?? 'the start'} to ${window.to?.slice(0, 8) ?? 'today'}, between the bad months around the chosen date`);
  }
  if (givenTarget && !inWindow(target, window)) {
    warnings.push(`The chosen date ${target.slice(0, 8)} is outside the period the site looked healthy; pages were taken from that period instead.`);
  }
  if (!window.to && !health?.months.length) {
    // Only the scan of the homepage finds when a later owner took over.
    const note = `Neither a health scan of the homepage nor a --to date bounded the period, so captures of every date were used and a later owner's parked or spam pages may have been restored as the site.`;
    warnings.push(note);
    emit('index', note);
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

  const generated = (name: string) => readFile(path.join(siteDir, name), 'utf8').catch(() => '');
  // buildSite reports Cloudflare Pages' rule limits itself.
  warnings.push(...hostingNotes(await generated('_redirects'), await generated('_headers'), { limits: false }));
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
