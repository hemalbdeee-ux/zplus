// Turns the downloaded captures into a deploy-ready site.
//
// Every original URL keeps working at exactly the same address:
//   /about/                  -> about/index.html
//   /about.php               -> about.php (HTML inside; on a PHP host it is printed as is)
//   /blog/post               -> blog/post.html (served without a redirect by the server rules)
//   /index.php?page=contact  -> __wbd/q/<hash>.html (internal rewrite, URL unchanged)
// Then the Ghost-style SEO layer is added to each page and sitemaps, RSS, robots.txt, a 404 page
// and the server rules are written next to it.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeText, isValidUtf8 } from './charset.ts';
import { cleanDocument, stripWaybackMarkup } from './clean.ts';
import { isHtmlType, type Manifest, type Resource } from './crawl.ts';
import { loadHtml, rewriteCss, visitUrls } from './html.ts';
import { extractMeta, guessSiteName, type PageMeta } from './meta.ts';
import { applySeo, type SiteContext } from './seo.ts';
import {
  HTML_LIKE_EXT,
  htaccess,
  netlifyHeaders,
  netlifyRedirects,
  nginxConf,
  type Redirect,
  type Route,
  type ServerRules,
  type TypeOverride,
} from './serverconfig.ts';
import { robotsTxt, rssFeed, sitemaps, sitemapXsl, type SitemapEntry } from './sitemap.ts';
import {
  cleanSearch,
  decodePath,
  hasNonUtf8Escapes,
  isInternal,
  makeRootRelative,
  pathAndQuery,
  toUrl,
  tsToIso,
  unwrapWayback,
  unwrapWaybackInText,
} from './url.ts';

export interface BuildOptions {
  domain: string;
  /** e.g. https://www.example.com (no trailing slash). */
  siteUrl: string;
  workDir: string;
  /** Folder that becomes the web root. */
  outDir: string;
  /** Folder for configs that must not be public (nginx). */
  serverDir: string;
  stripTracking: boolean;
  log?: (msg: string) => void;
}

export interface PageRecord extends PageMeta {
  file: string;
  timestamp: string;
  lastmod: string;
}

export interface BuildResult {
  siteName: string;
  pages: PageRecord[];
  routes: Route[];
  redirects: Redirect[];
  types: TypeOverride[];
  files: number;
  bytes: number;
  rssPath?: string;
  warnings: string[];
  cleaned: { wayback: number; trackers: number };
}

type Kind = 'html' | 'css' | 'js' | 'xml' | 'other';

interface Plan {
  res: Resource;
  kind: Kind;
  file: string;
  /** Another resource with identical bytes already writes this file. */
  shared?: boolean;
  /** Same bytes as this plan under a name differing only in letter case: gets a copy of its output. */
  sameAs?: Plan;
  route?: Route;
}

const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);
const SERVER_EXT = new Set(HTML_LIKE_EXT.map((e) => '.' + e));
// Extensions every server sends as text/html. Servers send .xhtml as application/xhtml+xml, but
// the rewritten page is HTML, not XML: it is stored as page.xhtml.html, which the extensionless-URL
// rule serves as text/html.
const TEXT_HTML_EXT = new Set(['.html', '.htm', ...SERVER_EXT]);

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.xml': 'xml',
  '.rss': 'xml',
  '.atom': 'xml',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
  '.otf': 'font',
  '.eot': 'font',
};

const MIME_EXT: Array<[RegExp, string]> = [
  [/jpeg|jpg/, '.jpg'],
  [/png/, '.png'],
  [/gif/, '.gif'],
  [/webp/, '.webp'],
  [/avif/, '.avif'],
  [/svg/, '.svg'],
  [/icon/, '.ico'],
  [/bmp/, '.bmp'],
  [/css/, '.css'],
  [/javascript|ecmascript/, '.js'],
  [/json/, '.json'],
  [/xml|rss|atom/, '.xml'],
  [/pdf/, '.pdf'],
  [/woff2/, '.woff2'],
  [/woff/, '.woff'],
  [/ttf|truetype/, '.ttf'],
  [/otf|opentype/, '.otf'],
  [/fontobject/, '.eot'],
  [/mp4/, '.mp4'],
  [/mpeg/, '.mp3'],
  [/shockwave|flash/, '.swf'],
  [/zip/, '.zip'],
  [/html/, '.html'],
  [/text\/plain/, '.txt'],
];

