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
import * as cheerio from 'cheerio';
import type { AnyNode, ProcessingInstruction } from 'domhandler';
import { decodeText, detectCharset, isValidUtf8 } from './charset.ts';
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
  pagesOverflow,
  ruleUrl,
  type FileAlias,
  type Redirect,
  type Route,
  type ServerRules,
  type TypeOverride,
} from './serverconfig.ts';
import { robotsTxt, rssFeed, sitemaps, sitemapXsl, type SitemapEntry } from './sitemap.ts';
import {
  cleanSearch,
  decodePath,
  hasEncodedSlash,
  hasNonUtf8Escapes,
  isInternal,
  makeRootRelative,
  mergeSlashes,
  pathAndQuery,
  QUERY_PASSES,
  rawPathKey,
  ruleQuery,
  serverPath,
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
  /** Other archived spellings of this plan's address, served from it (see Route.aliases). */
  aliases?: string[];
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
  return mergeSlashes(u.pathname);
}

/**
 * The address Apache and nginx answer this URL from: //a.php?x=1&fbclid=2 and /a.php?x=1 are one
 * address, and so are /caf%e9.html and /caf%E9.html.
 */
function address(u: URL): string {
  const query = cleanSearch(u.search);
  return serverPath(u.pathname) + query;
}

function isPermanent(status: number): boolean {
  return status === 301 || status === 308;
}

/** Records raw, another archived spelling of the address that x answers at its own raw path. */
function addAlias(x: { aliases?: string[] }, own: string, raw: string): void {
  if (raw !== own && !x.aliases?.includes(raw)) (x.aliases ??= []).push(raw);
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
  if (!body.some((b) => b > 0x7f) || hasBom(body)) return undefined;
  const declared =
    charsetLabel(/charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1]) ??
    (kind === 'css' ? charsetLabel(/^@charset "([^"]+)";/.exec(body.subarray(0, 64).toString('latin1'))?.[1]) : undefined) ??
    (kind === 'xml' ? charsetLabel(XML_ENCODING.exec(body.subarray(0, 1024).toString('latin1'))?.[3]) : undefined);
  // Valid UTF-8 that a page only implies is another charset is far more likely really UTF-8.
  const implied = pageCharset?.startsWith('utf-16') || isValidUtf8(body) ? undefined : pageCharset;
  const cs = declared ?? implied;
  return cs && cs !== 'utf-8' ? cs : undefined;
}

function hasBom(body: Buffer): boolean {
  return (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) || (body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff);
}

