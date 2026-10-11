// Server rules that keep every original URL working exactly as before.
//
// A static host serves /about/ and /about.html by itself. It cannot serve /index.php?page=contact
// (a query string) or an image stored at an extensionless URL; those get an internal rewrite to
// the stored file, so the address in the browser and in Google's index stays the same. The only
// redirects are the ones the original site itself made, as recorded by the archive.
//
// A rule matches a request the way Apache and nginx read it: the path with slashes merged and
// escapes decoded to bytes (//a.php, /caf%e9.html), the query string without tracking parameters
// and empty segments (?id=3&fbclid=x, ?a=1&&b=2). The preview server (serve.ts) does the same.

import { droppedRunPattern, mergeSlashes, pathBytesPattern, QUERY_PASSES } from './url.ts';

export interface Route {
  /** Decoded path, e.g. "/index.php". */
  path: string;
  /** Path as it appears in the URL (percent-encoded). */
  rawPath: string;
  /** Raw query without "?", or undefined for a path-only route. */
  query?: string;
  /** Site-relative file, e.g. "__wbd/q/3f2a9c.html". */
  file: string;
  /**
   * Matches rawPath only as sent, doubled slashes and all: another archived URL owns the address
   * the server reads it as (//a.png next to a different /a.png).
   */
  exact?: boolean;
}

export interface Redirect {
  path: string;
  rawPath: string;
  query?: string;
  /** Path-only redirect that must not fire when a query string is present (the path also has query URLs). */
  noQuery?: boolean;
  /** Root-relative path (same site) or absolute URL. */
  to: string;
  status: number;
  /** As Route.exact. */
  exact?: boolean;
}

export interface TypeOverride {
  /** Site-relative file whose extension servers do not map to HTML (e.g. "about.php"). */
  file: string;
  contentType: string;
}

export interface ServerRules {
  domain: string;
  host: string;
  routes: Route[];
  redirects: Redirect[];
  types: TypeOverride[];
  /**
   * Site-relative files served at their own URL (not route targets), e.g. "menu.html". Without it,
   * Cloudflare Pages serves x.jpg instead of x.jpg.html when both exist.
   */
  files?: string[];
}

export const HTML_LIKE_EXT = ['php', 'php3', 'php4', 'php5', 'phtml', 'asp', 'aspx', 'jsp', 'jspx', 'cfm', 'cgi', 'pl', 'shtml', 'shtm', 'do', 'action'];

// mod_rewrite splits its own arguments: a quote always ends a quoted argument (a backslash does not
// escape it) and a raw newline ends the line, so one such byte in an archived path would make the
// whole .htaccess invalid. Arguments never contain either: patterns spell them as \xHH escapes
// (regexEscape) and targets percent-encode them (apacheUrl).
function apacheQuoted(s: string): string {
  return `"${s}"`;
}

