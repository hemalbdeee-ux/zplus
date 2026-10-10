// URL helpers.
//
// The rule for the whole engine: a URL of the original site is never changed. Path, file
// extension, trailing slash, letter case and query string all stay exactly as they were, because
// backlinks point at those exact URLs. Keys only drop what does not identify a resource on the
// new host: scheme, "www.", port, fragment and analytics tracking parameters.

const TRACKING = ['fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'yclid'];
const TRACKING_PARAM = new RegExp(`^(utm_[a-z0-9_]+|${TRACKING.join('|')})$`, 'i');

export function bareHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').replace(/^www\d{0,3}\./, '');
}

export function normalizeDomain(input: string): string {
  const s = input.trim();
  const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? new URL(s).hostname : s.split(/[/?#]/)[0];
  const domain = bareHost(host);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new Error(`Not a domain name: ${input}`);
  return domain;
}

export function isInternal(u: URL, domain: string): boolean {
  return (u.protocol === 'http:' || u.protocol === 'https:') && bareHost(u.hostname) === domain;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Query string without tracking parameters, order and encoding kept. Returns '' or '?a=b'. */
export function cleanSearch(search: string): string {
  if (!search || search === '?') return '';
  // Names are compared as written (no tool escapes "utm_source"), so that queryPattern() can say
  // in a server rule exactly what this function does.
  const parts = search
    .slice(1)
    .split('&')
    .filter((p) => p !== '' && !TRACKING_PARAM.test(p.split('=')[0]));
  return parts.length ? '?' + parts.join('&') : '';
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regular expression (the same in PCRE and JavaScript) for exactly the raw query strings that
 * cleanSearch() turns into `query` ('' for none): empty segments and tracking parameters may sit
 * anywhere. Server rules need it because the archived URL (and a visitor's click with ?fbclid=)
 * carries the raw query, while routes and redirects are keyed by the cleaned one.
 */
export function queryPattern(query: string): string {
  // No (?i) group: Node 22 lacks it, and parameter values must keep their case.
  const anyCase = (s: string) => s.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
  const junk = `(?:(?:${anyCase('utm_')}[A-Za-z0-9_]+|${TRACKING.map(anyCase).join('|')})(?:=[^&]*)?)?`;
  if (!query) return `^(?:${junk}&)*${junk}$`;
  return `^(?:${junk}&)*${query.split('&').map(regexEscape).join(`&(?:${junk}&)*`)}(?:&${junk})*$`;
}

/** The original URL as the site served it: path plus query, exactly. */
export function pathAndQuery(u: URL): string {
  return u.pathname + cleanSearch(u.search);
}

/** Identity of a resource across http/https and www/bare host. */
export function urlKey(u: URL): string {
  return bareHost(u.hostname) + pathAndQuery(u);
}

export function toUrl(href: string, base?: string | URL): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

// Archived pages sometimes link through the Wayback Machine itself, e.g.
// https://web.archive.org/web/20190101000000/http://example.com/about.php
// or, relative to the archive host, /web/20190101000000im_/http://example.com/a.png
const WAYBACK_ABS = /^(?:https?:)?\/\/(?:web\.|www\.|wayback\.)?archive\.org\/web\/(\d{1,14}|\*)(?:[a-z]{2}_|\*)?\/(.+)$/i;
const WAYBACK_REL = /^\/web\/(\d{1,14})(?:[a-z]{2}_)?\/((?:https?:)?\/{1,2}.+)$/i;

export function unwrapWayback(href: string): string {
  const m = WAYBACK_ABS.exec(href) ?? WAYBACK_REL.exec(href);
  if (!m) return href;
  let inner = m[2];
  inner = inner.replace(/^(https?):\/(?!\/)/i, '$1://');
  if (inner.startsWith('//')) inner = 'http:' + inner;
  if (!/^https?:\/\//i.test(inner)) inner = 'http://' + inner;
  return inner;
}

export function containsWayback(text: string): boolean {
  return /(?:web\.)?archive\.org\/web\/\d/i.test(text);
}

/**
 * Replace every Wayback-wrapped URL inside a block of text (CSS, JS, XML) by the original URL. With
 * a domain, only links to that site are unwrapped: captures are fetched raw, so a Wayback link to
 * another site was put there by the author, usually because the original was already gone.
 */
export function unwrapWaybackInText(text: string, domain?: string): string {
  return text.replace(
    /(?:https?:)?\/\/(?:web\.)?archive\.org\/web\/\d{1,14}(?:[a-z]{2}_)?\/((?:https?:)?\/{1,2})?(?=([^\/?#\s"'()<>\\]*))/gi,
    (m, scheme: string | undefined, host: string) => {
      if (domain && bareHost(host.replace(/^[^@]*@/, '').replace(/:\d*$/, '')) !== domain) return m;
      if (!scheme) return 'http://';
      return scheme.startsWith('//') ? scheme : scheme.replace(/^(https?):\/(?!\/)/i, '$1://');
    },
  );
}

/**
 * Turns absolute links to the original site into root-relative ones, so the restored site works
 * on any host. Only the scheme and host are removed; path, query and fragment stay byte for byte.
 */
export function makeRootRelative(domain: string): (href: string) => string {
  const re = new RegExp(`^(?:https?:)?//(?:www\\d{0,3}\\.)?${regexEscape(domain)}\\.?(?::\\d+)?(?=[/?#]|$)`, 'i');
  return (href: string) => {
    const trimmed = href.trim();
    if (!re.test(trimmed)) return href;
    const rest = trimmed.replace(re, '');
    if (rest === '' || rest.startsWith('?') || rest.startsWith('#')) return '/' + rest;
    // http://example.com//a.jpg: servers merge the slashes, but "//a.jpg" alone names a host "a.jpg".
    return rest.replace(/^\/{2,}/, '/');
  };
}

/**
 * True when a segment holds percent escapes that are not UTF-8 (Latin-1 "/caf%E9.html"). Apache
 * and nginx look such a URL up by its raw bytes, which no portable file name can hold.
 */
export function hasNonUtf8Escapes(pathname: string): boolean {
  return pathname.split('/').some((seg) => /%[0-9a-f]{2}/i.test(seg) && decodeSafe(seg) === seg);
}

/** The path as Apache and nginx see it once decoded: raw bytes, whatever the charset. */
export function decodePathBytes(pathname: string): Buffer {
  return Buffer.from(pathname.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
}

/**
 * Regular expression (PCRE, unanchored) for a path as Apache and nginx match it: slashes merged,
 * escapes decoded, bytes outside printable ASCII written as \xHH. A Latin-1 path ("/caf%E9.html")
 * is the byte 0xE9 to the server, which a UTF-8 config file cannot hold as text.
 */
export function pathBytesPattern(pathname: string): string {
  return regexEscape(decodePathBytes(pathname.replace(/\/{2,}/g, '/')).toString('latin1')).replace(
    /[\x00-\x1f\x7f-\xff]/g,
    (c) => '\\x' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
}

/** Percent-decoded path for the file system ("/a%20b/" -> "/a b/"). */
export function decodePath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      const d = decodeSafe(seg);
      return d.includes('/') || d.includes('\0') ? seg : d;
    })
    .join('/');
}

// ---- Wayback timestamps (YYYYMMDDhhmmss) ----

/**
 * Accepts 2019, 2019-06, 2019-6-5, 2019/06/12, 2019-06-12 08:30, 20190612, 20190612083015. Pads
 * with zeros (or nines for an upper bound). A date the calendar does not have is an error.
 */
export function parseTimestamp(input: string, upper = false): string {
  const s = input.trim();
  // Separated fields may have one digit (2019-6-5); run together they would shift every later field.
  const m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2})(?:[T ](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?)?)?Z?$/i.exec(s);
  const digits = /^\d+$/.test(s) ? s : m ? m.slice(1).filter((f) => f !== undefined).map((f) => f.padStart(2, '0')).join('') : '';
  if (digits.length < 4 || digits.length > 14) throw new Error(`Not a date or Wayback timestamp: ${input}`);
  let t = digits.padEnd(14, '0');
  if (t.slice(4, 6) === '00') t = t.slice(0, 4) + '01' + t.slice(6);
  if (t.slice(6, 8) === '00') t = t.slice(0, 6) + '01' + t.slice(8);
  const [year, month, day, hour, min, sec] = [0, 4, 6, 8, 10, 12].map((i) => Number(t.slice(i, i ? i + 2 : 4)));
  if (month > 12 || day > daysInMonth(year, month) || hour > 23 || min > 59 || sec > 59) throw new Error(`Not a date or Wayback timestamp: ${input}`);
  return upper ? digits + '99991231235959'.slice(digits.length) : t;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function tsToDate(ts: string): Date {
  const t = ts.padEnd(14, '0');
  const n = (from: number, to: number) => Number(t.slice(from, to)) || 0;
  // Out-of-range fields are clamped (month 13 -> December), never replaced by 1 January.
  const year = n(0, 4);
  const month = Math.min(Math.max(n(4, 6), 1), 12);
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, Math.min(Math.max(n(6, 8), 1), daysInMonth(year, month)));
  d.setUTCHours(Math.min(n(8, 10), 23), Math.min(n(10, 12), 59), Math.min(n(12, 14), 59));
  return d;
}

export function tsToIso(ts: string): string {
  return tsToDate(ts).toISOString().replace(/\.000Z$/, 'Z');
}

export function tsSeconds(ts: string): number {
  return Math.floor(tsToDate(ts).getTime() / 1000);
}
