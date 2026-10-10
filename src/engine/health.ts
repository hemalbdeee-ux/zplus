// Finds when the site was in good shape.
//
// The last captures of an expired domain are usually a parking page ("this domain may be for
// sale"), a hosting error or a spam site run by whoever bought the domain next. Taking the newest
// capture restores that junk. This module scores the homepage month by month and returns the last
// good snapshot plus the time window in which the site was itself.

import type { ArchiveClient, Capture } from './archive.ts';
import { decodeText } from './charset.ts';
import { countWords, loadHtml, visibleText } from './html.ts';
import { bareHost, isInternal, toUrl } from './url.ts';

export type Verdict = 'good' | 'weak' | 'bad' | 'none';

export interface PageSignals {
  words: number;
  internalLinks: number;
  title: string;
  lang: string;
  spamHits: number;
  /** A reason that alone makes the capture unusable (parked, dead, moved). */
  fatal: string | null;
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

const PARKED = [
  /\b(this|the) domain( name)? (may be|is|might be|could be) (for sale|available)/,
  /\bbuy (this|the) domain\b/,
  /\bdomain( name)? (is )?for sale\b/,
  /\b(make an offer|inquire about this domain|get this domain|this domain is available)\b/,
  /\b(sedo|sedoparking|dan\.com|afternic|hugedomains|undeveloped\.com|bodis|parkingcrew|domainmarket|brandbucket|squadhelp|parklogic|domainnamesales)\b/,
  /\b(domain parking|parked (free|domain|by)|this (web ?page|domain|site) is parked)\b/,
  /\b(this domain|domain) (has )?expired\b|\bexpired domain\b|\brenew (this|your) domain\b/,
];
const PARKED_PPC = /\brelated (searches|links)\b/;
const DEAD = [
  /\b(this )?account (has been |is )?suspended\b/,
  /\b(default (web )?(site|server) page|apache2? (ubuntu |debian )?default page|welcome to nginx|test page for (the )?(apache|nginx)|iis windows server)\b/,
  /\bit works!/,
  /\b(future home of|coming soon|under construction|website coming soon)\b/,
  /\bsite (is )?(under maintenance|temporarily unavailable)\b/,
  /\bindex of \//,
  /\b(error establishing a database connection|bandwidth limit exceeded|403 forbidden|404 not found|500 internal server error|service (temporarily )?unavailable)\b/,
];
const SPAM = /\b(casino|slot gacor|slots?|judi|togel|poker online|viagra|cialis|levitra|replica watches|payday loans?|bandar|sbobet|gacor|maxwin|bokep|escort service|cbd oil)\b/gi;

export function analyzePage(html: string, pageUrl: string, domain: string): PageSignals {
  const $ = loadHtml(html);
  const text = visibleText($);
  const words = countWords(text);
  const title = $('title').first().text().trim();
  const lang = ($('html').attr('lang') ?? '').trim().toLowerCase().slice(0, 2);
  const hay = `${title} ${text.slice(0, 30_000)}`.toLowerCase();

  let internalLinks = 0;
  $('a[href]').each((_, el) => {
    const u = toUrl($(el).attr('href') ?? '', pageUrl);
    if (u && isInternal(u, domain)) internalLinks++;
  });

  let fatal: string | null = null;
  if (words < 600) {
    const hit = PARKED.find((re) => re.test(hay));
    if (hit) fatal = `parked domain page ("${hay.match(hit)?.[0]}")`;
    else if (words < 250 && PARKED_PPC.test(hay)) fatal = 'parked domain page (ad links)';
  }
  if (!fatal && words < 300) {
    const hit = DEAD.find((re) => re.test(hay));
    if (hit) fatal = `hosting or error page ("${hay.match(hit)?.[0]}")`;
  }
  if (!fatal) {
    const refresh = $('meta[http-equiv]').filter((_, el) => ($(el).attr('http-equiv') ?? '').toLowerCase() === 'refresh').attr('content') ?? '';
    const refreshUrl = /url\s*=\s*['"]?([^'"\s]+)/i.exec(refresh)?.[1];
    const jsUrl = words < 100 ? /(?:location\.(?:href|replace)|window\.location)\s*[=(]\s*['"](https?:\/\/[^'"]+)/i.exec($.html())?.[1] : undefined;
    const target = toUrl(refreshUrl ?? jsUrl ?? '', pageUrl);
    if (target && (refreshUrl || jsUrl) && !isInternal(target, domain)) fatal = `sends visitors to ${bareHost(target.hostname)}`;
  }
  const spamHits = hay.match(SPAM)?.length ?? 0;
  return { words, internalLinks, title, lang, spamHits, fatal };
}

export function scoreSignals(
  s: PageSignals,
  ctx: { lengthRatio?: number; baseLang?: string; baseSpam?: number },
): { score: number; verdict: Verdict; reasons: string[] } {
  if (s.fatal) return { score: 5, verdict: 'bad', reasons: [s.fatal] };
  const reasons: string[] = [];
  const baseSpam = ctx.baseSpam ?? 0;
  if (s.spamHits >= 5 && s.spamHits > baseSpam * 3 + 3) {
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

  const refLength = percentile(
    months.filter((m) => m.statuscode === '200').map((m) => m.length ?? 0),
    0.75,
  );
  const lengthRatio = (m: MonthHealth) => (m.statuscode === '200' && refLength > 0 ? (m.length ?? 0) / refLength : undefined);

  for (const m of months) {
    if (!isContent(m.statuscode) && !/^3/.test(m.statuscode ?? '')) {
      m.score = 0;
      m.verdict = 'bad';
      m.reasons = [`homepage answered HTTP ${m.statuscode}`];
    }
  }

  const candidates = months.filter((m) => isContent(m.statuscode) || /^3/.test(m.statuscode ?? ''));
  const signalsByMonth = new Map<string, PageSignals>();
  const probe = async (m: MonthHealth): Promise<void> => {
    if (m.probed || report.probes >= maxProbes) return;
    m.probed = true;
    report.probes++;
    const res = await client.fetchCapture(m.timestamp!, m.original!);
    if (res.kind === 'ok') {
      const { text } = decodeText(res.body, res.contentType);
      signalsByMonth.set(m.month, analyzePage(text, m.original!, domain));
      return;
    }
    if (res.kind === 'redirect') {
      const target = toUrl(res.location, m.original);
      if (target && isInternal(target, domain)) {
        const follow = await client.fetchCapture(res.timestamp, target.toString());
        if (follow.kind === 'ok') {
          const { text } = decodeText(follow.body, follow.contentType);
          signalsByMonth.set(m.month, analyzePage(text, target.toString(), domain));
          return;
        }
      } else if (target) {
        signalsByMonth.set(m.month, { words: 0, internalLinks: 0, title: '', lang: '', spamHits: 0, fatal: `redirects to ${bareHost(target.hostname)}` });
        return;
      }
    }
    m.score = 0;
    m.verdict = 'bad';
    m.reasons = [res.kind === 'missing' ? `capture not playable (${res.reason})` : 'redirect could not be followed'];
  };

  const rescore = () => {
    const probedInOrder = months.filter((m) => signalsByMonth.has(m.month));
    const early = probedInOrder.slice(0, 3).map((m) => signalsByMonth.get(m.month)!).filter((s) => !s.fatal);
    const langs = early.map((s) => s.lang).filter(Boolean);
    const baseLang = langs.length ? langs.sort((a, b) => langs.filter((x) => x === b).length - langs.filter((x) => x === a).length)[0] : undefined;
    const baseSpam = early.length ? Math.min(...early.map((s) => s.spamHits)) : 0;
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

  // 2. Narrow down the month the site stopped being good.
  for (;;) {
    const good = candidates.filter((m) => m.probed && m.verdict === 'good');
    const lastGood = good[good.length - 1];
    if (!lastGood) {
      const untried = candidates.filter((m) => !m.probed);
      if (!untried.length || report.probes >= maxProbes) break;
      await probe(untried[Math.floor(untried.length / 2)]);
      rescore();
      continue;
    }
    const iGood = candidates.indexOf(lastGood);
    const iBad = candidates.findIndex((m, i) => i > iGood && m.probed && m.verdict === 'bad');
    if (iBad < 0 || iBad - iGood <= 1 || report.probes >= maxProbes) break;
    await probe(candidates[Math.floor((iGood + iBad) / 2)]);
    rescore();
  }

  inferUnprobed(months, lengthRatio);

  // 3. Last good snapshot and the window around it.
  const goods = months.filter((m) => m.verdict === 'good' && m.timestamp);
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
    for (let j = i - 1; j >= 0; j--) {
      const m = months[j];
      const hardBad = m.verdict === 'bad' && m.probed && m.reasons.some((r) => /parked|redirects to|sends visitors|spam|hosting or error/.test(r));
      const streak = m.verdict === 'bad' && j > 0 && months[j - 1].verdict === 'bad';
      if (hardBad || streak) {
        report.window.from = `${nextMonth(m.month)}01000000`;
        break;
      }
    }
  }

  // 4. www or not, as the site itself used it.
  const inWindow = captures.filter(
    (c) =>
      isContent(c.statuscode) &&
      (!report.window.from || c.timestamp >= report.window.from) &&
      (!report.window.to || c.timestamp <= report.window.to),
  );
  const www = inWindow.filter((c) => /^(https?:\/\/)?www\d{0,3}\./i.test(c.original)).length;
  report.host = www > inWindow.length / 2 ? `www.${domain}` : domain;
  return report;
}

function pickSpread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const out = new Set<T>();
  for (let k = 0; k < n; k++) out.add(items[Math.round((k * (items.length - 1)) / (n - 1))]);
  return [...out];
}

function inferUnprobed(months: MonthHealth[], lengthRatio: (m: MonthHealth) => number | undefined): void {
  const byDigest = new Map<string, MonthHealth>();
  for (const m of months) if (m.probed && m.digest && m.score !== null) byDigest.set(m.digest, m);

  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    if (m.probed || m.score !== null) continue;
    const same = m.digest ? byDigest.get(m.digest) : undefined;
    if (same) {
      m.score = same.score;
      m.verdict = same.verdict;
      m.reasons = [`same content as ${same.month.slice(0, 4)}-${same.month.slice(4)}`];
      continue;
    }
    let before: MonthHealth | undefined;
    let after: MonthHealth | undefined;
    for (let j = i - 1; j >= 0 && !before; j--) if (months[j].probed && months[j].score !== null) before = months[j];
    for (let j = i + 1; j < months.length && !after; j++) if (months[j].probed && months[j].score !== null) after = months[j];
    const ratio = lengthRatio(m);
    if (before && after && before.verdict === after.verdict) {
      m.score = Math.round(((before.score ?? 0) + (after.score ?? 0)) / 2);
      m.verdict = before.verdict;
      if (ratio !== undefined && ratio < 0.25 && m.verdict === 'good') {
        m.score -= 35;
        m.verdict = verdictFor(m.score);
      }
      m.reasons = ['estimated from the months around it'];
    } else if (before && !after && before.verdict === 'bad') {
      m.score = before.score;
      m.verdict = 'bad';
      m.reasons = ['after the site went down'];
    } else {
      m.score = ratio !== undefined && ratio < 0.25 ? 30 : 55;
      m.verdict = verdictFor(m.score);
      m.reasons = ['not checked; near a change'];
    }
  }
}
