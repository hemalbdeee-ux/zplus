// Local preview of a restored site. It follows the same rules as the generated .htaccess and
// nginx.conf (original redirects, query-string URLs, extensionless URLs), so what works here works
// on the real host.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Redirect, Route } from './serverconfig.ts';
import { HTML_LIKE_EXT, redirectTarget } from './serverconfig.ts';
import { decodePath, hasNonUtf8Escapes, mergeSlashes, rawPathKey, ruleQuery, serverPath } from './url.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.xsl': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  ...Object.fromEntries(HTML_LIKE_EXT.map((e) => ['.' + e, 'text/html; charset=utf-8'])),
};

interface RoutesFile {
  routes: Route[];
  redirects: Redirect[];
}

/**
 * Rules keyed the way the generated .htaccess and nginx.conf compare them: by the address the server
 * reads (slashes merged, escapes decoded to bytes) or, for an exact rule, by the raw path, plus
 * "?" and the query without tracking parameters for a rule that looks at the query. The first rule
 * for a key wins, as in Apache.
 */
function ruleMap<T extends Route | Redirect>(list: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const x of list) {
    const p = x.exact ? 'raw:' + rawPathKey(x.rawPath) : 'path:' + serverPath(x.rawPath);
    const key = x.query !== undefined ? `${p}?${x.query}` : 'noQuery' in x && x.noQuery ? `${p}?` : p;
    if (!map.has(key)) map.set(key, x);
  }
  return map;
}

export async function createPreviewServer(siteDir: string): Promise<http.Server> {
  const root = path.resolve(siteDir);
  const rulesFile = path.join(root, '__wbd', 'routes.json');
  const rules: RoutesFile = existsSync(rulesFile) ? JSON.parse(await readFile(rulesFile, 'utf8')) : { routes: [], redirects: [] };
  const redirects = ruleMap(rules.redirects);
  const routes = ruleMap(rules.routes);

  const isFile = (rel: string) => {
    const abs = path.resolve(root, '.' + rel);
    return abs.startsWith(root) && existsSync(abs) && statSync(abs).isFile() ? abs : null;
  };
  const isDir = (rel: string) => {
    const abs = path.resolve(root, '.' + rel);
    return abs.startsWith(root) && existsSync(abs) && statSync(abs).isDirectory();
  };

  return http.createServer((req, res) => {
    const send = (abs: string, status = 200) => {
      res.writeHead(status, { 'content-type': TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' });
      createReadStream(abs).pipe(res);
    };
    const redirect = (status: number, to: string) => {
      res.writeHead(status, { location: to });
      res.end();
    };
    const notFound = () => {
      const page = isFile('/404.html');
      if (page) send(page, 404);
      else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
      }
    };

    // Joined, not resolved: "//x" is a path here, as for Apache and nginx, not a host.
    const target = req.url ?? '/';
    const url = URL.parse(target.startsWith('/') ? 'http://preview.local' + target : target);
    if (!url) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('Bad request');
    }
    const rawPath = url.pathname;
    const merged = mergeSlashes(rawPath);
    // undefined: too many runs of tracking parameters and empty segments for the server rules.
    const query = ruleQuery(url.search);
    // Exact rules first, then those that look at the query, then path-only ones (nginx.conf order).
    const find = <T>(map: Map<string, T>) => {
      for (const p of ['raw:' + rawPathKey(rawPath), 'path:' + serverPath(rawPath)]) {
        const hit = (query !== undefined ? map.get(`${p}?${query}`) : undefined) ?? map.get(p);
        if (hit) return hit;
      }
      return undefined;
    };

    const decoded = decodePath(merged);
    if (decoded.startsWith('/__wbd/')) return notFound();

    const moved = find(redirects);
    // The query as sent, as Apache and nginx pass it on.
    if (moved) return redirect(moved.status === 301 || moved.status === 308 ? 301 : 302, redirectTarget(moved, target.includes('?') ? target.slice(target.indexOf('?')) : ''));
    const routed = find(routes);
    if (routed) {
      const abs = isFile('/' + routed.file);
      return abs ? send(abs) : notFound();
    }

    // No file is named with bytes that are not UTF-8 ("/caf%E9.html"): those URLs are routes.
    if (hasNonUtf8Escapes(merged)) return notFound();
    const direct = !decoded.endsWith('/') && isFile(decoded);
    if (direct) return send(direct);
    const withHtml = !decoded.endsWith('/') && isFile(decoded + '.html');
    if (withHtml) return send(withHtml);
    if (isDir(decoded)) {
      if (!decoded.endsWith('/')) return redirect(301, merged + '/' + (url.search || ''));
      const index = isFile(decoded + 'index.html') ?? isFile(decoded + 'index.xml');
      if (index) return send(index);
    }
    return notFound();
  });
}