/** A PCRE pattern matching s literally, with quotes and control characters as \xHH escapes. */
function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/["\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** RewriteRule pattern for the path as Apache reads it (merged slashes, decoded bytes). */
function apachePath(rawPath: string): string {
  return apacheQuoted('^' + pathBytesPattern(rawPath).replace(/^\//, '').replace(/"/g, '\\x22') + '$');
}

/** PCRE for the path exactly as the browser sends it; an escape matches in either letter case. */
function rawPattern(rawPath: string): string {
  const anyCase = (c: string) => (/[a-f]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c);
  return regexEscape(rawPath).replace(/%([0-9a-f])([0-9a-f])/gi, (_m, a: string, b: string) => '%' + anyCase(a) + anyCase(b));
}

// Apache compares query strings in WBD_QUERY, which the rules at the top set to "&" + the query
// without tracking parameters and empty segments + "&": one cheap pattern per rule, where a
// pattern that skips them itself is ten times longer, and Apache compiles every pattern of
// .htaccess again on each request. nginx keeps the same string in a variable.
const QUERY_VAR = 'WBD_QUERY';

function queryCond(query: string): string {
  return `RewriteCond %{ENV:${QUERY_VAR}} ${apacheQuoted('^&' + (query ? regexEscape(query) + '&' : '') + '$')}`;
}

/** The rule fires only for rawPath as sent (Route.exact). */
function requestCond(rawPath: string): string {
  return `RewriteCond %{THE_REQUEST} ${apacheQuoted('^\\S+\\s+' + rawPattern(rawPath) + '[?\\s]')}`;
}

// Percent-encodes the bytes that cannot appear literally in a quoted mod_rewrite argument.
function apacheUrl(s: string): string {
  return s.replace(/["\x00-\x1f\x7f]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function apacheTarget(to: string, dropQuery: boolean): string {
  let t = apacheUrl(to).replace(/\$/g, '\\$').replace(/%/g, '\\%');
  if (dropQuery && !to.includes('?')) t += '?';
  return t;
}

/** A site-relative file name as it appears in a URL path. */
function encodeFile(file: string): string {
  return encodeURI(file).replace(/[#?]/g, encodeURIComponent);
}

/** Internal rewrite target: Apache decodes it again, so % and # must be encoded. */
function apacheFile(file: string): string {
  return apacheTarget(encodeFile(file), false);
}

function isPermanent(status: number): boolean {
  return status === 301 || status === 308;
}

export function htaccess(r: ServerRules): string {
  const out: string[] = [];
  out.push(`# Generated by zplus.ai for ${r.domain}.`);
  out.push(`# Keeps every original URL working exactly as before: no URL is changed, and the only`);
  out.push(`# redirects are the ones the original site made. Works on Apache and LiteSpeed.`);
  out.push(`# If the host answers "500 Internal Server Error", delete the Options line below.`);
  out.push('');
  out.push('Options -Indexes -MultiViews');
  out.push('DirectoryIndex index.html index.xml');
  out.push('ErrorDocument 404 /404.html');
  out.push('AddDefaultCharset utf-8');
  out.push(`AddType "text/html; charset=utf-8" ${HTML_LIKE_EXT.filter((e) => !e.startsWith('php') && e !== 'phtml').map((e) => '.' + e).join(' ')}`);
  out.push('RemoveHandler .cgi .pl .shtml .shtm');
  out.push('');
  out.push('<IfModule mod_dir.c>');
  out.push('  DirectorySlash Off');
  out.push('</IfModule>');
  out.push('');
  out.push('<IfModule mod_rewrite.c>');
  out.push('RewriteEngine On');
  out.push('RewriteBase /');
  out.push('');
  out.push('# Stored copies are only reachable through their original URLs.');
  out.push('RewriteCond %{THE_REQUEST} \\s/+__wbd/ [NC]');
  out.push('RewriteRule ^ - [R=404,L]');
  out.push('');
  out.push('# The rules read the URL as requested. Once one has picked a file (/about -> about.html),');
  out.push('# Apache reads them again for that file, and they must leave it alone.');
  out.push('RewriteCond %{ENV:REDIRECT_STATUS} .');
  out.push('RewriteRule ^ - [L]');

  if ([...r.redirects, ...r.routes].some((x) => x.query !== undefined || ('noQuery' in x && x.noQuery))) {
    out.push('');
    out.push('# Query strings are compared the way the URLs were archived: without tracking parameters');
    out.push(`# (utm_*, fbclid, ...) and empty segments. ${QUERY_VAR} holds "&" + that query + "&". Each pair`);
    out.push(`# of lines drops one run of them; a fixed number, not an [N] loop, so no query costs much.`);
    out.push(`RewriteRule ^ - [E=${QUERY_VAR}:&%{QUERY_STRING}&]`);
    for (let i = 0; i < QUERY_PASSES; i++) {
      out.push(`RewriteCond %{ENV:${QUERY_VAR}} ${apacheQuoted(droppedRunPattern())} [NC]`);
      out.push(`RewriteRule ^ - [E=${QUERY_VAR}:%1%2]`);
    }
    // Runs left over: no rule matches, and each rule would copy the whole query to find out.
    out.push(`RewriteCond %{ENV:${QUERY_VAR}} ${apacheQuoted(droppedRunPattern())} [NC]`);
    out.push(`RewriteRule ^ - [E=${QUERY_VAR}:-]`);
  }

  // Rules for one raw spelling only go first: the rule of the address they share would catch them.
  const exactFirst = <T extends Route | Redirect>(xs: T[]) => [...xs.filter((x) => x.exact), ...xs.filter((x) => !x.exact)];
  if (r.redirects.length) {
    out.push('');
    out.push('# Redirects the original site made (recorded by the Wayback Machine).');
    for (const d of exactFirst(r.redirects)) {
      const flag = `[R=${isPermanent(d.status) ? 301 : 302},NE,L]`;
      if (d.exact) out.push(requestCond(d.rawPath));
      if (d.query !== undefined || d.noQuery) out.push(queryCond(d.query ?? ''));
      out.push(`RewriteRule ${apachePath(d.rawPath)} ${apacheQuoted(apacheTarget(d.to, d.query !== undefined || d.noQuery === true))} ${flag}`);
    }
  }

  // NS: mod_dir looks up /folder/index.html with a subrequest, which must not pick up the route of
  // the /folder/index.html URL when /folder/ is a different page.
  const route = (x: Route) => [
    ...(x.exact ? [requestCond(x.rawPath)] : []),
    ...(x.query !== undefined ? [queryCond(x.query)] : []),
    `RewriteRule ${apachePath(x.rawPath)} ${apacheQuoted(apacheFile(x.file))} [NS,L]`,
  ];
  const exactRoutes = r.routes.filter((x) => x.exact);
  const queryRoutes = r.routes.filter((x) => !x.exact && x.query !== undefined);
  const pathRoutes = r.routes.filter((x) => !x.exact && x.query === undefined);
  if (exactRoutes.length) {
    out.push('');
    out.push('# Original URLs whose doubled slashes set them apart from another page: this spelling only.');
    for (const x of exactRoutes) out.push(...route(x));
  }
  if (queryRoutes.length) {
    out.push('');
    out.push('# Original URLs with a query string. Internal rewrite: the URL stays exactly the same.');
    for (const x of queryRoutes) out.push(...route(x));
  }
  if (pathRoutes.length) {
    out.push('');
    out.push('# Original URLs stored under another file name. Internal rewrite, the URL stays the same.');
    for (const x of pathRoutes) out.push(...route(x));
  }

  out.push('');
  out.push('# Extensionless URLs: /about is served from about.html without a redirect.');
  // $1 is decoded and Apache decodes the target again, so a path with % or # (/100%25-cotton,
  // /tag/c%23) is rewritten from the still-encoded path of the request line instead.
  out.push('RewriteCond %{REQUEST_FILENAME} !-f');
  out.push('RewriteCond %{REQUEST_FILENAME}.html -f');
  out.push('RewriteCond %{THE_REQUEST} ^\\S+\\s+(/[^?\\s]*)');
  out.push('RewriteRule [%#] %1.html [L]');
  out.push('RewriteCond %{REQUEST_FILENAME} !-f');
  out.push('RewriteCond %{REQUEST_FILENAME}.html -f');
  out.push('RewriteRule ^(.+)$ $1.html [L]');
  out.push('');
  out.push('# A folder requested without its slash gets one, as the original server did.');
  out.push('RewriteCond %{REQUEST_FILENAME} -d');
  out.push('RewriteRule ^(.+[^/])$ /$1/ [R=301,L]');
  out.push('</IfModule>');
  out.push('');
  out.push('<IfModule mod_headers.c>');
  out.push('  <FilesMatch "\\.(xml|xsl)$">');
  out.push('    Header set Cache-Control "public, max-age=3600"');
  out.push('  </FilesMatch>');
  out.push('</IfModule>');
  return out.join('\n') + '\n';
}

function nginxString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function nginxConf(r: ServerRules): string {
  const id = r.domain.replace(/[^a-z0-9]/gi, '_');
  // Plain map keys go into a hash that ignores case and only has room for keys of about 46 bytes, so
  // /About.html would match the /about.html route and one long URL would stop nginx from loading.
  // Regex keys are case-sensitive and have no length limit (nginx tries them in turn, about 0.3 µs
  // each, which is fine for the few thousand rules of a restored site).
  // Values may contain variables and nginx has no escape for "$", so a literal one is written as a
  // variable that holds it (a geo value is not compiled).
  const dollar = `wbd_${id}_dollar`;
  const needsDollar = r.redirects.some((d) => d.to.includes('$')) || r.routes.some((x) => x.file.includes('$'));
  const map = (name: string, source: string, entries: Array<[string, string]>) => {
    const lines = [`map ${source} $wbd_${id}_${name} {`, '    default "";'];
    for (const [k, v] of entries) lines.push(`    ${nginxString(k)} ${nginxString(v.replace(/\$/g, () => `\${${dollar}}`))};`);
    lines.push('}');
    return lines.join('\n');
  };
  const byQuery = (x: Route | Redirect) => x.query !== undefined || ('noQuery' in x && x.noQuery === true);
  const v = (name: string) => `$wbd_${id}_${name}`;
  // $uri is the path as nginx reads it (slashes merged, escapes decoded). The query is compared as
  // Apache compares WBD_QUERY: each map below drops one run of tracking parameters and empty
  // segments from "&" + $args + "&", once per request, where a key that skipped them itself would
  // scan a long query once per rule. A rule for one spelling only compares the path as sent.
  const passes: string[] = [];
  if ([...r.redirects, ...r.routes].some(byQuery)) {
    let source = '"&$args&"';
    for (let i = 1; i <= QUERY_PASSES; i++) {
      const name = i === QUERY_PASSES ? 'args' : `args${i}`;
      passes.push(`map ${source} ${v(name)} {\n    default ${source};\n    ${nginxString('~*' + droppedRunPattern())} $1$2;\n}`);
      source = v(name);
    }
  }
  const args = passes.length ? v('args') : '';
  const QUERY = `"$uri?${args}"`;
  const pathKey = (x: Route | Redirect) => `~^${pathBytesPattern(x.rawPath)}$`;
  const queryPart = (x: Route | Redirect) => (x.query ? `&${regexEscape(x.query)}&$` : '&$');
  const queryKey = (x: Route | Redirect) => `~^${pathBytesPattern(x.rawPath)}\\?${queryPart(x)}`;
  const exactKey = (x: Route | Redirect) => `~^${rawPattern(x.rawPath)}\\?${byQuery(x) ? queryPart(x) : ''}`;
  const redirects = (perm: boolean, pick: (d: Redirect) => boolean, key: (d: Redirect) => string) =>
    r.redirects.filter((d) => isPermanent(d.status) === perm && pick(d)).map((d) => [key(d), d.to] as [string, string]);
  const routes = (pick: (x: Route) => boolean, key: (x: Route) => string) => r.routes.filter(pick).map((x) => [key(x), '/' + x.file] as [string, string]);
  const exactRedirects = r.redirects.some((d) => d.exact);
  const exactRoutes = r.routes.some((x) => x.exact);
  const EXACT = `"${v('path')}?${args}"`;

  return `# Generated by zplus.ai for ${r.domain}.
# Keeps every original URL working exactly as before. Put this file in /etc/nginx/conf.d/
# (it must be included inside the http { } block), set "root" to the folder holding the site,
# add your TLS settings, then run: nginx -t && systemctl reload nginx

${needsDollar ? `geo $${dollar} { default "$"; }\n\n` : ''}${
  passes.length
    ? `# Query strings are compared the way the URLs were archived: without tracking parameters (utm_*,
# fbclid, ...) and empty segments. Each map drops one run of them; a fixed number, so no query
# costs much.
${passes.join('\n')}

`
    : ''
}${exactRedirects || exactRoutes ? `# The path as sent, doubled slashes and all.\nmap $request_uri ${v('path')} {\n    "~^([^?]*)" $1;\n}\n\n` : ''}# Redirects the original site made. $uri is the path as nginx reads it (slashes merged, escapes
# decoded); a rule for one spelling only compares the path as sent.
${[
  ...(exactRedirects ? [map('x301', EXACT, redirects(true, (d) => !!d.exact, exactKey)), map('x302', EXACT, redirects(false, (d) => !!d.exact, exactKey))] : []),
  map('q301', QUERY, redirects(true, (d) => !d.exact && byQuery(d), queryKey)),
  map('q302', QUERY, redirects(false, (d) => !d.exact && byQuery(d), queryKey)),
  map('r301', '$uri', redirects(true, (d) => !d.exact && !byQuery(d), pathKey)),
  map('r302', '$uri', redirects(false, (d) => !d.exact && !byQuery(d), pathKey)),
].join('\n')}

# Original URLs served from another file (internal rewrite, the URL stays the same).
${[
  ...(exactRoutes ? [map('route_x', EXACT, routes((x) => !!x.exact, exactKey))] : []),
  map('route_q', QUERY, routes((x) => !x.exact && x.query !== undefined, queryKey)),
  map('route_p', '$uri', routes((x) => !x.exact && x.query === undefined, pathKey)),
].join('\n')}

server {
    listen 80;
    server_name ${r.domain} www.${r.domain};
    root /var/www/${r.domain}/site;
    index index.html index.xml;
    charset utf-8;
    error_page 404 /404.html;

    include mime.types;
    types { text/html ${HTML_LIKE_EXT.join(' ')}; }

${[...(exactRedirects ? ['x301', 'x302'] : []), 'q301', 'q302', 'r301', 'r302'].map((m) => `    if (${v(m)}) { return ${m.slice(1)} ${v(m)}; }`).join('\n')}

    location ^~ /__wbd/ {
        internal;
    }

    location / {
${[...(exactRoutes ? ['route_x'] : []), 'route_q', 'route_p'].map((m) => `        if (${v(m)}) { rewrite ^ ${v(m)} last; }`).join('\n')}
        try_files $uri $uri.html $uri/ =404;
    }
}
`;
}

// Cloudflare Pages answers every x.html and x/index.html with a 308 to /x and /x/, also after a 200
// rewrite, unless a file x sits next to x.html. It serves /x from x.html and /x/ from x/index.html
// without a redirect, and so does Netlify, so rewrites point there.
function pagesTarget(file: string): string {
  if (file === 'index.html' || file.endsWith('/index.html')) return '/' + encodeFile(file.slice(0, -'index.html'.length));
  return '/' + encodeFile(file.replace(/\.html$/, ''));
}

/** Pages reads a path with * or :name as a pattern, and keeps only 100 of those. */
const PAGES_PATTERN = /\*|:[A-Za-z]/;

type RedirectLine = [from: string, to: string, status: number];

/** Netlify and Cloudflare Pages. Neither can match an exact query string value. */
export function netlifyRedirects(r: ServerRules): string {
  const out = [`# Generated by zplus.ai for ${r.domain} (Netlify / Cloudflare Pages).`];
  // Pages reads every line after the first pattern as a pattern too, so paths that look like one
  // wait until all plain paths are written.
  const patterns: RedirectLine[] = [];
  const section = (title: string, lines: RedirectLine[]) => {
    const plain = lines.filter(([from]) => !PAGES_PATTERN.test(from));
    patterns.push(...lines.filter(([from]) => PAGES_PATTERN.test(from)));
    if (plain.length) out.push('', title, ...plain.map((x) => x.join('  ')));
  };
  // Cloudflare Pages compares a line with the path as sent (only //a.php matches "//a.php"), though
  // it merges slashes to find a file; Netlify takes no line for a path with doubled slashes. So a
  // rule gets a line for the address Apache and nginx give it plus one for its own doubled slashes,
  // and a rule for one spelling only gets just its own.
  const pathRedirects = r.redirects.filter((d) => d.query === undefined);
  const pathRoutes = r.routes.filter((x) => x.query === undefined);
  const from = (x: Route | Redirect) => (x.exact ? [x.rawPath] : [...new Set([mergeSlashes(x.rawPath), x.rawPath])]);
  const taken = new Set<string>();
  const fresh = (x: Route | Redirect) =>
    from(x).filter((f) => {
      if (taken.has(f)) return false;
      taken.add(f);
      return true;
    });
  const redirects = pathRedirects.flatMap((d) => fresh(d).map((f): RedirectLine => [f, d.to, isPermanent(d.status) ? 301 : 302]));
  const routes = pathRoutes.flatMap((x) => fresh(x).map((f): RedirectLine => [f, pagesTarget(x.file), 200]));

  // Every other .html URL, for Pages: x/index.html is rewritten to /x/ and x.html to /x, except
  // next to a file x, where Pages serves x.html as it is and /x would serve x. Netlify serves an
  // existing file before it reads a rule that is not forced, so these change nothing there. They
  // go first: Pages reads only the first 2,000 plain lines.
  const files = new Set(r.files);
  const asIs = [...files]
    .filter((f) => f.endsWith('.html') && !/(^|\/)index\.html$/.test(f) && files.has(f.slice(0, -'.html'.length)))
    .map((f): RedirectLine => ['/' + encodeFile(f), '/' + encodeFile(f), 200]);
  const home: RedirectLine = ['/index.html', '/', 200];
  section('# For Cloudflare Pages, which redirects x.html to /x and x/index.html to /x/ by itself', [home, ...asIs].filter(([f]) => !taken.has(f)));
  section('# Redirects the original site made', redirects);
  section('# Original URLs served from another file (rewrite, the URL stays the same)', routes);
  // Pages tries patterns in file order and reads only 100: the two below go after the .html ones
  // they would hide and before the rest.
  const html = patterns.filter(([f]) => f.endsWith('.html'));
  if (html.length) out.push('', '# Paths that Cloudflare Pages reads as patterns (* or :name)', ...html.map((x) => x.join('  ')));
  out.push('', '# Every other .html and /index.html URL, for Cloudflare Pages', '/*/index.html  /:splat/  200', '/*.html  /:splat  200');
  const rest = patterns.filter(([f]) => !f.endsWith('.html'));
  if (rest.length) out.push('', '# Paths that Cloudflare Pages reads as patterns (* or :name)', ...rest.map((x) => x.join('  ')));

  const others = [...r.redirects, ...r.routes].filter((x) => x.query !== undefined);
  if (others.length) {
    out.push('', `# ${others.length} URLs with a query string need Apache, LiteSpeed or nginx (see .htaccess):`);
    for (const x of others.slice(0, 50)) out.push(`#   ${x.rawPath}?${x.query}`);
    if (others.length > 50) out.push(`#   ... and ${others.length - 50} more`);
  }
  return out.join('\n') + '\n';
}

export function netlifyHeaders(r: ServerRules): string {
  // No noindex header on /__wbd/*: Netlify matches _headers after a rewrite, so it would land on
  // the original URLs served from there. robots.txt already keeps crawlers out of /__wbd/.
  const out = [`# Generated by zplus.ai for ${r.domain} (Netlify / Cloudflare Pages).`];
  for (const t of r.types) out.push(`/${encodeURI(t.file)}`, `  Content-Type: ${t.contentType}`);
  return out.join('\n') + '\n';
}

/**
 * How many rules of _redirects and _headers Cloudflare Pages leaves out: it reads 2,000 plain
 * redirect lines (every line after the first pattern counts as a pattern), 100 patterns and 100
 * header rules.
 */
export function pagesOverflow(redirects: string, headers: string): number {
  let plain = 0;
  let pattern = 0;
  for (const line of redirects.split('\n')) {
    const f = line.trim().split(/\s+/)[0];
    if (!f || f.startsWith('#')) continue;
    if (pattern === 0 && !PAGES_PATTERN.test(f)) plain++;
    else pattern++;
  }
  const rules = headers.split('\n').filter((l) => l.startsWith('/')).length;
  return Math.max(0, plain - 2000) + Math.max(0, pattern - 100) + Math.max(0, rules - 100);
}
