// Finds when the site was in good shape.
//
// The last captures of an expired domain are usually a parking page ("this domain may be for
// sale"), a hosting error or a spam site run by whoever bought the domain next. Taking the newest
// capture restores that junk. This module scores the homepage month by month and returns the last
// good snapshot plus the time window in which the site was itself.

import type { ArchiveClient, Capture } from './archive.ts';
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
  /** Where a stub homepage (internal meta refresh, frameset, "enter" page) sends visitors. */
  follow?: string;
}

export interface MonthHealth {
  month: string; // YYYYMM
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
const JS_LOCATION = /(?:\blocation\.(?:href|replace|assign)|\b(?:window|document|top|self)\.location)\s*[=(]\s*['"]([^'"]+)['"]/i;

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
    const jsUrl = JS_LOCATION.exec(scripts)?.[1];
    const target = toUrl(refreshUrl ?? jsUrl ?? '', pageUrl);
    if (target && (refreshUrl || jsUrl)) {
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
    // A frame named "contents" is usually the table of contents, not the content.
    const main = frames.find((f) => /main/i.test(f.name)) ?? frames.find((f) => /\b(content|body)\b/i.test(f.name)) ?? frames[frames.length - 1];
    const pick = main ?? iframes[0] ?? (ways.length <= 3 ? ways[0] : undefined);
    follow = pick?.url.toString();
  }
  const spamHits = hay.match(SPAM)?.length ?? 0;
  return { words, internalLinks, title, lang, spamHits, fatal, hint, follow };
}

/** Spam words well above what the site itself used: a new owner. */
function spamTakeover(spamHits: number, baseSpam: number): boolean {
  return spamHits >= 5 && spamHits > baseSpam * 3 + 3;
}

export function scoreSignals(
  s: PageSignals,
  ctx: { lengthRatio?: number; baseLang?: string; baseSpam?: number },
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
  if (s.hint) {
    score -= 20;
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

export interface ScanOptions {
  maxProbes?: number;
  log?: (msg: string) => void;
}

export async function scanHealth(client: ArchiveClient, domain: string, opts: ScanOptions = {}): Promise<HealthReport> {
  const log = opts.log ?? (() => {});
  const maxProbes = opts.maxProbes ?? 14;

  const captures: Capture[] = [];
  for await (const page of client.cdx({ url: `${domain}/`, matchType: 'exact' })) captures.push(...page);
  log(`homepage: ${captures.length} captures in the archive`);

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
  const signalsByMonth = new Map<string, PageSignals>();
  // The URL whose content was scored: the homepage itself, or where its redirects or stub page led.
  const scoredUrl = new Map<string, string>();
  // Probes the archive could not play back. They say nothing about the site.
  const unplayable = new Set<MonthHealth>();
  const scored = (m: MonthHealth) => signalsByMonth.has(m.month);
  // Only a month scored from its own capture vouches for other captures with the same digest. A
  // redirect's digest is that of its (often empty) body, not of the page it leads to.
  const ownContent = (m: MonthHealth) => scored(m) && scoredUrl.get(m.month) === m.original;

  // The usual size of the homepage, set in rescore() from months that look like the site itself.
  // Taken over all months it would come from a later, heavier spam site and make the real one look thin.
  let refLength = 0;
  const lengthRatio = (m: MonthHealth) => {
    const url = scoredUrl.get(m.month);
    if (m.statuscode !== '200' || refLength <= 0 || (url !== undefined && url !== m.original)) return undefined;
    return (m.length ?? 0) / refLength;
  };

  const probe = async (m: MonthHealth): Promise<void> => {
    if (m.probed || report.probes >= maxProbes) return;
    m.probed = true;
    report.probes++;
    let url = m.original!;
    let res = await client.fetchCapture(m.timestamp!, url);
    let signals: PageSignals | undefined;
    const start = toUrl(url);
    const seen = new Set(start ? [urlKey(start)] : []);
    // Follow the site's own redirects (/ -> /blog -> /blog/) and stub pages to what visitors saw.
    for (let hop = 0; ; hop++) {
      let next: URL | null = null;
      let ts = m.timestamp!;
      if (res.kind === 'ok') {
        signals = analyzePage(decodeText(res.body, res.contentType).text, url, domain);
        scoredUrl.set(m.month, url);
        next = signals.follow ? toUrl(signals.follow) : null;
        ts = res.timestamp;
      } else if (res.kind === 'redirect') {
        next = toUrl(res.location, url);
        ts = res.timestamp;
        if (next && !isInternal(next, domain)) {
          signals = { words: 0, internalLinks: 0, title: '', lang: '', spamHits: 0, fatal: `redirects to ${bareHost(next.hostname)}` };
          break;
        }
      }
      if (!next || hop >= MAX_HOPS || seen.has(urlKey(next))) break;
      seen.add(urlKey(next));
      url = next.toString();
      res = await client.fetchCapture(ts, url);
    }
    if (signals) {
      signalsByMonth.set(m.month, signals);
      return;
    }
    // Left unknown: estimated from the months around it later, like a month that was not probed.
    unplayable.add(m);
    m.reasons = [res.kind === 'missing' ? `capture not playable (${res.reason})` : 'redirect could not be followed'];
  };

  const rescore = () => {
    const probedInOrder = months.filter(scored);
    const early = probedInOrder.slice(0, 3).map((m) => signalsByMonth.get(m.month)!).filter((s) => !s.fatal);
    const langs = early.map((s) => s.lang).filter(Boolean);
    const baseLang = langs.length ? langs.sort((a, b) => langs.filter((x) => x === b).length - langs.filter((x) => x === a).length)[0] : undefined;
    const baseSpam = early.length ? Math.min(...early.map((s) => s.spamHits)) : 0;
    const itself = probedInOrder.filter((m) => {
      const s = signalsByMonth.get(m.month)!;
      return m.statuscode === '200' && ownContent(m) && !s.fatal && !spamTakeover(s.spamHits, baseSpam) && (!baseLang || !s.lang || s.lang === baseLang);
    });
    refLength = percentile(itself.map((m) => m.length ?? 0), 0.75);
    for (const m of probedInOrder) {
      const r = scoreSignals(signalsByMonth.get(m.month)!, { lengthRatio: lengthRatio(m), baseLang, baseSpam });
      m.score = r.score;
      m.verdict = r.verdict;
      m.reasons = r.reasons;
    }
  };

  // 1. Spread probes over the whole history.
  const firstRound = Math.max(2, Math.ceil(maxProbes * 0.6));
  const spread = pickSpread(candidates, firstRound);
  for (const m of spread) await probe(m);
  rescore();

  // 2. Narrow down the month the site stopped being good. Every pass probes a month that was not
  // probed before, so the loop ends.
  while (report.probes < maxProbes) {
    const good = candidates.filter((m) => m.probed && m.verdict === 'good');
    const lastGood = good[good.length - 1];
    let next: MonthHealth | undefined;
    if (lastGood) {
      // Bisect over the months not probed yet between the last good and the first bad one. Probed
      // months in between (weak, or not playable) cannot move either bound.
      const iGood = candidates.indexOf(lastGood);
      const iBad = candidates.findIndex((m, i) => i > iGood && m.probed && m.verdict === 'bad');
      if (iBad < 0) break;
      const between = candidates.slice(iGood + 1, iBad).filter((m) => !m.probed);
      next = between[Math.floor((between.length - 1) / 2)];
    } else {
      // No good month yet: probe the middle of the longest stretch of unknown months between two
      // probes. A month with the digest of one already scored would score the same, so it is skipped.
      const known = new Set(months.filter((m) => m.digest && ownContent(m)).map((m) => m.digest));
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

  inferUnprobed(months, lengthRatio, scored, ownContent);

  // 3. Last good snapshot and the window around it.
  const goods = months.filter((m) => m.verdict === 'good' && m.timestamp && !unplayable.has(m));
  const last = goods[goods.length - 1];
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
    const newOwner = (m: MonthHealth) => m.reasons.some((r) => /parked|redirects to|sends visitors|spam/.test(r));
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
  if (!urls.length) urls = months.filter((m) => m.timestamp && inWindow(m.timestamp) && scoredUrl.has(m.month)).map((m) => scoredUrl.get(m.month)!);
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
 * which months have a verdict from their content; `ownContent` which of them can stand for every
 * capture with the same digest.
 */
function inferUnprobed(
  months: MonthHealth[],
  lengthRatio: (m: MonthHealth) => number | undefined,
  scored: (m: MonthHealth) => boolean,
  ownContent: (m: MonthHealth) => boolean,
): void {
  const byDigest = new Map<string, MonthHealth>();
  for (const m of months) if (m.digest && ownContent(m)) byDigest.set(m.digest, m);

  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    if (scored(m) || m.score !== null) continue;
    const note = m.reasons; // why a probe did not count, if it was made
    const same = m.digest ? byDigest.get(m.digest) : undefined;
    if (same) {
      m.score = same.score;
      m.verdict = same.verdict;
      m.reasons = [...note, `same content as ${same.month.slice(0, 4)}-${same.month.slice(4)}`];
      continue;
    }
    let before: MonthHealth | undefined;
    let after: MonthHealth | undefined;
    for (let j = i - 1; j >= 0 && !before; j--) if (scored(months[j])) before = months[j];
    for (let j = i + 1; j < months.length && !after; j++) if (scored(months[j])) after = months[j];
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