/** The encoding an <?xml?> declaration names: $3, between the quotes $2. */
const XML_ENCODING = /^(\s*<\?xml\b[^>]*?\sencoding\s*=\s*)(["'])([^"']*)\2/;

/**
 * The legacy charset a feed or other XML file, or a text file, was read with. Servers send text as
 * UTF-8 and leave XML to its declaration, so these are converted to UTF-8 like the pages. As for
 * pages, bytes that are mostly not UTF-8 under a UTF-8 label, or none, were windows-1252.
 */
function fileCharset(body: Buffer, contentType: string, kind: Kind, pageCharset: string | undefined): string | undefined {
  if (!body.some((b) => b > 0x7f) || hasBom(body)) return undefined;
  // Not text after all: a .docx is "officedocument...xml", a text/plain URL can hold anything.
  if (body.includes(0) || (kind === 'xml' && !/^\s*</.test(body.subarray(0, 256).toString('latin1')))) return undefined;
  // Without a BOM or a NUL byte the text is no UTF-16, whatever its label says (.NET wrote
  // encoding="utf-16" on UTF-8 files): as for a label in a page, it is read as UTF-8 if it is that.
  const label = legacyCharset(body, contentType, kind, pageCharset);
  const cs = (label?.startsWith('utf-16') ? undefined : label) ?? detectCharset(body, 'charset=utf-8');
  return cs === 'utf-8' ? undefined : cs;
}

/** A plain text file, which servers send as text/plain by its .txt name. */
function isText(p: Plan): boolean {
  return p.kind === 'other' && path.posix.extname(p.file).toLowerCase() === '.txt' && /^(text\/plain\b|\s*$)/i.test(p.res.contentType ?? '');
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

/** What comes before a doctype, which the HTML parser skips: whitespace, comments, bogus comments. */
const BEFORE_DOCTYPE = /[\t\n\f\r ]+|<!--(?:-?>|[\s\S]*?--!?>)|<(?:\?|!(?!--|doctype)|\/(?![a-z]))[^>]*>/iy;
const DOCTYPE = /<!doctype[^>]*>/iy;

/**
 * The doctype as the page wrote it ("<!DOCTYPE HTML PUBLIC ...>"), found the way the parser finds
 * it: after any number of comments, however long, and never inside one.
 */
function sourceDoctype(html: string): string | undefined {
  let at = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (BEFORE_DOCTYPE.lastIndex = at; BEFORE_DOCTYPE.test(html); BEFORE_DOCTYPE.lastIndex = at) at = BEFORE_DOCTYPE.lastIndex;
  DOCTYPE.lastIndex = at;
  return DOCTYPE.exec(html)?.[0];
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its character and entity references resolved. */
function decodeXmlText(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec?: string, hex?: string, name?: string) => {
    if (name) return XML_ENTITIES[name];
    const cp = dec ? Number(dec) : parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** Deeper XML than this is read as HTML: xhtmlAsHtml writes it back level by level. */
const XML_DEPTH_MAX = 500;

/**
 * One piece of markup as the XML parser of cheerio splits it: comment, CDATA, processing
 * instruction, doctype (without an internal subset), text, end tag ($1) or start tag ($2) with
 * quoted attributes, "/" in $3 when it closes itself.
 */
const XML_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[^>]*>|<![Dd][Oo][Cc][Tt][Yy][Pp][Ee][^>[]*>|[^<]+|<\/([A-Za-z_:][-\w.:]*)\s*>|<([A-Za-z_:][-\w.:]*)(?:\s+[A-Za-z_:][-\w.:]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>/y;

/**
 * True when the elements of the markup nest as XML requires: every tag closed, in order, and no
 * element inside a <script> or <style>. Anything else was written for the HTML parser (<br> left
 * open, a script with "i<n" and no CDATA), which reads it as the author saw it in most browsers.
 */
function isWellFormedXml(xml: string): boolean {
  const open: string[] = [];
  let raw = 0;
  for (XML_TOKEN.lastIndex = 0; XML_TOKEN.lastIndex < xml.length; ) {
    const m = XML_TOKEN.exec(xml);
    if (!m) return false;
    const [, end, start, closed] = m;
    if (end !== undefined) {
      if (open.pop() !== end) return false;
      if (end === 'script' || end === 'style') raw--;
    } else if (start !== undefined) {
      if (raw > 0 || open.length >= XML_DEPTH_MAX) return false;
      if (closed) continue;
      open.push(start);
      if (start === 'script' || start === 'style') raw++;
    }
  }
  return open.length === 0;
}

/**
 * A page served as application/xhtml+xml, read as browsers read it, with the XML parser: there
 * <script src="a.js"/> is an empty element and <![CDATA[ ]]> plain text, where the HTML parser takes
 * the first for a script holding the rest of the page. Written back as HTML that means the same,
 * which the build reads and servers send as text/html. XML always renders in standards mode, so
 * the page gets <!DOCTYPE html>, whatever doctype it had. Markup that is no XML stays as it is.
 */
function xhtmlAsHtml(xml: string): string {
  if (!isWellFormedXml(xml)) return xml;
  const $ = cheerio.load(xml, { xml: { decodeEntities: false } });
  // Text stays as written, as the HTML parser reads its references the same way, except inside
  // <script> and <style>, where HTML reads none.
  const write = (nodes: AnyNode[], raw: boolean): string =>
    nodes
      .map((n) => {
        if (n.type === 'text') return raw ? decodeXmlText(n.data) : n.data;
        if (n.type === 'cdata') {
          const data = n.children.map((c) => ('data' in c ? c.data : '')).join('');
          return raw ? data : data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        // In a script or style, a comment ("<!-- ... //-->") stays: browsers that got the page as
        // text/html ran and applied what it holds, and so does the HTML parser that reads it now.
        if (n.type === 'comment') return `<!--${n.data}-->`;
        if (n.type === 'tag' || n.type === 'script' || n.type === 'style') {
          const attrs = Object.entries(n.attribs).map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`);
          const inner = write(n.children, raw || n.name === 'script' || n.name === 'style');
          return `<${n.name}${attrs.join('')}>${inner}${VOID_ELEMENTS.has(n.name) ? '' : `</${n.name}>`}`;
        }
        return ''; // the doctype and processing instructions
      })
      .join('');
  return '<!DOCTYPE html>' + write($.root()[0].children, false);
}

/** A page's markup for the HTML parser: without an <?xml?> declaration, and XHTML read as XML. */
function htmlSource(text: string, contentType: string): string {
  const html = text.replace(/^\uFEFF?\s*<\?xml[^>]*\?>\s*/i, '');
  return /application\/xhtml\+xml/i.test(contentType) ? xhtmlAsHtml(html) : html;
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
    const set = variants.get(serverPath(u.pathname)) ?? new Set<string>();
    set.add(r.sha1 ?? r.key);
    variants.set(serverPath(u.pathname), set);
  }

  const taken = new Map<string, Plan>();
  const owners = new Map<string, Plan>();
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
    // The server reads //a/b.png as /a/b.png, so the first capture at an address serves every
    // spelling of it (shorter paths come first). Another spelling with other bytes keeps them at
    // its own raw path only, when the server can tell it apart (by its doubled slashes).
    const first = owners.get(address(u));
    const firstPath = first && new URL(first.res.url).pathname;
    if (first && ((first.res.sha1 ?? first.res.key) === (r.sha1 ?? r.key) || rawPathKey(firstPath!) === rawPathKey(u.pathname))) {
      addAlias(first, firstPath!, u.pathname);
      continue;
    }
    const plan: Plan = { res: r, kind, file: '' };
    plans.push(plan);
    if (first) {
      toRoute(plan, query);
      plan.route!.exact = true;
      continue;
    }
    owners.set(address(u), plan);

    const ignorableQuery = query !== undefined && kind !== 'html' && (variants.get(serverPath(u.pathname))?.size ?? 0) <= 1;
    if (query !== undefined && !ignorableQuery) {
      toRoute(plan, query);
      continue;
    }
    const decoded = decodePath(pathname);
    // Servers look up neither bytes that are not UTF-8 nor an escaped slash by a file name: /tag/AC%2FDC
    // is /tag/AC/DC to nginx and Pages, which a route keyed by that address serves.
    const file = !hasNonUtf8Escapes(pathname) && !hasEncodedSlash(pathname) && plainFile(decoded, kind, path.posix.extname(decoded).toLowerCase(), r.contentType ?? '');
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
  // Also at the address a server answers the URL from: //img/a.png is served at /img/a.png too.
  const available = new Set(
    content.flatMap((r) => {
      const u = new URL(r.url);
      return [r.path, u.pathname, mergeSlashes(u.pathname) + cleanSearch(u.search), mergeSlashes(u.pathname)];
    }),
  );
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
    const source = htmlSource(text, home.res.contentType ?? '');
    const $ = loadHtml(source);
    const meta = extractMeta($, new URL(home.res.url), opts.domain, { hasPath });
    homeTitle = meta.title;
    siteNameHint = meta.siteNameHint;
    siteDescription = meta.description;
    logo = pickLogo(source, new URL(home.res.url), opts.domain);
  }
  const siteName = guessSiteName(titles, homeTitle, siteNameHint, opts.domain);
  const rssPath = !takenPaths.has('/rss/') && !takenPaths.has('/rss') && !takenFiles.has('rss/index.xml') ? '/rss/' : !takenPaths.has('/rss.xml') ? '/rss.xml' : undefined;
  const site: SiteContext = { siteUrl: opts.siteUrl, siteName, siteDescription, logo, rssPath };
  log(`site name: ${siteName}`);

  // 3. Write every file. Pages go first: they tell which charset their scripts and stylesheets were
  // read with, and those are converted to UTF-8 like the pages.
  const pages: PageRecord[] = [];
  // Pages of a spelling that only differs from another page's address by doubled slashes (//a.html
  // next to /a.html): their address belongs to that page in sitemaps and the feed.
  const twins = new Set<string>();
  const types: TypeOverride[] = [];
  const cleaned = { wayback: 0, trackers: 0 };
  let phpLeftovers = 0;
  // Plans by the address a link reaches (//js/a.js and /js/a.js?fbclid=1 reach /js/a.js).
  const planByAddress = new Map<string, Plan>();
  for (const p of plans) if (!p.route?.exact && !planByAddress.has(address(new URL(p.res.url)))) planByAddress.set(address(new URL(p.res.url)), p);
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
      const source = stripWaybackMarkup(htmlSource(text, p.res.contentType ?? ''));
      const $ = loadHtml(source);
      // The parser writes any doctype as <!DOCTYPE html>; old pages keep their own so browsers
      // render them in the same (often quirks) mode as before.
      const doctypeNode = $.root()[0].children.find((n): n is ProcessingInstruction => n.type === 'directive');
      const doctype = doctypeNode && (sourceDoctype(source) ?? `<${doctypeNode.data}>`);
      const stats = cleanDocument($, { stripTracking: opts.stripTracking });
      cleaned.wayback += stats.waybackRemoved;
      cleaned.trackers += stats.trackersRemoved;
      visitUrls($, relink);
      count(siteCharsets, charset);
      $('script[src], link[href]').each((_, el) => {
        const $el = $(el);
        if (el.tagName === 'link' && !/(^|\s)stylesheet(\s|$)/i.test($el.attr('rel') ?? '')) return;
        const u = toUrl($el.attr(el.tagName === 'link' ? 'href' : 'src') ?? '', pageUrl);
        const target = u && isInternal(u, opts.domain) ? planByAddress.get(address(u)) : undefined;
        if (!target || (target.kind !== 'js' && target.kind !== 'css')) return;
        const own = charsetLabel($el.attr('charset'));
        const file = (target.sameAs ?? target).file;
        if (!fileCharsets.has(file)) fileCharsets.set(file, new Map());
        count(fileCharsets.get(file)!, own ?? charset);
        // The file is written as UTF-8 below.
        if (own && own !== 'utf-8') $el.attr('charset', 'utf-8');
      });
      // Canonical, og:url and sitemap: a spelling of another page's address (//a.html next to
      // /a.html) names that address, any other page its own URL, except that "//a.html" alone would
      // name a host "a.html" (links to it lose the extra slash too). Links above resolve against
      // the URL as the browser has it.
      const pageAddress = new URL(pageUrl);
      pageAddress.pathname = p.route?.exact ? mergeSlashes(pageUrl.pathname) : pageUrl.pathname.replace(/^\/{2,}/, '/');
      const meta = extractMeta($, pageAddress, opts.domain, { hasPath });
      for (const key of ['canonicalPath', 'image'] as const) meta[key] = meta[key]?.replace(/^\/{2,}/, '/');
      applySeo($, meta, site);
      // Only the parser's own doctype is replaced, not one in a comment before it.
      let html = $.root()[0].children.map((n) => (n === doctypeNode ? doctype : $.html(n))).join('');
      const ext = path.posix.extname(p.file).toLowerCase();
      if (SERVER_EXT.has(ext)) {
        const safe = phpSafe(html);
        html = safe.html;
        phpLeftovers += safe.leftovers;
        types.push({ file: p.file, contentType: 'text/html; charset=utf-8', rawPath: pageUrl.pathname });
      }
      await write(p.file, html);
      const lastmod = meta.modifiedAt ?? meta.publishedAt ?? tsToIso(p.res.timestamp);
      pages.push({ ...meta, file: p.file, timestamp: p.res.timestamp, lastmod });
      if (p.route?.exact) twins.add(p.file);
    } else if (p.kind === 'css') {
      const cs = legacyCharset(body, p.res.contentType ?? '', 'css', pageCharset(p));
      // latin1 keeps the bytes exactly as they were when the charset stays.
      const text = cs ? new TextDecoder(cs).decode(body).replace(/^@charset "[^"]*";/, '@charset "utf-8";') : body.toString('latin1');
      await write(p.file, Buffer.from(rewriteCss(text, relink), cs ? 'utf8' : 'latin1'));
    } else if (p.kind === 'js' || p.kind === 'xml') {
      const ct = p.res.contentType ?? '';
      const cs = p.kind === 'js' ? legacyCharset(body, ct, 'js', pageCharset(p)) : fileCharset(body, ct, 'xml', undefined);
      const text = cs ? new TextDecoder(cs).decode(body) : body.toString('latin1');
      let out = text.includes('archive.org/web/') ? unwrapWaybackInText(text, opts.domain) : text;
      // The bytes are UTF-8 now (or were all along, whatever the declaration said), and no server
      // sends a charset with XML: the declaration is what readers go by.
      if (p.kind === 'xml' && body.some((b) => b > 0x7f) && !hasBom(body)) {
        out = out.replace(XML_ENCODING, (m, start: string, q: string, label: string) => (charsetLabel(label) === 'utf-8' ? m : `${start}${q}UTF-8${q}`));
      }
      await write(p.file, cs ? Buffer.from(out, 'utf8') : out !== text ? Buffer.from(out, 'latin1') : body);
    } else if (isText(p)) {
      // Servers send .txt files as UTF-8 (AddDefaultCharset, nginx's charset, the preview).
      const cs = fileCharset(body, p.res.contentType ?? '', p.kind, pageCharset(p));
      await write(p.file, cs ? Buffer.from(new TextDecoder(cs).decode(body), 'utf8') : body);
    } else {
      await write(p.file, body);
    }
  }
  for (const p of plans) if (p.sameAs) await write(p.file, await readFile(path.join(root, p.sameAs.file)));
  if (phpLeftovers) warnings.push(`${phpLeftovers} script(s) in .php pages contain "<?"; check them if your host runs PHP with short tags on.`);

  // 4. Redirects the original site made. Like a capture (see planFiles), a redirect answers every
  // spelling of its address, unless a page or another redirect already answers there: then it
  // fires for its own raw path only (/r.php?id=2 is a page and //r.php?id=2 redirects).
  const queryPaths = new Set<string>();
  for (const r of manifest.resources) {
    const u = new URL(r.url);
    if (cleanSearch(u.search)) queryPaths.add(serverPath(u.pathname));
  }
  // What answers at each address and at which raw path; another spelling that answers the same way
  // there becomes an alias of it.
  interface Answer {
    raw: string;
    rawPath: string;
    of: Plan | Redirect;
    to?: string;
    permanent?: boolean;
  }
  const answered = new Map<string, Answer>();
  for (const p of plans) {
    const u = new URL(p.res.url);
    if (!p.route?.exact) answered.set(address(u), { raw: rawPathKey(u.pathname), rawPath: u.pathname, of: p });
  }
  const redirects: Redirect[] = [];
  const exactDone = new Map<string, Redirect>();
  // The spelling the server reads as is goes first: it is the one the address belongs to.
  const moved = manifest.resources.filter((r) => r.status !== 200 && r.location);
  const merged = (r: Resource) => (sitePath(new URL(r.url)) === new URL(r.url).pathname ? 0 : 1);
  for (const r of [...moved].sort((a, b) => merged(a) - merged(b))) {
    const u = new URL(r.url);
    const loc = toUrl(r.location!);
    if (!loc) continue;
    const internal = isInternal(loc, opts.domain);
    // "//a.jpg" in a Location header names a host "a.jpg"; the server reads it as /a.jpg anyway.
    const to = internal ? pathAndQuery(loc).replace(/^\/{2,}/, '/') : loc.toString();
    const raw = rawPathKey(u.pathname);
    const at = address(u);
    // A redirect to its own address would loop (/a.php to /a.php?fbclid=1, %e9 to %E9); one to
    // another spelling of it (//a.php to /a.php) is kept for that spelling only.
    const self = internal && address(loc) === at;
    const loops = self && rawPathKey(loc.pathname.replace(/^\/{2,}/, '/')) === raw;
    const owner = answered.get(at);
    // This spelling answers as the address does (//old.php next to /old.php, both to /).
    if (loops || (owner && (owner.raw === raw || (owner.to === to && owner.permanent === isPermanent(r.status))))) {
      if (owner) addAlias(owner.of, owner.rawPath, u.pathname);
      continue;
    }
    const query = cleanSearch(u.search).slice(1) || undefined;
    const exact = self || owner !== undefined;
    const done = exact ? exactDone.get(raw + '?' + (query ?? '')) : undefined;
    if (done) {
      addAlias(done, done.rawPath, u.pathname);
      continue;
    }
    const d: Redirect = {
      path: decodePath(sitePath(u)),
      rawPath: u.pathname,
      query,
      noQuery: query === undefined && queryPaths.has(serverPath(u.pathname)),
      to,
      status: r.status,
      ...(exact ? { exact } : {}),
    };
    redirects.push(d);
    if (exact) exactDone.set(raw + '?' + (query ?? ''), d);
    else answered.set(at, { raw, rawPath: u.pathname, of: d, to, permanent: isPermanent(r.status) });
  }

  // Cloudflare Pages compares _redirects lines with the path as sent, where Apache, nginx and the
  // preview merge slashes and decode escapes: there, each archived spelling of an address names
  // what serves it. A plain file serves its own URL there unless that has doubled slashes, or is
  // a folder served from index.xml, which gets a line in any spelling (/caf%c3%a9/feed/ as well
  // as /caf%C3%A9/feed/).
  const fileAliases: FileAlias[] = [];
  for (const p of plans) {
    if (p.route) {
      if (p.aliases) p.route.aliases = p.aliases;
      continue;
    }
    const own = new URL(p.res.url).pathname;
    const ownLine = own !== mergeSlashes(own) || (own.endsWith('/') && p.file.endsWith('index.xml'));
    for (const raw of [...(ownLine ? [own] : []), ...(p.aliases ?? [])]) fileAliases.push({ rawPath: raw, file: p.file });
  }

  // 5. Sitemaps, feed, robots.txt, 404 page.
  const indexable = pages.filter((pg) => !twins.has(pg.file) && !pg.noindex && pg.type !== 'archive' && (!pg.canonicalPath || pg.canonicalPath === pg.path));
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

  const posts = pages.filter((pg) => pg.type === 'post' && pg.publishedAt && !pg.noindex && !twins.has(pg.file));
  if (site.rssPath) {
    const feed = rssFeed(
      { siteUrl: opts.siteUrl, siteName, description: siteDescription ?? siteName, rssPath: site.rssPath },
      posts.map((pg) => ({ title: pg.headline, path: pg.path, description: pg.description, publishedAt: pg.publishedAt!, author: pg.author, tags: pg.tags, image: pg.image })),
    );
    await write(site.rssPath === '/rss/' ? 'rss/index.xml' : 'rss.xml', feed);
  }
  if (!takenFiles.has('404.html')) await write('404.html', notFoundPage(siteName, home ? pages.find((pg) => pg.path === '/')?.lang : undefined));

  // 6. Server rules. Cloudflare Pages needs the plain files to tell x.html next to a file x apart.
  const unmatched = [...content, ...moved].filter((r) => ruleQuery(new URL(r.url).search) === undefined);
  if (unmatched.length) {
    warnings.push(
      `${unmatched.length} original URL(s) such as ${unmatched[0].url} have more than ${QUERY_PASSES} runs of empty or tracking parameters in the query string, more than the server rules strip; they answer only without them.`,
    );
  }
  const slashed = [...content, ...moved].filter((r) => hasEncodedSlash(new URL(r.url).pathname));
  if (slashed.length) {
    warnings.push(
      `${slashed.length} original URL(s) such as ${slashed[0].url} have an escaped slash (%2F) in the path. Apache and LiteSpeed answer them 404 unless the server configuration (not .htaccess) says "AllowEncodedSlashes On"; nginx, Cloudflare Pages and the preview serve them.`,
    );
  }
  const plain = [...new Set(plans.filter((p) => !p.route).map((p) => p.file))];
  // The generated feed too: Pages and Netlify serve /rss/ only through a line of _redirects.
  if (site.rssPath === '/rss/') plain.push('rss/index.xml');
  const rules: ServerRules = { domain: opts.domain, host: new URL(opts.siteUrl).host, routes, redirects, types, files: plain, fileAliases };
  const pagesRedirects = netlifyRedirects(rules);
  const pagesHeaders = netlifyHeaders(rules);
  const tooLong = { apache: [] as Array<Route | Redirect>, nginx: [] as Array<Route | Redirect> };
  await write('.htaccess', htaccess(rules, tooLong.apache));
  await write('_redirects', pagesRedirects);
  await write('_headers', pagesHeaders);
  const ignored = pagesOverflow(pagesRedirects, pagesHeaders);
  if (ignored) {
    warnings.push(
      `Cloudflare Pages reads at most 2,000 plain and 100 pattern rules from _redirects and 100 rules from _headers, and no line of more than 2,000 characters; ${ignored} rule(s) of this site are past that, so some original URLs would redirect or fail there. Netlify, Apache, LiteSpeed and nginx are not affected.`,
    );
  }
  await write('__wbd/routes.json', JSON.stringify({ domain: opts.domain, siteUrl: opts.siteUrl, routes, redirects, types }, null, 1));
  await writeFile(path.join(opts.serverDir, 'nginx.conf'), nginxConf(rules, tooLong.nginx));
  for (const [list, file, server, limit] of [
    [tooLong.apache, '.htaccess', 'Apache and LiteSpeed', '8,191 bytes per line'],
    [tooLong.nginx, 'nginx.conf', 'nginx', '4,095 bytes per parameter'],
  ] as const) {
    if (!list.length) continue;
    warnings.push(
      `${list.length} original URL(s) such as ${ruleUrl(list[0])} are too long for a rule of ${file} (${limit}): one such rule would stop ${server} serving any page, so ${file} leaves them out and they do not answer as archived there.`,
    );
  }

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
