// Finds when the site was in good shape.
//
// The last captures of an expired domain are usually a parking page ("this domain may be for
// sale"), a hosting error or a spam site run by whoever bought the domain next. Taking the newest
// capture restores that junk. This module scores the homepage month by month and returns the last
// good snapshot plus the time window in which the site was itself.

import type { ArchiveClient, Capture, CaptureResult } from './archive.ts';
import { decodeText } from './charset.ts';
import { countWords, loadHtml, visibleText } from './html.ts';
import { bareHost, isInternal, toUrl, urlKey } from './url.ts';

export type Verdict = 'good' | 'weak' | 'bad' | 'none';

export interface PageSignals {
  words: number;
  internalLinks: number;
  title: string;
  lang: string;
  spamHits: number;
  /** A reason that alone makes the capture unusable (parked, dead, moved). */
  fatal: string | null;
  /** A parked or dead phrase on a page that otherwise looks real ("make an offer"): costs points only. */
  hint?: string;
  /** Distinct internal paths linked: a menu of pages, not a parking page's /search?q= ads. */
  paths?: number;
  /** Those paths (the first 100), to tell the site's own menu from a later owner's page. */
  menu?: string[];
  /** Where a stub homepage (internal meta refresh, frameset, "enter" page) sends visitors. */
  follow?: string;
}

export interface MonthHealth {
  month: string; // YYYYMM
  /** Days with a capture: the index is read one capture a day. */
  captures: number;
  timestamp?: string;
  original?: string;
  statuscode?: string;
  length?: number;
  digest?: string;
  score: number | null;
  verdict: Verdict;
  reasons: string[];
  probed: boolean;
}

export interface HealthReport {
  domain: string;
  months: MonthHealth[];
  lastGood?: { month: string; timestamp: string; score: number; original: string };
  /** Inclusive 14-digit bounds of the period in which the site was itself. */
  window: { from?: string; to?: string };
  /** Host form the site used: "www.example.com" or "example.com". */
  host: string;
  probes: number;
}

