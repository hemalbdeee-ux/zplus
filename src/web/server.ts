// The public website and the app, served the way Ghost serves a site: server-rendered pages with
// clean /slug/ URLs, tag and author archives, /rss/, a sitemap index and robots.txt. The app pages
// (/restore/, /job/...) are noindex.

import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isIPv6 } from 'node:net';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { HealthReport, MonthHealth } from '../engine/health.ts';
import type { PageMeta } from '../engine/meta.ts';
import { robotsTxt, rssFeed, sitemaps, sitemapXsl, type SitemapEntry } from '../engine/sitemap.ts';
import { normalizeDomain } from '../engine/url.ts';
import { Content, paginate, type Entry } from './content.ts';
import { JobStore, MAX_RETRIES, type Job } from './db.ts';
import { Theme, type ViewContext } from './views.ts';
import { JobRunner, type RestoreJobResult, type ScanResult } from './worker.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');

export interface WebConfig {
  port: number;
  siteUrl: string;
  dataDir: string;
  contentDir: string;
  themeDir: string;
  workers: number;
  accessCode: string;
  archiveBase: string;
  retentionDays: number;
  /** Requests per hour and IP. */
  scanLimit: number;
  restoreLimit: number;
  archiveDelayMs?: number;
  archiveBackoffMs?: number;
}

export function configFromEnv(env = process.env): WebConfig {
  return {
    port: Number(env.PORT ?? 8080),
    siteUrl: (env.WBD_SITE_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/+$/, ''),
    dataDir: path.resolve(env.WBD_DATA ?? path.join(ROOT, 'data')),
    contentDir: path.resolve(env.WBD_CONTENT ?? path.join(ROOT, 'content')),
    themeDir: path.resolve(env.WBD_THEME ?? path.join(ROOT, 'src', 'web', 'theme')),
    workers: Number(env.WBD_WORKERS ?? 1),
    accessCode: env.WBD_ACCESS_CODE ?? '',
    archiveBase: env.WBD_ARCHIVE ?? 'https://web.archive.org',
    retentionDays: Number(env.WBD_RETENTION_DAYS ?? 7),
    scanLimit: Number(env.WBD_SCAN_LIMIT ?? 30),
    restoreLimit: Number(env.WBD_RESTORE_LIMIT ?? 10),
  };
}

const PER_PAGE = 10;
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** Wrong access codes allowed per address and hour before every full restore is refused. */
const CODE_TRIES = 5;
/** A scan of a domain is reused for this long, for everyone who asks for the same domain. */
const SCAN_REUSE_MS = 12 * 3600_000;
/** docker stop kills the container 10 s after SIGTERM; the server is done before that. */
const SHUTDOWN_MS = 8000;

function codeMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The address that limits count against. An IPv6 client usually has a whole /64 to pick addresses
 * from, so the /64 is one client; an IPv4 address written as IPv6 is that IPv4 address.
 */