function mimeExt(contentType: string): string {
  const ct = contentType.toLowerCase();
  return MIME_EXT.find(([re]) => re.test(ct))?.[1] ?? '.bin';
}

function kindOf(r: Resource, body: Buffer): Kind {
  const ct = (r.contentType ?? '').toLowerCase();
  if (isHtmlType(ct)) return 'html';
  if (ct.includes('css')) return 'css';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'js';
  if (/xml|rss|atom/.test(ct)) return 'xml';
  if (!ct || ct.includes('text/plain') || ct.includes('octet-stream')) {
    const ext = path.posix.extname(new URL(r.url).pathname).toLowerCase();
    if (ext === '.css') return 'css';
    if (ext === '.js') return 'js';
    const head = body.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
    if (HTML_EXT.has(ext) || head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  }
  return 'other';
}

/** Does a file with this extension get the right Content-Type from an ordinary web server? */
function extFits(ext: string, kind: Kind, contentType: string): boolean {
  if (!ext) return false;
  if (HTML_EXT.has(ext) || SERVER_EXT.has(ext)) return kind === 'html';
  const expected = EXT_MIME[ext];
  if (!expected) return true;
  const ct = contentType.toLowerCase();
  if (!ct || ct.includes('octet-stream') || ct.includes('text/plain')) return true;
  if (expected === 'xml') return ct.includes('xml') || ct.includes('rss') || ct.includes('atom');
  if (expected === 'font') return ct.includes('font') || ct.includes('woff') || ct.includes('opentype') || ct.includes('truetype');
  if (expected === 'text/javascript') return kind === 'js';
  if (expected === 'text/css') return kind === 'css';
  return ct.split('/')[0] === expected.split('/')[0];
}

const UNSAFE_SEGMENT = /[<>:"|?*\\\0]/;

/** Relative file path for a decoded URL path, or null when it cannot live on disk as is. */
function plainFile(decoded: string, kind: Kind, ext: string, contentType: string): string | null {
  const segs = decoded.split('/').slice(1);
  if (segs.some((s, i) => (s === '' && i < segs.length - 1) || s === '.' || s === '..' || UNSAFE_SEGMENT.test(s) || Buffer.byteLength(s) > 200)) return null;
  const rel = segs.join('/');
  if (decoded.endsWith('/')) {
    if (kind === 'html') return rel + 'index.html';
    if (kind === 'xml') return rel + 'index.xml';
    return null;
  }
  if (kind === 'html') return TEXT_HTML_EXT.has(ext) ? rel : rel + '.html';
  return extFits(ext, kind, contentType) ? rel : null;
}

/** Apache and nginx merge repeated slashes before they look at a path: //a/b.png is /a/b.png. */
function sitePath(u: URL): string {
  return u.pathname.replace(/\/{2,}/g, '/');
}

function charsetLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label.trim().toLowerCase()).encoding;
  } catch {
    return undefined;
  }
}

/**
 * The charset a browser read this script or stylesheet with on the original site, when that was a
 * legacy one and the bytes must be converted to UTF-8 like the pages. Without a BOM, a charset in
 * the Content-Type or a CSS @charset, browsers use the encoding of the page that loads the file.
 */
