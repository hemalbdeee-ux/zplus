// A snapshot the user names on the snapshots page instead of picking one from the list: a link to a
// capture they found in the Wayback Machine, or a date.

import type { HealthReport } from '../engine/health.ts';
import { windowAround } from '../engine/restore.ts';
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
 * Mirrors restore(): a date in the healthy period uses that period, any other date the period around
 * it between the months the scan found parked or run by another owner.
 */
export function ownSnapshotProblem(h: HealthReport, timestamp: string): string | undefined {
  if (!h.months.length) return `The Wayback Machine has no captures of ${h.domain}.`;
  const inside = (!h.window.from || timestamp >= h.window.from) && (!h.window.to || timestamp <= h.window.to);
  if (h.lastGood && inside) return undefined;
  const around = windowAround(h.months, timestamp);
  if (!around) return `Our check found ${h.domain} parked or run by another owner around ${day(timestamp)}. Choose a date when it was still the old site.`;
  if (around.from && around.to && around.from > around.to) {
    return `We cannot vouch for ${h.domain} around ${day(timestamp)}: the months around it were bad or not checked. Choose another date.`;
  }
  return undefined;
}

/** Links to a capture: the bare page for the preview frame (if_), and the normal Wayback view. */
export function waybackLinks(archiveBase: string, timestamp: string, url: string): { frame: string; page: string } {
  const base = archiveBase.replace(/\/+$/, '');
  return { frame: `${base}/web/${timestamp}if_/${url}`, page: `${base}/web/${timestamp}/${url}` };
}