export function clientKey(ip: string | undefined): string {
  const addr = (ip ?? '').replace(/%.*$/, '');
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (v4) return v4[1];
  if (!isIPv6(addr)) return addr;
  const [head, tail] = addr.toLowerCase().split('::');
  // An IPv4 address at the end takes the room of two groups.
  const groups = (part: string | undefined) => (part ? part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const left = groups(head);
  const right = groups(tail);
  const all = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

function timelineRows(h: HealthReport) {
  const years = [...new Set(h.months.map((m) => m.month.slice(0, 4)))];
  return years.map((year) => ({
    year,
    cells: MONTHS.map((name, i) => {
      const key = `${year}${String(i + 1).padStart(2, '0')}`;
      const m = h.months.find((x) => x.month === key);
      return {
        cls: m ? m.verdict : 'none',
        pick: h.lastGood?.month === key,
        title: m ? `${name} ${year}: ${m.verdict}${m.score !== null ? ` (${m.score}/100)` : ''}${m.reasons.length ? ' · ' + m.reasons.join('; ') : ''}` : `${name} ${year}: no capture`,
      };
    }),
  }));
}

// Why a probe found no page (the scan puts it first), and the notes of a verdict estimated from
// other months. A probed month carries such a note only when its probe found no page.
const UNPLAYED = /^(capture not playable|redirect could not be followed|the page it leads to is a capture from)/;
const ESTIMATED = /^(same content as |estimated from the months around it|after the site went down|not checked; near a change)/;

/**
 * A month whose homepage capture the archive could not play back during the scan. Its verdict is an
 * estimate, and a restore from it would ask for the same capture again for the homepage.
 */
function unplayable(m: MonthHealth): boolean {
  return m.probed && (UNPLAYED.test(m.reasons[0] ?? '') || m.reasons.some((r) => ESTIMATED.test(r)));
}

/**
 * Good snapshots inside the healthy window that the archive could play back: restore() takes pages
 * from that window only, so a date outside it cannot be honoured.
 */
function restorable(h: HealthReport) {
  return h.months.filter(
    (m) =>
      m.verdict === 'good' &&
      m.timestamp &&
      !unplayable(m) &&
      (!h.window.from || m.timestamp >= h.window.from) &&
      (!h.window.to || m.timestamp <= h.window.to),
  );
}

function snapshotChoices(h: HealthReport) {
  return restorable(h)
    .reverse()
    .slice(0, 36)
    .map((m) => ({ timestamp: m.timestamp!, score: m.score, selected: m.timestamp === h.lastGood?.timestamp }));
}

/**
 * A finished scan that found no healthy snapshot while archive.org refused some of the captures it
 * asked for: the snapshot it is looking for may be among those, so the scan is no answer.
 */
function refusedScan(job: Job): { refused: number; checked: number; reason?: string } | undefined {
  if (job.kind !== 'scan' || job.status !== 'done' || !job.result) return undefined;
  const r = JSON.parse(job.result) as ScanResult;
  if (r.health.lastGood || !r.refused) return undefined;
  return { refused: r.refused, checked: r.refused + (r.played ?? 0), reason: r.lastRefusal };
}

/** Example timeline for the homepage: a site that was fine until late 2020, then parked. */
function sampleHealth(): HealthReport {
  const months: HealthReport['months'] = [];
  for (let y = 2014; y <= 2023; y++) {
    for (let m = 1; m <= 12; m++) {
      const month = `${y}${String(m).padStart(2, '0')}`;
      const seed = (y * 7 + m * 13) % 5;
      if (seed === 0 && y < 2021) continue;
      if (y >= 2021 && seed > 1) continue;
      const verdict = month <= '202011' ? (month === '201710' || month === '202004' ? 'weak' : 'good') : month === '202012' ? 'weak' : 'bad';
      months.push({ month, captures: 1, timestamp: `${month}14083015`, score: null, verdict, reasons: [], probed: false });
    }
  }
  return { domain: 'oldbakery.example', months, lastGood: { month: '202011', timestamp: '20201114083015', score: 92, original: '' }, window: {}, host: 'oldbakery.example', probes: 0 };
}

export async function createApp(config: WebConfig) {
  await mkdir(path.join(config.dataDir, 'jobs'), { recursive: true });
  const content = await Content.load(config.contentDir);
  const theme = new Theme(config.themeDir);
  await theme.load();
  const store = new JobStore(path.join(config.dataDir, 'wbd.sqlite'));
  const runner = new JobRunner(store, config.dataDir, {
    workers: config.workers,
    retentionDays: config.retentionDays,
    archive: { base: config.archiveBase, minIntervalMs: config.archiveDelayMs, backoffMs: config.archiveBackoffMs },
    log: (m) => console.error(m),
  });

  const s = content.settings;
  const sampleRows = timelineRows(sampleHealth());
  const site = {
    siteUrl: config.siteUrl,
    siteName: s.title,
    siteDescription: s.description,
    tagline: s.tagline,
    rssPath: '/rss/',
    description: s.description,
    lang: s.lang,
    navigation: s.navigation,
    secondaryNavigation: s.secondaryNavigation,
    year: new Date().getUTCFullYear(),
  };

  const meta = (m: Partial<PageMeta> & { path: string }): PageMeta => ({
    type: 'page',
    title: s.title,
    headline: s.title,
    description: s.description,
    tags: [],
    noindex: false,
    ...m,
  });
  const entryMeta = (e: Entry): PageMeta =>
    meta({
      path: `/${e.slug}/`,
      type: e.type,
      title: e.metaTitle ?? `${e.title} · ${s.title}`,
      headline: e.title,
      description: e.metaDescription ?? e.excerpt,
      image: e.image,
      publishedAt: e.date,
      modifiedAt: e.updated ?? e.date,
      author: e.author?.name,
      tags: e.tags.map((t) => t.name),
    });

  const render = (res: Response, template: string, ctx: Omit<ViewContext, 'site'>, status = 200) => {
    res.status(status).type('html').send(theme.render(template, { site, ...ctx } as ViewContext));
  };
  const notFound = (res: Response) =>
    render(res, 'error', { title: `Page not found · ${s.title}`, seo: meta({ path: '/404/', noindex: true }), code: 404, message: 'This page could not be found.' }, 404);

  const app = express();
  app.disable('x-powered-by');
  // Traefik reaches the container from a private address; only those may set X-Forwarded-For.
  app.set('trust proxy', 'loopback, uniquelocal');
  app.set('strict routing', true);
  app.use('/assets', express.static(path.join(config.themeDir, 'assets'), { maxAge: '30d', index: false }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));

  // Ghost style: every page URL ends with a slash.
  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.endsWith('/') && !/\.[a-z0-9]+$/i.test(req.path) && !/^\/(api|assets)\/|^\/job\/[^/]+\/(download|report)$/.test(req.path)) {
      // "//evil.example/x" would become the protocol-relative Location "//evil.example/x/", another site.
      if (/^\/[/\\]/.test(req.path)) return notFound(res);
      const q = req.originalUrl.slice(req.path.length);
      res.redirect(301, req.path + '/' + q);
      return;
    }
    next();
  });

  // Forms only from this site.
  app.use((req, res, next) => {
    if (req.method === 'POST') {
      const origin = req.get('origin');
      let sameSite = true;
      if (origin) {
        try {
          sameSite = new URL(origin).host === req.get('host');
        } catch {
          sameSite = false;
        }
      }
      if (!sameSite) {
        res.status(403).send('Forbidden');
        return;
      }
    }
    next();
  });

  // ---- Public site ----

  const homeTitle = s.tagline ? `${s.title} · ${s.tagline}` : s.title;
  app.get('/', (req, res) => {
    render(res, 'home', {
      title: homeTitle,
      seo: meta({ path: '/', type: 'home', title: homeTitle, headline: s.title }),
      bodyClass: 'home-template',
      posts: content.posts.slice(0, 3),
      sample: sampleRows,
      // No error from the query string: anyone could put their own text in the alert box.
      domain: typeof req.query.domain === 'string' ? req.query.domain.slice(0, 200) : '',
    });
  });

  const listing = (res: Response, opts: { base: string; posts: Entry[]; page: number; heading: string; intro?: string; seo: PageMeta; template?: string; tag?: unknown; author?: unknown }) => {
    const p = paginate(opts.posts, opts.page, PER_PAGE);
    if (opts.page !== p.page) return notFound(res);
    const pagePath = p.page > 1 ? `${opts.base}page/${p.page}/` : opts.base;
    render(res, opts.template ?? 'index', {
      title: p.page > 1 ? `${opts.heading} (page ${p.page}) · ${s.title}` : `${opts.heading} · ${s.title}`,
      seo: { ...opts.seo, path: pagePath },
      bodyClass: 'index-template',
      heading: opts.heading,
      intro: opts.intro,
      posts: p.items,
      tag: opts.tag,
      author: opts.author,
      pagination: { ...p, prevUrl: p.prev ? (p.prev === 1 ? opts.base : `${opts.base}page/${p.prev}/`) : undefined, nextUrl: p.next ? `${opts.base}page/${p.next}/` : undefined },
    });
  };

  const blog = (req: Request, res: Response) =>
    listing(res, {
      base: '/blog/',
      posts: content.posts,
      page: Number(req.params.n ?? 1),
      heading: 'Guides',
      intro: 'How to find, check and restore old websites from the Wayback Machine.',
      seo: meta({ path: '/blog/', type: 'archive', headline: 'Guides', title: `Guides · ${s.title}` }),
    });
  app.get('/blog/', blog);
  app.get('/blog/page/:n/', blog);

  const tagPage = (req: Request, res: Response) => {
    const tag = content.tags.get(String(req.params.slug));
    const posts = tag ? content.postsByTag(tag.slug) : [];
    if (!tag || !posts.length) return notFound(res);
    listing(res, {
      base: `/tag/${tag.slug}/`,
      posts,
      page: Number(req.params.n ?? 1),
      heading: tag.name,
      intro: tag.description,
      tag,
      seo: meta({ path: `/tag/${tag.slug}/`, type: 'tag', headline: tag.name, description: tag.description ?? `Guides about ${tag.name}.` }),
    });
  };
  app.get('/tag/:slug/', tagPage);
  app.get('/tag/:slug/page/:n/', tagPage);

  const authorPage = (req: Request, res: Response) => {
    const author = content.authors.get(String(req.params.slug));
    if (!author) return notFound(res);
    listing(res, {
      base: `/author/${author.slug}/`,
      posts: content.postsByAuthor(author.slug),
      page: Number(req.params.n ?? 1),
      heading: author.name,
      intro: author.bio,
      author,
      seo: meta({ path: `/author/${author.slug}/`, type: 'author', headline: author.name, description: author.bio ?? s.description }),
    });
  };
  app.get('/author/:slug/', authorPage);
  app.get('/author/:slug/page/:n/', authorPage);

  app.get('/rss/', (_req, res) => {
    res.type('application/rss+xml').set('cache-control', 'public, max-age=600').send(
      rssFeed(
        { siteUrl: config.siteUrl, siteName: s.title, description: s.description, rssPath: '/rss/' },
        content.posts.map((p) => ({ title: p.title, path: `/${p.slug}/`, description: p.excerpt, publishedAt: p.date ?? new Date(0).toISOString(), author: p.author?.name, tags: p.tags.map((t) => t.name), image: p.image })),
      ),
    );
  });

  const sitemapFiles = () => {
    const entry = (e: Entry): SitemapEntry => ({ path: `/${e.slug}/`, lastmod: e.updated ?? e.date, image: e.image });
    const newest = content.posts[0]?.date;
    return sitemaps(config.siteUrl, {
      pages: [{ path: '/', lastmod: newest }, { path: '/blog/', lastmod: newest }, ...content.pages.map(entry)],
      posts: content.posts.map(entry),
      tags: [...content.tags.values()].filter((t) => content.postsByTag(t.slug).length).map((t) => ({ path: `/tag/${t.slug}/`, lastmod: content.postsByTag(t.slug)[0]?.date })),
      authors: [...content.authors.values()].filter((a) => content.postsByAuthor(a.slug).length).map((a) => ({ path: `/author/${a.slug}/`, lastmod: content.postsByAuthor(a.slug)[0]?.date })),
    });
  };
  app.get(/^\/sitemap(-[a-z]+(-\d+)?)?\.xml$/, (req, res) => {
    const xml = sitemapFiles().get(req.path.slice(1));
    if (!xml) return notFound(res);
    res.type('application/xml').set('cache-control', 'public, max-age=3600').send(xml);
  });
  app.get('/sitemap.xsl', (_req, res) => res.type('text/xsl').send(sitemapXsl(s.title)));
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(robotsTxt(config.siteUrl).replace('Disallow: /__wbd/', 'Disallow: /job/\nDisallow: /api/')));
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/assets/favicon.svg'));

  // ---- App ----

  const scanForm = (req: Request, res: Response) => {
    const raw = String(req.body?.domain ?? '').trim().slice(0, 200);
    let domain: string;
    try {
      domain = normalizeDomain(raw);
    } catch {
      return render(
        res,
        'restore',
        { title: `Restore a website · ${s.title}`, seo: meta({ path: '/restore/', noindex: true }), error: raw ? `"${raw}" is not a domain name. Try something like oldsite.com.` : undefined, domain: raw },
        raw ? 422 : 200,
      );
    }
    // A scan archive.org partly refused is not reused: asking again is how to get an answer.
    const recent = store.recentScan(domain, SCAN_REUSE_MS);
    if (recent && !refusedScan(recent)) return res.redirect(303, `/job/${recent.id}/`);
    const ip = clientKey(req.ip);
    if (store.countByIp(ip, 3600_000, 'scan') >= config.scanLimit) {
      return render(res, 'restore', { title: `Restore a website · ${s.title}`, seo: meta({ path: '/restore/', noindex: true }), error: 'Too many checks from your address in the last hour. Please try again later.', domain: raw }, 429);
    }
    const job = store.create({ kind: 'scan', domain, ip });
    runner.tick();
    res.redirect(303, `/job/${job.id}/`);
  };
  // GET only fills in the form; jobs start from a POST, so crawlers and link previews never start one.
  app.get('/restore/', (req, res) =>
    render(res, 'restore', { title: `Restore a website · ${s.title}`, seo: meta({ path: '/restore/', noindex: true }), domain: typeof req.query.domain === 'string' ? req.query.domain.slice(0, 200) : '' }),
  );
  app.post('/restore/', scanForm);

  const loadJob = (req: Request, res: Response, next: NextFunction) => {
    const job = /^[A-Za-z0-9_-]{16}$/.test(String(req.params.id)) ? store.get(String(req.params.id)) : undefined;
    if (!job) return notFound(res);
    res.locals.job = job;
    next();
  };

  const jobView = (job: Job) => {
    const result = job.result ? JSON.parse(job.result) : undefined;
    const view: Record<string, unknown> = {
      id: job.id,
      kind: job.kind,
      domain: job.domain,
      status: job.status,
      active: job.status === 'queued' || job.status === 'running',
      phase: job.phase,
      message: job.message,
      done: job.done,
      queued: job.queued,
      error: job.error,
      position: store.queuePosition(job.id),
      isScan: job.kind === 'scan',
      demo: job.max_pages !== null,
      parentId: job.parent_id,
      codeRequired: !!config.accessCode,
      codeTries: CODE_TRIES,
      // A failed restore runs again where it stopped; a scan is simply asked for again.
      canRetry: job.kind === 'restore' && job.status === 'failed' && job.retries < MAX_RETRIES,
    };
    if (job.kind === 'scan' && result) {
      const h = (result as ScanResult).health;
      view.health = h;
      view.rows = timelineRows(h);
      view.choices = snapshotChoices(h);
      view.probed = h.months.filter((m) => m.probed);
      view.refusal = refusedScan(job);
    }
    if (job.kind === 'restore' && result) {
      const r = result as RestoreJobResult;
      view.report = r.report;
      view.hasZip = !!r.zip;
    }
    return view;
  };

  app.get('/job/:id/', loadJob, (_req, res) => {
    const job = res.locals.job as Job;
    render(res, 'job', {
      title: `${job.kind === 'scan' ? 'Snapshots of' : 'Restoring'} ${job.domain} · ${s.title}`,
      seo: meta({ path: `/job/${job.id}/`, noindex: true }),
      bodyClass: 'job-template',
      job: jobView(job),
      formError: res.locals.formError,
    });
  });

  app.get('/api/jobs/:id', loadJob, (_req, res) => {
    const job = res.locals.job as Job;
    res.set('cache-control', 'no-store').json({ id: job.id, kind: job.kind, status: job.status, phase: job.phase, message: job.message, done: job.done, queued: job.queued, position: store.queuePosition(job.id), error: job.error });
  });

  app.post('/job/:id/restore', loadJob, (req, res) => {
    const scan = res.locals.job as Job;
    if (scan.kind !== 'scan' || scan.status !== 'done') return res.redirect(303, `/job/${scan.id}/`);
    const health = (JSON.parse(scan.result!) as ScanResult).health;
    const target = String(req.body?.target ?? '');
    const valid = restorable(health).some((m) => m.timestamp === target);
    const full = req.body?.mode === 'full';
    const ip = clientKey(req.ip);
    const fail = (msg: string, status: number) => {
      res.locals.formError = msg;
      res.status(status);
      render(res, 'job', { title: `Snapshots of ${scan.domain} · ${s.title}`, seo: meta({ path: `/job/${scan.id}/`, noindex: true }), job: jobView(scan), formError: msg }, status);
    };
    if (!valid) return fail('Choose one of the snapshots in the list.', 422);
    // Limits come before the code check, and once the tries are used up every code gets the same
    // answer, so the response never tells a right code from a wrong one.
    if (store.countByIp(ip, 24 * 3600_000, 'restore') >= config.restoreLimit) return fail('Too many restores from your address today. Please try again tomorrow.', 429);
    if (full && config.accessCode) {
      if (store.codeFailures(ip, 3600_000) >= CODE_TRIES) return fail('Too many wrong access codes from your address. Please try again in an hour.', 429);
      if (!codeMatches(String(req.body?.code ?? ''), config.accessCode)) {
        store.recordCodeFailure(ip);
        return fail('That access code is not valid.', 403);
      }
    }
    const job = store.create({ kind: 'restore', domain: scan.domain, target, maxPages: full ? undefined : 4, parentId: scan.id, ip });
    runner.tick();
    res.redirect(303, `/job/${job.id}/`);
  });

  // A restore that failed (archive.org refused too many downloads, say) runs again under the same id:
  // it continues from its work folder instead of downloading everything again, and it is not another
  // restore for the daily limit. MAX_RETRIES keeps one job from being run again and again.
  app.post('/job/:id/retry', loadJob, (_req, res) => {
    const job = res.locals.job as Job;
    if (store.retry(job.id)) runner.tick();
    res.redirect(303, `/job/${job.id}/`);
  });

  // With root, send checks only the path below it for dotfiles, so a data folder like ~/.local/share/wbd works.
  app.get('/job/:id/download', loadJob, (_req, res) => {
    const job = res.locals.job as Job;
    const r = job.result ? (JSON.parse(job.result) as RestoreJobResult) : undefined;
    const dir = runner.jobDir(job.id);
    if (job.kind !== 'restore' || !r?.zip || !existsSync(path.join(dir, r.zip))) return notFound(res);
    res.download(r.zip, `${job.domain}-restored.zip`, { root: dir });
  });

  app.get('/job/:id/report', loadJob, (_req, res) => {
    const job = res.locals.job as Job;
    const r = job.result ? (JSON.parse(job.result) as RestoreJobResult) : undefined;
    const dir = runner.jobDir(job.id);
    if (job.kind !== 'restore' || !r || !existsSync(path.join(dir, r.reportHtml))) return notFound(res);
    res.set('x-robots-tag', 'noindex').sendFile(r.reportHtml, { root: dir });
  });

  // ---- Posts and pages: /{slug}/ like Ghost ----

  app.get('/:slug/', (req, res) => {
    const entry = content.find(String(req.params.slug));
    if (!entry) return notFound(res);
    const related = entry.type === 'post' ? content.posts.filter((p) => p !== entry && p.tags.some((t) => entry.tags.includes(t))).slice(0, 3) : [];
    render(res, entry.type, {
      title: entry.metaTitle ?? `${entry.title} · ${s.title}`,
      seo: entryMeta(entry),
      bodyClass: `${entry.type}-template`,
      entry,
      related,
    });
  });

  app.use((_req, res) => notFound(res));
  app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    // Errors from body parsing and file sending carry their own 4xx status; only the rest are ours.
    const status = err.status ?? err.statusCode ?? 500;
    if (status === 404) return notFound(res);
    if (status >= 400 && status < 500) {
      return render(res, 'error', { title: `Error · ${s.title}`, seo: meta({ path: `/${status}/`, noindex: true }), code: status, message: 'This request could not be handled.' }, status);
    }
    console.error(err);
    render(res, 'error', { title: `Error · ${s.title}`, seo: meta({ path: '/500/', noindex: true }), code: 500, message: 'Something went wrong on our side. Please try again.' }, 500);
  });

  return { app, store, runner, content };
}

if (process.argv[1] === import.meta.filename) {
  const config = configFromEnv();
  const { app, store, runner, content } = await createApp(config);
  runner.start();
  const server = app.listen(config.port, () => console.log(`${content.settings.title} on ${config.siteUrl} (port ${config.port})`));
  // A deploy (docker stop) or Ctrl-C: running jobs stop and go back to the queue without using up an
  // attempt, so the next start resumes them. A second signal ends the process at once, as does the
  // timer, before docker would kill it.
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) process.exit(1);
    closing = true;
    console.error(`${signal}: stopping`);
    setTimeout(() => process.exit(1), SHUTDOWN_MS).unref();
    server.close();
    void runner.shutdown().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
