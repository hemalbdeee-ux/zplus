// Local preview of a restored site. It follows the same rules as the generated .htaccess and
// nginx.conf (original redirects, query-string URLs, extensionless URLs), so what works here works
// on the real host.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Redirect, Route } from './serverconfig.ts';
import { HTML_LIKE_EXT } from './serverconfig.ts';
import { cleanSearch, decodePath } from './url.ts';

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

export async function createPreviewServer(siteDir: string): Promise<http.Server> {
  const root = path.resolve(siteDir);
  const rulesFile = path.join(root, '__wbd', 'routes.json');
  const rules: RoutesFile = existsSync(rulesFile) ? JSON.parse(await readFile(rulesFile, 'utf8')) : { routes: [], redirects: [] };
  const queryRoutes = new Map(rules.routes.filter((r) => r.query !== undefined).map((r) => [`${r.rawPath}?${r.query}`, r.file]));
  const pathRoutes = new Map(rules.routes.filter((r) => r.query === undefined).map((r) => [r.path, r.file]));
  const queryRedirects = new Map(rules.redirects.filter((r) => r.query !== undefined).map((r) => [`${r.rawPath}?${r.query}`, r]));
  const pathRedirects = new Map(rules.redirects.filter((r) => r.query === undefined).map((r) => [r.path, r]));

  const isFile = (rel: string) => {
    const abs = path.resolve(root, '.' + rel);
    return abs.startsWith(root) && existsSync(abs) && statSync(abs).isFile() ? abs : null;
  };
  const isDir = (rel: string) => {
    const abs = path.resolve(root, '.' + rel);
    return abs.startsWith(root) && existsSync(abs) && statSync(abs).isDirectory();
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://preview.local');
    const rawPath = url.pathname;
    const query = cleanSearch(url.search).slice(1);
    const decoded = decodePath(rawPath);

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

    if (decoded.startsWith('/__wbd/')) return notFound();

    const qr = query ? queryRedirects.get(`${rawPath}?${query}`) : undefined;
    if (qr) return redirect(qr.status === 301 || qr.status === 308 ? 301 : 302, qr.to);
    const pr = pathRedirects.get(decoded);
    if (pr && (!pr.noQuery || !query)) return redirect(pr.status === 301 || pr.status === 308 ? 301 : 302, pr.to);

    const routed = (query && queryRoutes.get(`${rawPath}?${query}`)) || pathRoutes.get(decoded);
    if (routed) {
      const abs = isFile('/' + routed);
      return abs ? send(abs) : notFound();
    }

    const direct = !decoded.endsWith('/') && isFile(decoded);
    if (direct) return send(direct);
    const withHtml = !decoded.endsWith('/') && isFile(decoded + '.html');
    if (withHtml) return send(withHtml);
    if (isDir(decoded)) {
      if (!decoded.endsWith('/')) return redirect(301, rawPath + '/' + (url.search || ''));
      const index = isFile(decoded + 'index.html') ?? isFile(decoded + 'index.xml');
      if (index) return send(index);
    }
    return notFound();
  });
}
