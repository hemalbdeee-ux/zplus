// URL helpers.
//
// The rule for the whole engine: a URL of the original site is never changed. Path, file
// extension, trailing slash, letter case and query string all stay exactly as they were, because
// backlinks point at those exact URLs. Keys only drop what does not identify a resource on the
// new host: scheme, "www.", port, fragment and analytics tracking parameters.

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid)$/i;

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
  const parts = search
    .slice(1)
    .split('&')
    .filter((p) => p !== '' && !TRACKING_PARAM.test(decodeSafe(p.split('=')[0])));
  return parts.length ? '?' + parts.join('&') : '';
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

/** Replace every Wayback-wrapped URL inside a block of text (CSS, JS, XML) by the original URL. */
export function unwrapWaybackInText(text: string): string {
  return text.replace(/(?:https?:)?\/\/(?:web\.)?archive\.org\/web\/\d{1,14}(?:[a-z]{2}_)?\/((?:https?:)?\/{1,2})?/gi, (_m, scheme?: string) => {
    if (!scheme) return 'http://';
    return scheme.startsWith('//') ? scheme : scheme.replace(/^(https?):\/(?!\/)/i, '$1://');
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns absolute links to the original site into root-relative ones, so the restored site works
 * on any host. Only the scheme and host are removed; path, query and fragment stay byte for byte.
 */
export function makeRootRelative(domain: string): (href: string) => string {
  const re = new RegExp(`^(?:https?:)?//(?:www\\d{0,3}\\.)?${escapeRegExp(domain)}\\.?(?::\\d+)?(?=[/?#]|$)`, 'i');
  return (href: string) => {
    const trimmed = href.trim();
    if (!re.test(trimmed)) return href;
    const rest = trimmed.replace(re, '');
    return rest === '' || rest.startsWith('?') || rest.startsWith('#') ? '/' + rest : rest;
  };
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

/** Accepts 2019, 2019-06, 2019-06-12, 20190612, 20190612083015. Pads with zeros (or nines for an upper bound). */
export function parseTimestamp(input: string, upper = false): string {
  const digits = input.replace(/[^0-9]/g, '');
  if (digits.length < 4 || digits.length > 14) throw new Error(`Not a date or Wayback timestamp: ${input}`);
  if (upper) return digits + '99991231235959'.slice(digits.length);
  let t = digits.padEnd(14, '0');
  if (t.slice(4, 6) === '00') t = t.slice(0, 4) + '01' + t.slice(6);
  if (t.slice(6, 8) === '00') t = t.slice(0, 6) + '01' + t.slice(8);
  return t;
}

export function tsToDate(ts: string): Date {
  const t = ts.padEnd(14, '0');
  const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date(`${t.slice(0, 4)}-01-01T00:00:00Z`) : d;
}

export function tsToIso(ts: string): string {
  return tsToDate(ts).toISOString().replace(/\.000Z$/, 'Z');
}

export function tsSeconds(ts: string): number {
  return Math.floor(tsToDate(ts).getTime() / 1000);
}