function legacyCharset(body: Buffer, contentType: string, kind: Kind, pageCharset: string | undefined): string | undefined {
  if (!body.some((b) => b > 0x7f)) return undefined;
  if ((body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) || (body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) return undefined;
  const declared =
    charsetLabel(/charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1]) ??
    (kind === 'css' ? charsetLabel(/^@charset "([^"]+)";/.exec(body.subarray(0, 64).toString('latin1'))?.[1]) : undefined);
  // Valid UTF-8 that a page only implies is another charset is far more likely really UTF-8.
  const implied = pageCharset?.startsWith('utf-16') || isValidUtf8(body) ? undefined : pageCharset;
  const cs = declared ?? implied;
  return cs && cs !== 'utf-8' ? cs : undefined;
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

export function phpSafe(html: string): { html: string; leftovers: number } {
  let leftovers = 0;
  const out = html
    .replace(/<\?xml[^>]*\?>\s*/gi, '')
    .replace(/(<script\b[^>]*>[\s\S]*?<\/script>)|<\?/gi, (m, script?: string) => {
      if (script) {
        if (script.includes('<?')) leftovers++;
        return m;
      }
      return '&lt;?';
    });
  return { html: out, leftovers };
}

export function planFiles(resources: Resource[], kinds: Map<string, Kind>): Plan[] {
  const content = resources.filter((r) => r.status === 200 && r.file);
  const ordered = [...content].sort((a, b) => {
    const qa = cleanSearch(new URL(a.url).search) ? 1 : 0;
    const qb = cleanSearch(new URL(b.url).search) ? 1 : 0;
    return qa - qb || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });

  // A query string that does not change the bytes (style.css?ver=1.2) is served from the plain
  // path: a static server ignores the query string anyway. That holds only when every capture at the
  // path, the bare path and HTML pages included, has those bytes (not / plus /?feed=rss2).
  const variants = new Map<string, Set<string>>();
  for (const r of content) {
    const u = new URL(r.url);
    const set = variants.get(sitePath(u)) ?? new Set<string>();
    set.add(r.sha1 ?? r.key);
    variants.set(sitePath(u), set);
  }

  const taken = new Map<string, Plan>();
  const plainPaths = new Set<string>();
  const plans: Plan[] = [];
  const toRoute = (p: Plan, query?: string) => {
    const u = new URL(p.res.url);
    const decoded = decodePath(sitePath(u));
    const own = path.posix.extname(decoded).toLowerCase();
    const ext = p.kind === 'html' ? '.html' : own && !UNSAFE_SEGMENT.test(own) && extFits(own, p.kind, p.res.contentType ?? '') ? own : mimeExt(p.res.contentType ?? '');
    p.file = `__wbd/${query !== undefined ? 'q' : 'f'}/${shortHash(p.res.key)}${ext}`;
    p.shared = false;
    p.route = { path: decoded, rawPath: u.pathname, query, file: p.file };
  };

  for (const r of ordered) {
    const u = new URL(r.url);
    const pathname = sitePath(u);
    const kind = kinds.get(r.key) ?? 'other';
    const query = cleanSearch(u.search).slice(1) || undefined;
    // The server reads //a/b.png as /a/b.png, so one capture serves both: /a/b.png when it was
    // archived too (shorter paths come first).
    if (query === undefined && plainPaths.has(pathname)) continue;
    if (query === undefined) plainPaths.add(pathname);
    const plan: Plan = { res: r, kind, file: '' };
    plans.push(plan);

    const ignorableQuery = query !== undefined && kind !== 'html' && (variants.get(pathname)?.size ?? 0) <= 1;
    if (query !== undefined && !ignorableQuery) {
      toRoute(plan, query);
      continue;
    }
    const decoded = decodePath(pathname);
    const file = !hasNonUtf8Escapes(pathname) && plainFile(decoded, kind, path.posix.extname(decoded).toLowerCase(), r.contentType ?? '');
    // A query URL never gets a path-only route: that would also answer the bare path.
    if (!file) {
      toRoute(plan, query);
      continue;
    }
    const lower = file.toLowerCase();
    const owner = taken.get(lower);
    if (owner === undefined) {
      taken.set(lower, plan);
      plan.file = file;
    } else if (r.sha1 !== undefined && owner.res.sha1 === r.sha1 && owner.file === file) {
      plan.file = file;
      plan.shared = true;
    } else {
      // Another file already has this name (in some letter case), so this URL gets its own copy.
      toRoute(plan, query);
      // /images/a.gif next to /Images/a.gif with the same bytes: Linux servers tell the two apart,
      // and one file name cannot hold both on a case-insensitive disk.
      if (r.sha1 !== undefined && owner.res.sha1 === r.sha1) plan.sameAs = owner;
    }
  }

  // A file and a folder cannot share a name (/index.php and /index.php/about): move the file aside.
  const dirs = new Set<string>();
  for (const p of plans) {
    if (p.route) continue;
    const parts = p.file.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const p of plans) if (!p.route && dirs.has(p.file.toLowerCase())) toRoute(p, cleanSearch(new URL(p.res.url).search).slice(1) || undefined);
  return plans;
}

function pickLogo(homeHtml: string, homeUrl: URL, domain: string): string | undefined {
  const $ = loadHtml(homeHtml);
  const src =
    $('[class*="logo" i] img[src], #logo img[src], img[class*="logo" i][src], img[id*="logo" i][src], img[alt*="logo" i][src]').first().attr('src') ??
    undefined;
  if (!src) return undefined;
  const u = toUrl(unwrapWayback(src), homeUrl);
  return u && isInternal(u, domain) ? pathAndQuery(u) : undefined;
}

export async function buildSite(manifest: Manifest, opts: BuildOptions): Promise<BuildResult> {
  const log = opts.log ?? (() => {});
  const rawDir = path.join(opts.workDir, 'raw');
  const rootRel = makeRootRelative(opts.domain);
  // Links to the site become root-relative, also when they go through a Wayback copy of it. Captures
  // are fetched raw, so a Wayback link to another site was put there by the author and stays.
  const relink = (v: string): string | undefined => {
    const t = v.trim();
    const inner = unwrapWayback(t);
    if (inner !== t) {
      const u = toUrl(inner);
      if (!u || !isInternal(u, opts.domain)) return t.startsWith('/web/') ? 'https://web.archive.org' + t : undefined;
    }
    const out = rootRel(inner);
    return out !== t ? out : undefined;
  };
  const warnings: string[] = [];
  const readRaw = (r: Resource) => readFile(path.join(rawDir, r.file!));

  await rm(opts.outDir, { recursive: true, force: true });
  await mkdir(opts.outDir, { recursive: true });
  await mkdir(opts.serverDir, { recursive: true });

  let files = 0;
  let bytes = 0;
  const root = path.resolve(opts.outDir);
  const write = async (rel: string, data: string | Buffer) => {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) throw new Error(`refusing to write outside the site: ${rel}`);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
    files++;
    bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  };

  // 1. What kind of file is each capture, and where does it go.
  const kinds = new Map<string, Kind>();
  const content = manifest.resources.filter((r) => r.status === 200 && r.file);
  for (const r of content) {
    const ct = (r.contentType ?? '').toLowerCase();
    const needsSniff = !ct || ct.includes('text/plain') || ct.includes('octet-stream');
    kinds.set(r.key, kindOf(r, needsSniff ? await readRaw(r) : Buffer.alloc(0)));
  }
  const plans = planFiles(manifest.resources, kinds);
  const routes = plans.filter((p) => p.route).map((p) => p.route!);
  const takenFiles = new Set(plans.map((p) => p.file.toLowerCase()));
  const takenPaths = new Set(content.map((r) => new URL(r.url).pathname));
  const available = new Set(content.flatMap((r) => [r.path, new URL(r.url).pathname]));
  const hasPath = (p: string) => available.has(p);

  // 2. Site-wide facts: name, description, logo, feed address.
  const htmlPlans = plans.filter((p) => p.kind === 'html');
  const home = htmlPlans.find((p) => p.res.path === '/');
  const titles: string[] = [];
  for (const p of htmlPlans.slice(0, 400)) {
    const { text } = decodeText(await readRaw(p.res), p.res.contentType ?? '');
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.replace(/\s+/g, ' ').trim();
    if (t) titles.push(loadHtml(`<p>${t}</p>`)('p').text());
  }
  let homeTitle = '';
  let siteNameHint: string | undefined;
  let siteDescription: string | undefined;
  let logo: string | undefined;
  if (home) {
    const { text } = decodeText(await readRaw(home.res), home.res.contentType ?? '');
    const $ = loadHtml(text);
    const meta = extractMeta($, new URL(home.res.url), opts.domain, { hasPath });
    homeTitle = meta.title;
    siteNameHint = meta.siteNameHint;
    siteDescription = meta.description;
    logo = pickLogo(text, new URL(home.res.url), opts.domain);
  }
  const siteName = guessSiteName(titles, homeTitle, siteNameHint, opts.domain);
  const rssPath = !takenPaths.has('/rss/') && !takenPaths.has('/rss') && !takenFiles.has('rss/index.xml') ? '/rss/' : !takenPaths.has('/rss.xml') ? '/rss.xml' : undefined;
  const site: SiteContext = { siteUrl: opts.siteUrl, siteName, siteDescription, logo, rssPath };
  log(`site name: ${siteName}`);

  // 3. Write every file. Pages go first: they tell which charset their scripts and stylesheets were
  // read with, and those are converted to UTF-8 like the pages.
  const pages: PageRecord[] = [];
  const types: TypeOverride[] = [];
  const cleaned = { wayback: 0, trackers: 0 };
  let phpLeftovers = 0;
  const planByPath = new Map(plans.map((p) => [p.res.path, p]));
  const siteCharsets = new Map<string, number>();
  const fileCharsets = new Map<string, Map<string, number>>();
  const count = (counts: Map<string, number>, charset: string) => counts.set(charset, (counts.get(charset) ?? 0) + 1);
  // The charset of most pages that load this file; for a file no page loads directly (an @import,
  // a script added by a script), the charset of most pages of the site.
  const pageCharset = (p: Plan) => [...(fileCharsets.get(p.file) ?? siteCharsets)].sort((a, b) => b[1] - a[1])[0]?.[0];

  for (const p of [...plans.filter((x) => x.kind === 'html'), ...plans.filter((x) => x.kind !== 'html')]) {
    if (p.shared || p.sameAs) continue;
    const body = await readRaw(p.res);
    if (p.kind === 'html') {
      const pageUrl = new URL(p.res.url);
      const { text, charset } = decodeText(body, p.res.contentType ?? '');
      // The parser rewrites any doctype to <!DOCTYPE html>; old pages keep their own so browsers
      // render them in the same (often quirks) mode as before.
      const doctype = /<!doctype[^>]*>/i.exec(text.slice(0, 4096))?.[0];
      const $ = loadHtml(stripWaybackMarkup(text.replace(/^\uFEFF?\s*<\?xml[^>]*\?>\s*/i, '')));
      const stats = cleanDocument($, { stripTracking: opts.stripTracking });
      cleaned.wayback += stats.waybackRemoved;
      cleaned.trackers += stats.trackersRemoved;
      visitUrls($, relink);
      count(siteCharsets, charset);
      $('script[src], link[href]').each((_, el) => {
        const $el = $(el);
        if (el.tagName === 'link' && !/(^|\s)stylesheet(\s|$)/i.test($el.attr('rel') ?? '')) return;
        const u = toUrl($el.attr(el.tagName === 'link' ? 'href' : 'src') ?? '', pageUrl);
        const target = u && isInternal(u, opts.domain) ? planByPath.get(pathAndQuery(u)) : undefined;
        if (!target || (target.kind !== 'js' && target.kind !== 'css')) return;
        const own = charsetLabel($el.attr('charset'));
        const file = (target.sameAs ?? target).file;
        if (!fileCharsets.has(file)) fileCharsets.set(file, new Map());
        count(fileCharsets.get(file)!, own ?? charset);
        // The file is written as UTF-8 below.
        if (own && own !== 'utf-8') $el.attr('charset', 'utf-8');
      });
      const meta = extractMeta($, pageUrl, opts.domain, { hasPath });
      applySeo($, meta, site);
      let html = $.html();
      if (doctype) html = html.replace(/<!doctype[^>]*>/i, () => doctype);
      const ext = path.posix.extname(p.file).toLowerCase();
      if (SERVER_EXT.has(ext)) {
        const safe = phpSafe(html);
        html = safe.html;
        phpLeftovers += safe.leftovers;
        types.push({ file: p.file, contentType: 'text/html; charset=utf-8' });
      }
      await write(p.file, html);
      const lastmod = meta.modifiedAt ?? meta.publishedAt ?? tsToIso(p.res.timestamp);
      pages.push({ ...meta, file: p.file, timestamp: p.res.timestamp, lastmod });
    } else if (p.kind === 'css') {
      const cs = legacyCharset(body, p.res.contentType ?? '', 'css', pageCharset(p));
      // latin1 keeps the bytes exactly as they were when the charset stays.
      const text = cs ? new TextDecoder(cs).decode(body).replace(/^@charset "[^"]*";/, '@charset "utf-8";') : body.toString('latin1');
      await write(p.file, Buffer.from(rewriteCss(text, relink), cs ? 'utf8' : 'latin1'));
    } else if (p.kind === 'js' || p.kind === 'xml') {
      const cs = p.kind === 'js' ? legacyCharset(body, p.res.contentType ?? '', 'js', pageCharset(p)) : undefined;
      const text = cs ? new TextDecoder(cs).decode(body) : body.toString('latin1');
      const out = text.includes('archive.org/web/') ? unwrapWaybackInText(text, opts.domain) : text;
      await write(p.file, cs ? Buffer.from(out, 'utf8') : out !== text ? Buffer.from(out, 'latin1') : body);
    } else {
      await write(p.file, body);
    }
  }
  for (const p of plans) if (p.sameAs) await write(p.file, await readFile(path.join(root, p.sameAs.file)));
  if (phpLeftovers) warnings.push(`${phpLeftovers} script(s) in .php pages contain "<?"; check them if your host runs PHP with short tags on.`);

  // 4. Redirects the original site made.
  const queryPaths = new Set<string>();
  for (const r of manifest.resources) {
    const u = new URL(r.url);
    if (cleanSearch(u.search)) queryPaths.add(sitePath(u));
  }
  const redirects: Redirect[] = [];
  const redirected = new Set<string>();
  const singleSlash = new Set(manifest.resources.map((r) => pathAndQuery(new URL(r.url))));
  for (const r of manifest.resources) {
    if (r.status === 200 || !r.location) continue;
    const u = new URL(r.url);
    const loc = toUrl(r.location);
    if (!loc) continue;
    const to = isInternal(loc, opts.domain) ? pathAndQuery(loc) : loc.toString();
    if (to === r.path) continue;
    const query = cleanSearch(u.search).slice(1) || undefined;
    // //a.php and /a.php are one URL to the server: a redirect at //a.php would also catch /a.php.
    const key = sitePath(u) + (query !== undefined ? '?' + query : '');
    if (redirected.has(key) || (sitePath(u) !== u.pathname && singleSlash.has(key))) continue;
    redirected.add(key);
    redirects.push({
      path: decodePath(sitePath(u)),
      rawPath: u.pathname,
      query,
      noQuery: query === undefined && queryPaths.has(sitePath(u)),
      to,
      status: r.status,
    });
  }

  // nginx matches query routes and query redirects on the raw request, where //?p=1 is not /?p=1;
  // Apache merges the slashes, and links to //?p=1 are written as /?p=1. So the merged address
  // gets the same rule, unless it was archived itself. nginx map keys ignore letter case: a rule
  // must not repeat another key in any case.
  const keys = new Set(manifest.resources.map((r) => pathAndQuery(new URL(r.url)).toLowerCase()));
  const withMerged = <T extends Route | Redirect>(x: T, byRawPath: boolean): T[] => {
    const rawPath = x.rawPath.replace(/\/{2,}/g, '/');
    const key = (rawPath + (x.query !== undefined ? '?' + x.query : '')).toLowerCase();
    if (!byRawPath || rawPath === x.rawPath || keys.has(key)) return [x];
    keys.add(key);
    return [x, { ...x, rawPath }];
  };
  const serverRoutes = routes.flatMap((x) => withMerged(x, x.query !== undefined));
  const serverRedirects = redirects.flatMap((d) => withMerged(d, d.query !== undefined || d.noQuery === true));

  // 5. Sitemaps, feed, robots.txt, 404 page.
  const indexable = pages.filter((pg) => !pg.noindex && pg.type !== 'archive' && (!pg.canonicalPath || pg.canonicalPath === pg.path));
  const entry = (pg: PageRecord): SitemapEntry => ({ path: pg.path, lastmod: pg.lastmod, image: pg.image });
  const maps = sitemaps(opts.siteUrl, {
    pages: indexable.filter((pg) => pg.type === 'home' || pg.type === 'page').map(entry),
    posts: indexable.filter((pg) => pg.type === 'post').map(entry),
    tags: indexable.filter((pg) => pg.type === 'tag').map(entry),
    authors: indexable.filter((pg) => pg.type === 'author').map(entry),
  });
  for (const [name, xml] of maps) {
    if (takenFiles.has(name.toLowerCase())) warnings.push(`${name} from the archive was replaced by a fresh sitemap`);
    await write(name, xml);
  }
  await write('sitemap.xsl', sitemapXsl(siteName));
  await write('robots.txt', robotsTxt(opts.siteUrl));

  const posts = pages.filter((pg) => pg.type === 'post' && pg.publishedAt && !pg.noindex);
  if (site.rssPath) {
    const feed = rssFeed(
      { siteUrl: opts.siteUrl, siteName, description: siteDescription ?? siteName, rssPath: site.rssPath },
      posts.map((pg) => ({ title: pg.headline, path: pg.path, description: pg.description, publishedAt: pg.publishedAt!, author: pg.author, tags: pg.tags, image: pg.image })),
    );
    await write(site.rssPath === '/rss/' ? 'rss/index.xml' : 'rss.xml', feed);
  }
  if (!takenFiles.has('404.html')) await write('404.html', notFoundPage(siteName, home ? pages.find((pg) => pg.path === '/')?.lang : undefined));

  // 6. Server rules.
  const rules: ServerRules = { domain: opts.domain, host: new URL(opts.siteUrl).host, routes: serverRoutes, redirects: serverRedirects, types };
  await write('.htaccess', htaccess(rules));
  await write('_redirects', netlifyRedirects(rules));
  await write('_headers', netlifyHeaders(rules));
  await write(
    '__wbd/routes.json',
    JSON.stringify({ domain: opts.domain, siteUrl: opts.siteUrl, routes: serverRoutes, redirects: serverRedirects, types }, null, 1),
  );
  await writeFile(path.join(opts.serverDir, 'nginx.conf'), nginxConf(rules));

  log(`wrote ${files} files (${(bytes / 1024 / 1024).toFixed(1)} MB): ${pages.length} pages, ${routes.length} rewrites, ${redirects.length} original redirects`);
  return { siteName, pages, routes, redirects, types, files, bytes, rssPath: site.rssPath, warnings, cleaned };
}

function notFoundPage(siteName: string, lang?: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="${esc(lang ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found · ${esc(siteName)}</title>
<style>
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; color: #1c2321; background: #f6f7f6; }
  main { max-width: 36rem; margin: 18vh auto 0; padding: 0 16px; }
  h1 { font-size: 3rem; margin: 0; }
  a { color: #1d5ea8; }
</style>
</head>
<body>
<main>
  <h1>404</h1>
  <p>This page could not be found.</p>
  <p><a href="/">Go to the ${esc(siteName)} homepage</a></p>
</main>
</body>
</html>
`;
}
