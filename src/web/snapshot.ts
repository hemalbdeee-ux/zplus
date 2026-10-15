// A snapshot the user names on the snapshots page instead of picking one from the list: a link to a
// capture they found in the Wayback Machine, or a date.

import type { HealthReport } from '../engine/health.ts';
import { monthAtOrBefore, monthName, windowAround } from '../engine/restore.ts';
import { bareHost, parseTimestamp } from '../engine/url.ts';

export interface OwnSnapshot {
  /** 14-digit Wayback timestamp. */
  timestamp: string;
  /** The page the link pointed at, for the preview; absent for a date. */
  url?: string;
}

/** /web/<timestamp><flag>/<original URL> on web.archive.org (or its old name wayback.archive.org). */
const WAYBACK_LINK = /^(?:https?:\/\/)?(?:(?:web|wayback)\.)?archive\.org\/web\/([0-9*]*)(?:[a-z]{2}_)?\/(.+)$/i;

const day = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

/** A Wayback Machine link or a date, checked against the domain; a message for the user when it is neither. */
export function parseOwnSnapshot(input: string, domain: string, now = new Date()): OwnSnapshot | { error: string } {
  const s = input.trim();
  if (s.length > 2000) return { error: 'That link is too long.' };
  const link = WAYBACK_LINK.exec(s);
  let timestamp: string;
  let url: string | undefined;
  if (link) {
    const [, stamp, original] = link;
    if (!/^\d{4,14}$/.test(stamp)) {
      return { error: 'That link opens the calendar of all captures. Open one capture in it and copy the link from the address bar.' };
    }
    let page: URL;
    try {
      // The archive drops one slash of the original URL now and then (https:/site.com/).
      page = new URL(/^https?:\//i.test(original) ? original.replace(/^(https?:)\/+/i, '$1//') : `http://${original}`);
    } catch {
      return { error: 'That Wayback Machine link has no page address after the date.' };
    }
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return { error: 'That Wayback Machine link has no page address after the date.' };
    const host = bareHost(page.hostname);
    if (host !== domain) return { error: `That link is a capture of ${host}, not of ${domain}.` };
    try {
      timestamp = parseTimestamp(stamp);
    } catch {
      return { error: 'The date in that Wayback Machine link is not valid.' };
    }
    page.hash = '';
    url = page.href;
  } else {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^www\./i.test(s) || /\.[a-z]{2,}(\/|$)/i.test(s)) {
      return { error: `Paste the link of one capture from web.archive.org, like https://web.archive.org/web/20150612000000/http://${domain}/` };
    }
    try {
      timestamp = parseTimestamp(s);
    } catch {
      return { error: 'Type a date like 2015-06-12, or paste the link of a capture from web.archive.org.' };
    }
  }
  if (timestamp < '19960101000000') return { error: 'The Wayback Machine has no captures before 1996.' };
  const today = now.toISOString().replace(/\D/g, '').slice(0, 14);
  if (timestamp > today) return { error: `${day(timestamp)} is in the future.` };
  return url ? { timestamp, url } : { timestamp };
}

/**
 * Why a restore cannot take its pages from around a date the user picked, or undefined when it can.
 * Mirrors restore(): a date in the healthy period uses that period; a date before it the period
 * around it, between the months the scan found bad; a date after it is refused, since after it the
 * scan found the site gone or taken over. The answer depends on the month only. `when` is how the
 * date is written in the message.
 */
export function ownSnapshotProblem(h: HealthReport, timestamp: string, when = day(timestamp)): string | undefined {
  if (!h.months.length) return `The Wayback Machine has no captures of ${h.domain}.`;
  const inside = (!h.window.from || timestamp >= h.window.from) && (!h.window.to || timestamp <= h.window.to);
  if (h.lastGood && inside) return undefined;
  if (h.lastGood && h.window.to && timestamp > h.window.to) {
    return `After ${day(h.window.to)} our check found ${h.domain} down, parked or run by another owner. Choose an earlier date.`;
  }
  const around = windowAround(h.months, timestamp);
  if (!around) return `Our check found ${h.domain} parked or run by another owner around ${when}. Choose a date when it was still the old site.`;
  const last = monthAtOrBefore(h.months, timestamp);
  if (last?.verdict === 'bad') {
    return `Our check found the homepage of ${h.domain} bad in ${monthName(last.month)} (${last.reasons[0] ?? 'not a real website'}), the last month it checked before ${when}. Choose a date when the site was still fine.`;
  }
  const first = `${h.months[0].month}01000000`;
  if (around.to && around.to < first && h.months[0].verdict === 'bad') {
    return `The first homepage capture of ${h.domain} is from ${monthName(h.months[0].month)} and our check found it bad, so there is nothing before it to restore. Choose a later date.`;
  }
  // A period that does not hold the date (windowAround leaves out unchecked months just before a bad
  // one) or holds no homepage capture is not the site as it was then.
  if ((around.from && around.to && around.from > around.to) || (around.to && (timestamp > around.to || around.to < first))) {
    return `We cannot vouch for ${h.domain} around ${when}: the months around it were bad or not checked. Choose another date.`;
  }
  return undefined;
}

/** "{date}" in a refusal stands for the date the user picked. */
const DATE_SLOT = '{date}';

export interface Refusals {
  /** The first month of the timeline; refusals before it are `before`. */
  first: string;
  before?: number;
  /** YYYYMM -> index in messages, for the months from the first one to this month that are refused. */
  months: Record<string, number>;
  messages: string[];
}

/**
 * ownSnapshotProblem for every month the page can be asked about, so the page tells the same as the
 * server while a date is typed or a month picked, without repeating its rules.
 */
export function refusalsByMonth(h: HealthReport, now = new Date()): Refusals | undefined {
  if (!h.months.length) return undefined;
  const messages: string[] = [];
  const index = (msg: string | undefined) => {
    if (msg === undefined) return undefined;
    const at = messages.indexOf(msg);
    return at >= 0 ? at : messages.push(msg) - 1;
  };
  const first = h.months[0].month;
  const out: Refusals = { first, months: {}, messages };
  if (first > '199601') out.before = index(ownSnapshotProblem(h, '19960101000000', DATE_SLOT));
  const end = now.toISOString().slice(0, 7).replace('-', '');
  for (let m = first; m <= end; m = nextMonth(m)) {
    const i = index(ownSnapshotProblem(h, `${m}01000000`, DATE_SLOT));
    if (i !== undefined) out.months[m] = i;
  }
  return out;
}

function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4));
  const n = Number(m.slice(4, 6));
  return n === 12 ? `${y + 1}01` : `${y}${String(n + 1).padStart(2, '0')}`;
}

/** Links to a capture: the bare page for the preview frame (if_), and the normal Wayback view. */
export function waybackLinks(archiveBase: string, timestamp: string, url: string): { frame: string; page: string } {
  const base = archiveBase.replace(/\/+$/, '');
  return { frame: `${base}/web/${timestamp}if_/${url}`, page: `${base}/web/${timestamp}/${url}` };
}