// Phrases only parking, registrar and hosting pages use.
const PARKED = [
  /\b(this|the) domain( name)? (may be|is|might be|could be) (for sale|available)/,
  /\bbuy (this|the) domain\b/,
  /\bdomain( name)? (is )?for sale\b/,
  /\b(inquire about this domain|get this domain|this domain is available)\b/,
  /\b(sedo|sedoparking|dan\.com|afternic|hugedomains|undeveloped\.com|bodis|parkingcrew|domainmarket|brandbucket|squadhelp|parklogic|domainnamesales)\b/,
  /\b(domain parking|parked (free|domain|by)|this (web ?page|domain|site) is parked)\b/,
  /\b(this domain|domain) (has )?expired\b/,
];
const DEAD = [
  /\b(this )?account (has been |is )?suspended\b/,
  /\b(default (web )?(site|server) page|apache2? (ubuntu |debian )?default page|welcome to nginx|test page for (the )?(apache|nginx)|iis windows server)\b/,
  /\bindex of \//,
  /\b(error establishing a database connection|bandwidth limit exceeded)\b/,
];
// Phrases a real small site uses too: a dealer's "make an offer", a restaurant's "coming soon", a
// "related links" box. They are fatal only on a page that also looks like a lander.
const PARKED_SOFT = [/\bmake an offer\b/, /\bexpired domain\b|\brenew (this|your) domain\b/];
const PARKED_PPC = /\brelated (searches|links)\b/;
const DEAD_SOFT = [
  /\bit works!/,
  /\b(future home of|coming soon|under construction|website coming soon)\b/,
  /\bsite (is )?(under maintenance|temporarily unavailable)\b/,
  /\b(403 forbidden|404 not found|500 internal server error|service (temporarily )?unavailable)\b/,
];
const SPAM = /\b(casino|slot gacor|slots?|judi|togel|poker online|viagra|cialis|levitra|replica watches|payday loans?|bandar|sbobet|gacor|maxwin|bokep|escort service|cbd oil)\b/gi;
const JS_LOCATION = /(?:\blocation\.(?:href|replace|assign)|\b(?:window|document|top|self)\.location)\s*[=(]\s*['"]([^'"]+)['"]/gi;

export function analyzePage(html: string, pageUrl: string, domain: string): PageSignals {
  const $ = loadHtml(html);
  const text = visibleText($);
  const words = countWords(text);
  const title = $('title').first().text().trim();
  const lang = ($('html').attr('lang') ?? '').trim().toLowerCase().slice(0, 2);
  const hay = `${title} ${text.slice(0, 30_000)}`.toLowerCase();
  const self = toUrl(pageUrl);
  const selfKey = self ? urlKey(self) : '';

  // Internal URLs in these elements, other than the page itself.
  const inside = (selector: string, attr: string) =>
    $(selector)
      .toArray()
      .map((el) => ({ url: toUrl($(el).attr(attr) ?? '', pageUrl), name: `${$(el).attr('name') ?? ''} ${$(el).attr('id') ?? ''}` }))
      .filter((x): x is { url: URL; name: string } => !!x.url && isInternal(x.url, domain) && urlKey(x.url) !== selfKey);

  // Image maps and the frames of a frameset are navigation too.
  let internalLinks = 0;
  const paths = new Set<string>();
  $('a[href], area[href], frame[src]').each((_, el) => {
    const u = toUrl($(el).attr('href') ?? $(el).attr('src') ?? '', pageUrl);
    if (!u || !isInternal(u, domain)) return;
    internalLinks++;
    paths.add(u.pathname);
  });

  let fatal: string | null = null;
  const soft: Array<{ re: RegExp; reason: string }> = [];
  if (words < 600) {
    const hit = PARKED.find((re) => re.test(hay));
    if (hit) fatal = `parked domain page ("${hay.match(hit)?.[0]}")`;
    for (const re of PARKED_SOFT) if (re.test(hay)) soft.push({ re, reason: `parked domain page ("${hay.match(re)?.[0]}")` });
    if (words < 250 && PARKED_PPC.test(hay)) soft.push({ re: PARKED_PPC, reason: 'parked domain page (ad links)' });
  }
  if (!fatal && words < 300) {
    const hit = DEAD.find((re) => re.test(hay));
    if (hit) fatal = `hosting or error page ("${hay.match(hit)?.[0]}")`;
    for (const re of DEAD_SOFT) if (re.test(hay)) soft.push({ re, reason: `hosting or error page ("${hay.match(re)?.[0]}")` });
  }
  let hint: string | undefined;
  if (!fatal && soft.length) {
    // A lander says it in its title or heading, piles such phrases up, or links nowhere but to itself
    // (parking pages link to their own /?q= searches, so paths count, not URLs).
    const heading = `${title} ${$('h1').first().text()}`.toLowerCase();
    if (soft.length > 1 || paths.size < 3 || soft.some((x) => x.re.test(heading))) fatal = soft[0].reason;
    else hint = `mentions "${hay.match(soft[0].re)?.[0]}"`;
  }

  let follow: string | undefined;
  if (!fatal) {
    const refresh = $('meta[http-equiv]').filter((_, el) => ($(el).attr('http-equiv') ?? '').toLowerCase() === 'refresh').attr('content') ?? '';
    const refreshUrl = /url\s*=\s*['"]?([^'"\s]+)/i.exec(refresh)?.[1];
    // Only script code counts, not onclick handlers, and only on a page without navigation: a real
    // page with a nav bar and a button to its Instagram is not a redirect.
    const scripts = words < 100 && internalLinks < 2 ? $('script:not([src])').map((_, el) => $(el).text()).get().join('\n') : '';
    // Only a web address sends visitors anywhere: `location.href = 'mailto:' + user` hides an email
    // address, and a page that does so is not a redirect.
    const web = (href: string | undefined) => {
      const u = href ? toUrl(href, pageUrl) : null;
      return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
    };
    const target = web(refreshUrl) ?? [...scripts.matchAll(JS_LOCATION)].map((x) => web(x[1])).find((u) => u) ?? null;
    if (target) {
      if (!isInternal(target, domain)) fatal = `sends visitors to ${bareHost(target.hostname)}`;
      else if (urlKey(target) !== selfKey) follow = target.toString();
    }
  }
  if (!fatal && !follow) {
    // The main frame of a frameset, the iframe of an empty page, or the way into a splash or
    // language-select page: that is where the site's content is.
    const frames = inside('frame[src]', 'src');
    const iframes = words < 50 ? inside('iframe[src]', 'src') : [];
    const ways = words < 50 ? [...new Map(inside('a[href], area[href]', 'href').map((x) => [urlKey(x.url), x])).values()] : [];
    // A frame named "contents" is usually the table of contents, not the content, and "mainmenu" the menu.
    const main = frames.find((f) => /main(?![-_.]?(menu|nav))/i.test(f.name)) ?? frames.find((f) => /\b(content|body)\b/i.test(f.name)) ?? frames[frames.length - 1];
    const pick = main ?? iframes[0] ?? (ways.length <= 3 ? ways[0] : undefined);
    follow = pick?.url.toString();
  }
  const spamHits = hay.match(SPAM)?.length ?? 0;
  return { words, internalLinks, title, lang, spamHits, fatal, hint, paths: paths.size, menu: [...paths].slice(0, 100), follow };
}

/** Spam words well above what the site itself used: a new owner. */
function spamTakeover(spamHits: number, baseSpam: number): boolean {
  return spamHits >= 5 && spamHits > baseSpam * 3 + 3;
}

export function scoreSignals(
  s: PageSignals,
  ctx: { lengthRatio?: number; baseLang?: string; baseSpam?: number; baseHint?: string },
): { score: number; verdict: Verdict; reasons: string[] } {
  if (s.fatal) return { score: 5, verdict: 'bad', reasons: [s.fatal] };
  const reasons: string[] = [];
  const baseSpam = ctx.baseSpam ?? 0;
  if (spamTakeover(s.spamHits, baseSpam)) {
    return { score: 5, verdict: 'bad', reasons: [`spam words appeared (${s.spamHits}), likely a new owner`] };
  }
  let score = 100;
  if (s.words < 50) {
    score -= 45;
    reasons.push(`very little text (${s.words} words)`);
  } else if (s.words < 150) {
    score -= 20;
    reasons.push(`little text (${s.words} words)`);
  }
  if (s.internalLinks < 2) {
    score -= 30;
    reasons.push(`almost no internal links (${s.internalLinks})`);
  } else if (s.internalLinks < 5) {
    score -= 10;
    reasons.push(`few internal links (${s.internalLinks})`);
  }
  if (!s.title) {
    score -= 5;
    reasons.push('no title');
  }
  // On a short page with a title and a menu the phrase alone leaves it good; a page without them
  // looks more like a lander. Nothing when the site said it from the start (a restaurant whose
  // online ordering stayed "coming soon").
  if (s.hint && s.hint !== ctx.baseHint) {
    score -= s.title && (s.paths ?? 0) >= 5 ? 10 : 20;
    reasons.push(s.hint);
  }
  if (ctx.lengthRatio !== undefined) {
    if (ctx.lengthRatio < 0.25) {
      score -= 35;
      reasons.push('page much smaller than usual');
    } else if (ctx.lengthRatio < 0.5) {
      score -= 10;
      reasons.push('page smaller than usual');
    }
  }
  if (ctx.baseLang && s.lang && s.lang !== ctx.baseLang) {
    score -= 25;
    reasons.push(`language changed from ${ctx.baseLang} to ${s.lang}`);
  }
  score = Math.max(0, Math.min(100, score));
  return { score, verdict: verdictFor(score), reasons };
}

function verdictFor(score: number): Verdict {
  return score >= 70 ? 'good' : score >= 40 ? 'weak' : 'bad';
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

function isContent(status: string | undefined): boolean {
  return status === '200' || status === '-';
}

function nextMonth(m: string): string {
  let y = Number(m.slice(0, 4));
  let mo = Number(m.slice(4, 6)) + 1;
  if (mo > 12) {
    mo = 1;
    y++;
  }
  return `${y}${String(mo).padStart(2, '0')}`;
}

function prevMonth(m: string): string {
  let y = Number(m.slice(0, 4));
  let mo = Number(m.slice(4, 6)) - 1;
  if (mo < 1) {
    mo = 12;
    y--;
  }
  return `${y}${String(mo).padStart(2, '0')}`;
}

export function groupByMonth(captures: Capture[]): MonthHealth[] {
  const byMonth = new Map<string, Capture[]>();
  for (const c of captures) {
    const m = c.timestamp.slice(0, 6);
    const list = byMonth.get(m);
    if (list) list.push(c);
    else byMonth.set(m, [c]);
  }
  return [...byMonth.keys()].sort().map((month) => {
    const list = byMonth.get(month)!.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const rep =
      [...list].reverse().find((c) => c.statuscode === '200') ??
      [...list].reverse().find((c) => c.statuscode === '-') ??
      [...list].reverse().find((c) => /^3/.test(c.statuscode)) ??
      list[list.length - 1];
    return {
      month,
      captures: list.length,
      timestamp: rep.timestamp,
      original: rep.original,
      statuscode: rep.statuscode,
      length: rep.length,
      digest: rep.digest,
      score: null,
      verdict: 'none' as Verdict,
      reasons: [],
      probed: false,
    };
  });
}

/** Redirects and stub pages followed from the homepage before giving up. */
const MAX_HOPS = 5;

/** Reasons that mean another owner: the window walk never takes them for an outage of the site. */
const NEW_OWNER = /parked|redirects to|sends visitors|spam/;

export interface ScanOptions {
  maxProbes?: number;
  log?: (msg: string) => void;
}

/** What a probe found on the way from the homepage to the page visitors saw. */
interface Outcome {
  /** What visitors saw. */
  signals?: PageSignals;
  /** The URL that content came from; unset for a redirect off the site. */
  scoredAt?: string;
  /** The stub page on the way (without one, an internal redirect), scored itself when the page behind it cannot be had. */
  stub?: { signals: PageSignals; url?: string };
  /** What the homepage capture was: its digest, or where it redirected. */
  via?: string;
  /** Where the stub (or the redirect) sends visitors. */
  leads?: string;
  /** The months of the stub's capture and of the page's, when the archive played them apart. */
  span?: [string, string];
  /** Why the way ended without a page. */
  failure?: string;
  /** How the archive failed or refused (429, 5xx). That says nothing about the site. */
  refused?: string;
  /** The archive would not play what was there before; the stub is not scored as itself either. */
  unsure?: boolean;
}

interface Stub {
  signals: PageSignals;
  url: string;
  timestamp: string;
  /** The homepage capture itself, whose neighbours the archive's index lists. */
  home: boolean;
}

/** The archive itself failed or refused. A client that does not say is judged by the status it got. */
function refusedByArchive(res: { status: number; reason: string; transient?: boolean }): boolean {
  return res.transient ?? ((res.status === 429 || res.status >= 500) && res.reason === `HTTP ${res.status}`);
}

function tsTime(ts: string): number {
  return Date.UTC(Number(ts.slice(0, 4)), Number(ts.slice(4, 6)) - 1, Number(ts.slice(6, 8)) || 1, Number(ts.slice(8, 10)) || 0, Number(ts.slice(10, 12)) || 0);
}

const WEEK = 7 * 24 * 3600 * 1000;

export async function scanHealth(client: ArchiveClient, domain: string, opts: ScanOptions = {}): Promise<HealthReport> {
  const log = opts.log ?? (() => {});
  const maxProbes = opts.maxProbes ?? 14;

  // One capture a day is enough to tell the months apart. A busy homepage has hundreds a day, and
  // keeping every row ran the free scan of a large site out of memory, so rows are reduced to one
  // a day as they stream in, keeping the day's page over its redirects and errors.
  // The query itself stays unfiltered: archive.org's CDX server counts rows that collapse, filter
  // or from/to drop against its per-request read cap and then ends the listing without a resume
  // key, so a narrowed query of a busy homepage silently stops years early.
  const byDay = new Map<string, Capture>();
  const keep = (c: Capture) => {
    const day = c.timestamp.slice(0, 8);
    const had = byDay.get(day);
    if (!had || (!isContent(had.statuscode) && isContent(c.statuscode))) byDay.set(day, c);
  };
  for await (const page of client.cdx({ url: `${domain}/`, matchType: 'exact' })) for (const c of page) keep(c);
  const captures = [...byDay.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  byDay.clear();
  log(`homepage: captured on ${captures.length} days`);

  const months = groupByMonth(captures);
  const report: HealthReport = { domain, months, window: {}, host: domain, probes: 0 };
  if (!months.length) return report;

  for (const m of months) {
    if (!isContent(m.statuscode) && !/^3/.test(m.statuscode ?? '')) {
      m.score = 0;
      m.verdict = 'bad';
      m.reasons = [`homepage answered HTTP ${m.statuscode}`];
    }
  }

  const candidates = months.filter((m) => isContent(m.statuscode) || /^3/.test(m.statuscode ?? ''));
  const outcomes = new Map<string, Outcome>();
  // Set by settle(): the months whose page counts, the URL it came from (the homepage itself, or where
  // its redirects or stub led), and the months scored from their stub because the page behind it
  // cannot be had. Other probed months are left unknown and estimated like months not probed.
  const pages = new Map<string, PageSignals>();
  const scoredUrl = new Map<string, string | undefined>();
  // Months whose stub (or internal redirect) leads to a page the archive does not have, with nothing
  // else to go by: scored as the stub itself, a later owner's lander. Such a month is never the
  // snapshot, and inferUnprobed() takes the months around it over that score when those agree.
  const fallbacks = new Map<string, PageSignals>();
  const notes = new Map<string, string>();
  const scored = (m: MonthHealth) => pages.has(m.month);
  // A month scored from its own capture can stand for every capture with the same digest. A
  // redirect's digest is that of its (often empty) body, not of the page it leads to, also when the
  // archive skipped an http -> https redirect and played the page; and a stub's is the stub's. A
  // homepage stub that falls back on itself stands for its digest too: no month with it got its page.
  const vouches = (m: MonthHealth) => (scored(m) || fallbacks.has(m.month)) && isContent(m.statuscode) && scoredUrl.get(m.month) === m.original;
  let refused = 0;
  let refusal = '';

  // The usual size of the homepage, set in rescore() from months that look like the site itself.
  // Taken over all months it would come from a later, heavier spam site and make the real one look thin.
  let refLength = 0;
  const lengthRatio = (m: MonthHealth) => {
    const url = scoredUrl.get(m.month);
    if (m.statuscode !== '200' || refLength <= 0 || (url !== undefined && url !== m.original)) return undefined;
    return (m.length ?? 0) / refLength;
  };

  // A request that failed even after the client's retries (a timeout, a dropped connection) is the
  // archive failing as well, not the site. Only a cancelled scan stops here.
  const play = async (ts: string, url: string): Promise<CaptureResult> => {
    try {
      return await client.fetchCapture(ts, url);
    } catch (err) {
      if (client.signal?.aborted) throw err;
      return { kind: 'missing', status: 0, reason: (err as Error).message, transient: true };
    }
  };

  // The archive plays the capture nearest in time, however far away it is. The page behind a stub
  // counts only if that stub was in place when the page was captured: a later owner's one-link page
  // must not borrow a page of the old site, however soon after it came. When the archive would not
  // play what was there then: why, and whether that was the archive failing.
  const looked = new Map<string, { timestamp?: string; leads?: string; missing?: { reason: string; refused: boolean } }>();
  const look = async (ts: string, original: string) => {
    const key = `${ts} ${original}`;
    let seen = looked.get(key);
    if (!seen) {
      const res = await play(ts, original);
      if (res.kind === 'ok') seen = { timestamp: res.timestamp, leads: analyzePage(decodeText(res.body, res.contentType).text, original, domain).follow };
      else if (res.kind === 'redirect') seen = { timestamp: res.timestamp, leads: toUrl(res.location, original)?.toString() };
      else seen = { missing: { reason: res.reason, refused: refusedByArchive(res) } };
      looked.set(key, seen);
    }
    return seen;
  };
  const stubInPlace = async (stub: Stub, at: string): Promise<boolean | { reason: string; refused: boolean }> => {
    // Fetched in the same crawl: there was no time for the site to change.
    if (Math.abs(tsTime(stub.timestamp) - tsTime(at)) <= WEEK) return true;
    const sameWay = (leads: string | undefined) => {
      const a = leads ? toUrl(leads) : null;
      const b = stub.signals.follow ? toUrl(stub.signals.follow) : null;
      return !!a && !!b && urlKey(a) === urlKey(b);
    };
    if (stub.home) {
      // The archive's index says what the homepage was then: the captures either side of that time
      // must both be this stub. The nearest one alone is not enough, as the page may be the old
      // site's from the gap between its last homepage capture and the takeover.
      const homes = captures.filter((c) => isContent(c.statuscode) || /^3/.test(c.statuscode));
      const before = homes.findLast((c) => c.timestamp <= at);
      const after = homes.find((c) => c.timestamp >= at);
      if (!before || !after) return false;
      const digest = captures.find((c) => c.timestamp === stub.timestamp)?.digest;
      for (const c of new Set([before, after])) {
        if (c.timestamp === stub.timestamp || (digest && c.digest === digest)) continue;
        const seen = await look(c.timestamp, c.original);
        if (seen.missing) return seen.missing;
        if (!sameWay(seen.leads)) return false;
      }
      return true;
    }
    // Another page: the archive plays the capture of it nearest that time. Only one other than the
    // stub's own shows what was there then, if it is from the same crawl or from the other side of
    // that time; the stub was there before and after.
    const seen = await look(at, stub.url);
    if (seen.missing) return seen.missing;
    if (!seen.timestamp || seen.timestamp === stub.timestamp) return false;
    const near = Math.abs(tsTime(seen.timestamp) - tsTime(at)) <= WEEK;
    const across = seen.timestamp < at !== stub.timestamp < at;
    return (near || across) && sameWay(seen.leads);
  };

  const probe = async (m: MonthHealth): Promise<void> => {
    if (m.probed || report.probes >= maxProbes) return;
    m.probed = true;
    report.probes++;
    const o: Outcome = {};
    outcomes.set(m.month, o);
    let url = m.original!;
    let res = await play(m.timestamp!, url);
    const to = res.kind === 'redirect' ? toUrl(res.location, url) : null;
    o.via = to ? `to ${urlKey(to)}` : (isContent(m.statuscode) && m.digest) || m.month;
    // The last stub page on the way, and the first internal redirect.
    let stub: Stub | undefined;
    let redirect: string | undefined;
    let redirectKey: string | undefined;
    let failure = 'redirect could not be followed';
    const start = toUrl(url);
    const seen = new Set(start ? [urlKey(start)] : []);
    // Follow the site's own redirects (/ -> /blog -> /blog/) and stub pages to what visitors saw.
    for (let hop = 0; ; hop++) {
      let next: URL | null = null;
      let ts = m.timestamp!;
      if (res.kind === 'missing') {
        failure = `capture not playable (${res.reason})`;
        if (refusedByArchive(res)) o.refused = res.reason;
        break;
      }
      if (res.kind === 'ok') {
        if (stub) {
          const inPlace = await stubInPlace(stub, res.timestamp);
          const when = `${res.timestamp.slice(0, 4)}-${res.timestamp.slice(4, 6)}`;
          if (typeof inPlace === 'object') {
            failure = `the page it leads to is a capture from ${when}, and the archive did not play what ${stub.home ? 'the homepage' : 'the page before it'} was then (${inPlace.reason})`;
            if (inPlace.refused) o.refused = inPlace.reason;
            o.unsure = true;
            break;
          }
          if (!inPlace) {
            failure = `the page it leads to is a capture from ${when}, when ${stub.home ? 'the homepage' : 'the page before it'} was another page`;
            break;
          }
          const span = [...(o.span ?? []), stub.timestamp.slice(0, 6), res.timestamp.slice(0, 6)].sort();
          o.span = [span[0], span[span.length - 1]];
        }
        const s = analyzePage(decodeText(res.body, res.contentType).text, url, domain);
        if (!s.follow) {
          o.signals = s;
          o.scoredAt = url;
          break;
        }
        stub = { signals: s, url, timestamp: res.timestamp, home: hop === 0 };
        next = toUrl(s.follow);
        ts = res.timestamp;
      } else {
        next = toUrl(res.location, url);
        ts = res.timestamp;
        // Not scoredAt: a redirect's digest is that of its body, the same wherever it points.
        if (next && !isInternal(next, domain)) {
          o.signals = { words: 0, internalLinks: 0, title: '', lang: '', spamHits: 0, fatal: `redirects to ${bareHost(next.hostname)}` };
          break;
        }
        if (next && redirect === undefined) {
          redirect = next.pathname + next.search;
          redirectKey = urlKey(next);
        }
      }
      if (!next || hop >= MAX_HOPS || seen.has(urlKey(next))) break;
      seen.add(urlKey(next));
      url = next.toString();
      res = await play(ts, url);
    }
    if (stub) {
      o.stub = { signals: stub.signals, url: stub.url };
      const target = toUrl(stub.signals.follow!);
      if (target) o.leads = urlKey(target);
    } else if (redirect !== undefined) {
      o.stub = { signals: { words: 0, internalLinks: 0, title: '', lang: '', spamHits: 0, fatal: `its redirect to ${redirect} leads nowhere` } };
      o.leads = redirectKey;
    }
    if (o.signals) return;
    // A real page with a slow refresh stands by itself.
    if (stub && scoreSignals(stub.signals, {}).verdict === 'good') {
      o.signals = stub.signals;
      o.scoredAt = stub.url;
      return;
    }
    o.failure = failure;
    if (o.refused) {
      refused++;
      refusal ||= o.refused;
    }
  };

  // Which probed months count, and with what. An archive failure says nothing about the site, so such
  // a month is left unknown. A stub (or redirect) whose page cannot be had falls back on itself, an
  // empty page: a later owner's lander (`location.href = "/lander"`, never archived). Not when the
  // same stub, or one leading to the same page, led to its page in another month: then it is the
  // site's own, and the archive lost the page this time.
  const settle = () => {
    pages.clear();
    scoredUrl.clear();
    fallbacks.clear();
    notes.clear();
    const own = new Map<string, PageSignals>();
    for (const m of months) {
      const o = outcomes.get(m.month);
      if (m.digest && isContent(m.statuscode) && o?.signals && o.scoredAt === m.original) own.set(m.digest, o.signals);
    }
    // The homepage was another page: a real one, or a parked, spam or redirect page of another owner.
    const another = (k: MonthHealth) => {
      const o = outcomes.get(k.month);
      const s = o?.signals && (o.scoredAt === k.original || o.scoredAt === undefined) ? o.signals : k.digest ? own.get(k.digest) : undefined;
      if (!s) return false;
      return s.fatal ? NEW_OWNER.test(s.fatal) : spamTakeover(s.spamHits, 0) || scoreSignals(s, {}).verdict === 'good';
    };
    for (const m of months) {
      const o = outcomes.get(m.month);
      if (!o) continue;
      if (!o.signals) {
        notes.set(m.month, o.failure ?? '');
        continue;
      }
      // A page captured apart from its stub, with another page on the homepage in between: the same
      // stub again after a parked spell is a later owner's.
      const span = o.span;
      if (span && months.some((k) => k.month > span[0] && k.month < span[1] && k.digest !== m.digest && another(k))) {
        notes.set(m.month, `the page it leads to and the stub were captured in ${span[0].slice(0, 4)}-${span[0].slice(4)} and ${span[1].slice(0, 4)}-${span[1].slice(4)}, with another page on the homepage in between`);
        continue;
      }
      pages.set(m.month, o.signals);
      scoredUrl.set(m.month, o.scoredAt);
    }
    for (const m of months) {
      const o = outcomes.get(m.month);
      if (!o?.stub || o.refused || o.unsure || pages.has(m.month)) continue;
      const sibling = (k: MonthHealth) => {
        const ok = outcomes.get(k.month);
        return k !== m && !!ok && (ok.via === o.via || (!!o.leads && ok.leads === o.leads)) && pages.has(k.month) && !!scoredUrl.get(k.month);
      };
      if (months.some(sibling)) continue;
      fallbacks.set(m.month, o.stub.signals);
      scoredUrl.set(m.month, o.stub.url);
    }
  };

  const rescore = () => {
    settle();
    const scoredInOrder = months.filter(scored);
    // The site's base line comes from its first pages.
    const early = scoredInOrder.slice(0, 3).map((m) => pages.get(m.month)!).filter((s) => !s.fatal);
    const langs = early.map((s) => s.lang).filter(Boolean);
    const baseLang = langs.length ? langs.sort((a, b) => langs.filter((x) => x === b).length - langs.filter((x) => x === a).length)[0] : undefined;
    const baseSpam = early.length ? Math.min(...early.map((s) => s.spamHits)) : 0;
    // A phrase every early capture shows is part of the site, like its base level of spam words. Only
    // on the site's own pages, though: a later owner's lander that repeats it ("related links" over
    // its ads) has another title or another menu.
    const baseHint = early.length && early.every((s) => s.hint === early[0].hint) ? early[0].hint : undefined;
    const titles = new Set(early.map((s) => s.title));
    const menu = new Set(early.flatMap((s) => s.menu ?? []));
    const sameSite = (s: PageSignals) => titles.has(s.title) && (s.menu ?? []).filter((p) => menu.has(p)).length >= Math.min(3, menu.size);
    const itself = scoredInOrder.filter((m) => {
      const s = pages.get(m.month)!;
      return m.statuscode === '200' && vouches(m) && !s.fatal && !spamTakeover(s.spamHits, baseSpam) && (!baseLang || !s.lang || s.lang === baseLang);
    });
    refLength = percentile(itself.map((m) => m.length ?? 0), 0.75);
    for (const m of months) {
      if (!m.probed) continue;
      const s = pages.get(m.month) ?? fallbacks.get(m.month);
      const note = notes.get(m.month) ?? '';
      if (!s) {
        m.score = null;
        m.verdict = 'none';
        m.reasons = [note];
        continue;
      }
      const r = scoreSignals(s, { lengthRatio: lengthRatio(m), baseLang, baseSpam, baseHint: baseHint && sameSite(s) ? baseHint : undefined });
      m.score = r.score;
      m.verdict = r.verdict;
      m.reasons = r.reasons;
      if (fallbacks.has(m.month) && note) m.reasons.push(note.startsWith('the page it leads to') ? note : `the page it leads to: ${note}`);
    }
  };

  // 1. Spread probes over the whole history.
  const firstRound = Math.max(2, Math.ceil(maxProbes * 0.6));
  const spread = pickSpread(candidates, firstRound);
  // Every probe so far refused after the client's own retries: archive.org is blocking or down, and
  // each further probe would take another minute of back-off for nothing. The first, last and middle
  // captures go first, so a stretch of old captures the archive cannot serve does not look like that.
  const blocked = () => refused >= 3 && refused === report.probes;
  const order = spread.length ? [spread[0], spread[spread.length - 1], spread[Math.floor(spread.length / 2)], ...spread] : [];
  for (const m of new Set(order)) {
    if (blocked()) break;
    await probe(m);
  }
  rescore();

  // 2. Narrow down the month the site stopped being good. Every pass probes a month that was not
  // probed before, so the loop ends.
  while (report.probes < maxProbes && !blocked()) {
    const good = candidates.filter((m) => m.probed && scored(m) && m.verdict === 'good');
    const lastGood = good[good.length - 1];
    let next: MonthHealth | undefined;
    if (lastGood) {
      // Bisect over the months not probed yet between the last good and the first bad one. Probed
      // months in between (weak, or not playable) cannot move either bound.
      const iGood = candidates.indexOf(lastGood);
      const iBad = candidates.findIndex((m, i) => i > iGood && m.probed && m.verdict === 'bad');
      if (iBad < 0) break;
      // A stub whose page the archive lost bounds the search only if the site did not go on right
      // after it: a lost page is one month (a dated /edition/20181210/), a later owner's lander lasts.
      // The month after it is looked at first, unless the next probe found such a stub again.
      const later = candidates.slice(iBad + 1);
      const nextProbed = later.find((m) => m.probed && m.verdict !== 'none');
      if (fallbacks.has(candidates[iBad].month) && !(nextProbed && fallbacks.has(nextProbed.month)) && later[0] && !later[0].probed) next = later[0];
      else {
        const between = candidates.slice(iGood + 1, iBad).filter((m) => !m.probed);
        next = between[Math.floor((between.length - 1) / 2)];
      }
    } else {
      // No good month yet: probe the middle of the longest stretch of unknown months between two
      // probes. A month with the digest of one already scored would score the same, so it is skipped.
      const known = new Set(months.filter((m) => m.digest && vouches(m)).map((m) => m.digest));
      let best: MonthHealth[] = [];
      let run: MonthHealth[] = [];
      for (const m of [...candidates, undefined]) {
        if (!m || m.probed) {
          if (run.length > best.length) best = run;
          run = [];
        } else if (!(m.digest && known.has(m.digest))) run.push(m);
      }
      next = best[Math.floor((best.length - 1) / 2)];
    }
    if (!next) break;
    await probe(next);
    rescore();
  }

  inferUnprobed(months, lengthRatio, scored, vouches, (m) => (fallbacks.has(m.month) ? (notes.get(m.month) ?? '') : undefined));

  // 3. Last good snapshot and the window around it. A month the archive could not play is never the
  // snapshot, whatever its neighbours say.
  const goods = months.filter((m) => m.verdict === 'good' && m.timestamp && !(m.probed && !scored(m)));
  const last = goods[goods.length - 1];
  if (!last && refused && refused * 2 >= report.probes) {
    // Most probes were refused, so "no capture looks like a real website" would be a guess.
    throw new Error(`archive.org refused or failed ${refused} of the ${report.probes} homepage captures tried (${refusal}), so the scan cannot tell when ${domain} was a real website. Try again later.`);
  }
  if (last) {
    report.lastGood = { month: last.month, timestamp: last.timestamp!, score: last.score ?? 0, original: last.original! };
    const i = months.indexOf(last);
    const firstBadAfter = months.slice(i + 1).find((m) => m.verdict === 'bad');
    if (firstBadAfter) {
      const prev = prevMonth(firstBadAfter.month);
      const lastDay = new Date(Date.UTC(Number(prev.slice(0, 4)), Number(prev.slice(4, 6)), 0)).getUTCDate();
      report.window.to = `${prev}${lastDay}235959`;
    }
    // Walk back to where the site began. A parked, spam or redirected month means another owner. Bad
    // months between good ones (HTTP errors, a maintenance page) are an outage of the same site,
    // unless they went on for half a year.
    const newOwner = (m: MonthHealth) => m.reasons.some((r) => NEW_OWNER.test(r));
    for (let j = i - 1; j >= 0; j--) {
      if (months[j].verdict !== 'bad') continue;
      let k = j;
      while (k > 0 && months[k - 1].verdict === 'bad') k--;
      const run = months.slice(k, j + 1);
      const outage =
        !run.some(newOwner) &&
        (run.length === 1 || (monthsBetween(months[k].month, months[j].month) < 6 && months.slice(0, k).some((m) => m.verdict === 'good')));
      if (!outage) {
        report.window.from = `${nextMonth(months[j].month)}01000000`;
        break;
      }
      j = k;
    }
  }

  // 4. www or not, as the site itself used it. A homepage that always redirects (to /index.php, say)
  // has no content captures; then the URLs the probes ended up on decide.
  const inWindow = (ts: string) => (!report.window.from || ts >= report.window.from) && (!report.window.to || ts <= report.window.to);
  let urls = captures.filter((c) => isContent(c.statuscode) && inWindow(c.timestamp)).map((c) => c.original);
  if (!urls.length) urls = months.filter((m) => m.timestamp && inWindow(m.timestamp)).flatMap((m) => scoredUrl.get(m.month) ?? []);
  if (!urls.length && report.lastGood) urls = [report.lastGood.original];
  const www = urls.filter((u) => /^(https?:\/\/)?www\d{0,3}\./i.test(u)).length;
  report.host = www > urls.length / 2 ? `www.${domain}` : domain;
  return report;
}

function monthsBetween(a: string, b: string): number {
  return Number(b.slice(0, 4)) * 12 + Number(b.slice(4, 6)) - (Number(a.slice(0, 4)) * 12 + Number(a.slice(4, 6)));
}

function pickSpread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const out = new Set<T>();
  for (let k = 0; k < n; k++) out.add(items[Math.round((k * (items.length - 1)) / (n - 1))]);
  return [...out];
}

/**
 * Estimates months that were not probed, or whose capture could not be played back. `scored` tells
 * which months have a verdict from their content; `fallback` which were scored from a stub whose
 * page the archive does not have, with why; `vouches` which of either can stand for every capture
 * with the same digest.
 */
function inferUnprobed(
  months: MonthHealth[],
  lengthRatio: (m: MonthHealth) => number | undefined,
  scored: (m: MonthHealth) => boolean,
  vouches: (m: MonthHealth) => boolean,
  fallback: (m: MonthHealth) => string | undefined,
): void {
  const counted = (m: MonthHealth) => scored(m) || fallback(m) !== undefined;
  const around = (i: number) => {
    let before: MonthHealth | undefined;
    let after: MonthHealth | undefined;
    for (let j = i - 1; j >= 0 && !before; j--) if (counted(months[j])) before = months[j];
    for (let j = i + 1; j < months.length && !after; j++) if (counted(months[j])) after = months[j];
    return { before, after };
  };

  // Such a stub between pages that agree is the site's own, whose page the archive lost that month:
  // it is what they are. Next to another such stub, or at a change, it stays scored as itself.
  const estimates = new Map<MonthHealth, { score: number; verdict: Verdict; reasons: string[] }>();
  for (let i = 0; i < months.length; i++) {
    const note = fallback(months[i]);
    if (note === undefined) continue;
    const { before, after } = around(i);
    if (before && after && scored(before) && scored(after) && before.verdict === after.verdict) {
      estimates.set(months[i], { score: Math.round(((before.score ?? 0) + (after.score ?? 0)) / 2), verdict: before.verdict, reasons: [note, 'estimated from the months around it'] });
    }
  }
  for (const [m, e] of estimates) Object.assign(m, e);
  // Not with a verdict taken from other months; and a page scored from its content goes over a stub.
  const byDigest = new Map<string, MonthHealth>();
  for (const m of months) if (m.digest && vouches(m) && !scored(m) && !estimates.has(m)) byDigest.set(m.digest, m);
  for (const m of months) if (m.digest && vouches(m) && scored(m)) byDigest.set(m.digest, m);

  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    if (counted(m) || m.score !== null) continue;
    const note = m.reasons; // why a probe did not count, if it was made
    const same = m.digest ? byDigest.get(m.digest) : undefined;
    if (same) {
      m.score = same.score;
      m.verdict = same.verdict;
      // With its reasons: the window walk reads them to tell a parked page from an outage.
      m.reasons = [...note, `same content as ${same.month.slice(0, 4)}-${same.month.slice(4)}`, ...same.reasons];
      continue;
    }
    const { before, after } = around(i);
    const ratio = lengthRatio(m);
    if (before && after && before.verdict === after.verdict) {
      m.score = Math.round(((before.score ?? 0) + (after.score ?? 0)) / 2);
      m.verdict = before.verdict;
      if (ratio !== undefined && ratio < 0.25 && m.verdict === 'good') {
        m.score -= 35;
        m.verdict = verdictFor(m.score);
      }
      m.reasons = [...note, 'estimated from the months around it'];
    } else if (before && !after && before.verdict === 'bad') {
      m.score = before.score;
      m.verdict = 'bad';
      m.reasons = [...note, 'after the site went down'];
    } else {
      m.score = ratio !== undefined && ratio < 0.25 ? 30 : 55;
      m.verdict = verdictFor(m.score);
      m.reasons = [...note, 'not checked; near a change'];
    }
  }
}
