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
import { decodeText } from './charset.ts';
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
import { cleanSearch, decodePath, isInternal, makeRootRelative, pathAndQuery, toUrl, tsToIso, unwrapWayback, unwrapWaybackInText } from './url.ts';

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
  route?: Route;
}

const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);
const SERVER_EXT = new Set(HTML_LIKE_EXT.map((e) => '.' + e));

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
  if (kind === 'html') return HTML_EXT.has(ext) || SERVER_EXT.has(ext) ? rel : rel + '.html';
  return extFits(ext, kind, contentType) ? rel : null;
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

  // Non-HTML files whose query string does not change the bytes (style.css?ver=1.2) are served from
  // the plain path: a static server ignores the query string anyway.
  const variants = new Map<string, Set<string>>();
  for (const r of content) {
    const u = new URL(r.url);
    if (kinds.get(r.key) === 'html') continue;
    const set = variants.get(u.pathname) ?? new Set<string>();
    set.add(r.sha1 ?? r.key);
    variants.set(u.pathname, set);
  }

  const taken = new Map<string, string>();
  const plans: Plan[] = [];
  const toRoute = (p: Plan, query?: string) => {
    const u = new URL(p.res.url);
    const own = path.posix.extname(decodePath(u.pathname)).toLowerCase();
    const ext = p.kind === 'html' ? '.html' : own && !UNSAFE_SEGMENT.test(own) && extFits(own, p.kind, p.res.contentType ?? '') ? own : mimeExt(p.res.contentType ?? '');
    p.file = `__wbd/${query !== undefined ? 'q' : 'f'}/${shortHash(p.res.key)}${ext}`;
    p.shared = false;
    p.route = { path: decodePath(u.pathname), rawPath: u.pathname, query, file: p.file };
  };

  for (const r of ordered) {
    const u = new URL(r.url);
    const kind = kinds.get(r.key) ?? 'other';
    const query = cleanSearch(u.search).slice(1) || undefined;
    const plan: Plan = { res: r, kind, file: '' };
    plans.push(plan);

    const ignorableQuery = query !== undefined && kind !== 'html' && (variants.get(u.pathname)?.size ?? 0) <= 1;
    if (query !== undefined && !ignorableQuery) {
      toRoute(plan, query);
      continue;
    }
    const decoded = decodePath(u.pathname);
    const file = plainFile(decoded, kind, path.posix.extname(decoded).toLowerCase(), r.contentType ?? '');
    if (!file) {
      toRoute(plan);
      continue;
    }
    const lower = file.toLowerCase();
    const owner = taken.get(lower);
    if (owner === undefined) {
      taken.set(lower, r.sha1 ?? r.key);
      plan.file = file;
    } else if (owner === r.sha1) {
      plan.file = file;
      plan.shared = true;
    } else if (ignorableQuery) {
      // A query variant of a file that already exists with other bytes: route it by its query.
      toRoute(plan, query);
    } else {
      toRoute(plan);
    }
  }

  // A file and a folder cannot share a name (/index.php and /index.php/about): move the file aside.
  const dirs = new Set<string>();
  for (const p of plans) {
    if (p.route) continue;
    const parts = p.file.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const p of plans) if (!p.route && dirs.has(p.file.toLowerCase())) toRoute(p);
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

  // 3. Write every file.
  const pages: PageRecord[] = [];
  const types: TypeOverride[] = [];
  const cleaned = { wayback: 0, trackers: 0 };
  let phpLeftovers = 0;

  for (const p of plans) {
    if (p.shared) continue;
    const body = await readRaw(p.res);
    if (p.kind === 'html') {
      const pageUrl = new URL(p.res.url);
      const { text } = decodeText(body, p.res.contentType ?? '');
      // The parser rewrites any doctype to <!DOCTYPE html>; old pages keep their own so browsers
      // render them in the same (often quirks) mode as before.
      const doctype = /<!doctype[^>]*>/i.exec(text.slice(0, 4096))?.[0];
      const $ = loadHtml(stripWaybackMarkup(text.replace(/^\uFEFF?\s*<\?xml[^>]*\?>\s*/i, '')));
      const stats = cleanDocument($, { stripTracking: opts.stripTracking });
      cleaned.wayback += stats.waybackRemoved;
      cleaned.trackers += stats.trackersRemoved;
      visitUrls($, (v) => {
        const t = v.trim();
        const out = rootRel(unwrapWayback(t));
        return out !== t ? out : undefined;
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
      const css = rewriteCss(unwrapWaybackInText(body.toString('latin1')), (u) => {
        const out = rootRel(u);
        return out !== u ? out : undefined;
      });
      await write(p.file, Buffer.from(css, 'latin1'));
    } else if (p.kind === 'js' || p.kind === 'xml') {
      const text = body.toString('latin1');
      await write(p.file, text.includes('archive.org/web/') ? Buffer.from(unwrapWaybackInText(text), 'latin1') : body);
    } else {
      await write(p.file, body);
    }
  }
  if (phpLeftovers) warnings.push(`${phpLeftovers} script(s) in .php pages contain "<?"; check them if your host runs PHP with short tags on.`);

  // 4. Redirects the original site made.
  const queryPaths = new Set<string>();
  for (const r of manifest.resources) {
    const u = new URL(r.url);
    if (cleanSearch(u.search)) queryPaths.add(u.pathname);
  }
  const redirects: Redirect[] = [];
  for (const r of manifest.resources) {
    if (r.status === 200 || !r.location) continue;
    const u = new URL(r.url);
    const loc = toUrl(r.location);
    if (!loc) continue;
    const to = isInternal(loc, opts.domain) ? pathAndQuery(loc) : loc.toString();
    if (to === r.path) continue;
    const query = cleanSearch(u.search).slice(1) || undefined;
    redirects.push({
      path: decodePath(u.pathname),
      rawPath: u.pathname,
      query,
      noQuery: query === undefined && queryPaths.has(u.pathname),
      to,
      status: r.status,
    });
  }

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
  const rules: ServerRules = { domain: opts.domain, host: new URL(opts.siteUrl).host, routes, redirects, types };
  await write('.htaccess', htaccess(rules));
  await write('_redirects', netlifyRedirects(rules));
  await write('_headers', netlifyHeaders(rules));
  await write(
    '__wbd/routes.json',
    JSON.stringify({ domain: opts.domain, siteUrl: opts.siteUrl, routes, redirects, types }, null, 1),
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
