// Netlify and Cloudflare Pages read the same _redirects. Pages also answers every x.html and
// x/index.html with a 308 to /x and /x/ (cloudflare/workers-sdk, packages/pages-shared/asset-server/
// handler.ts), so the file has to keep those URLs at their address there without changing what
// Netlify does. Pages' rules engine and asset server are ported below; when wrangler is installed, the
// same site is also served with `wrangler pages dev`.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { netlifyHeaders, netlifyRedirects, type Route, type ServerRules } from '../src/engine/serverconfig.ts';

/**
 * Cloudflare Pages: how it reads _redirects (workers-shared/utils/configuration/parseRedirects.ts and
 * asset-worker/src/utils/rules-engine.ts) and answers a request (pages-shared/asset-server/handler.ts,
 * generateResponse). Returns [status, served file or Location].
 */
function pages(redirects: string, assets: Set<string>): (url: string) => [number, string] {
  const statics = new Map<string, [to: string, status: number]>();
  const patterns: Array<[RegExp, string, number]> = [];
  let staticOk = true;
  for (const line of redirects.split('\n').map((l) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    const [from, to, status = '302'] = line.split(/\s+/);
    // Once a line is a pattern, every later line is one too, and only 100 are read.
    if (staticOk && !/\*|:[A-Za-z]/.test(from)) {
      if (!statics.has(from)) statics.set(from, [to, Number(status)]);
      continue;
    }
    staticOk = false;
    if (patterns.length === 100) break;
    const re = from
      .split('*')
      .map((s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
      .join('(?<splat>.*)')
      .replace(/:([A-Za-z]\w*)/g, '(?<$1>[^/]+)');
    patterns.push([new RegExp(`^${re}$`), to, Number(status)]);
  }
  const has = (p: string) => assets.has(p);
  return (url) => {
    let pathname = new URL(url, 'https://example.com').pathname;
    let match = statics.get(pathname);
    for (const [re, to, status] of match ? [] : patterns) {
      const m = re.exec(pathname);
      if (!m) continue;
      match = [Object.entries(m.groups ?? {}).reduce((t, [k, v]) => t.replaceAll(`:${k}`, v), to), status];
      break;
    }
    if (match && match[1] !== 200) return [match[1], match[0]];
    // A 200 only swaps the path; the HTML handling below still applies to it.
    if (match) pathname = new URL(match[0], 'https://example.com').pathname;
    pathname = decodeURIComponent(pathname);
    if (pathname.endsWith('/')) {
      if (has(`${pathname}index.html`)) return [200, `${pathname}index.html`];
      if (pathname.endsWith('/index/')) return [308, pathname.slice(0, -'index/'.length)];
      if (has(pathname.slice(0, -1) + '.html')) return [308, pathname.slice(0, -1)];
      return [404, '/404.html'];
    }
    if (has(pathname)) {
      if (!pathname.endsWith('.html')) return [200, pathname];
      const bare = pathname.slice(0, -'.html'.length);
      if (bare.endsWith('/index')) return [308, bare.slice(0, -'index'.length)];
      return has(bare) || bare === '/' ? [200, pathname] : [308, bare];
    }
    if (pathname.endsWith('/index')) return [308, pathname.slice(0, -'index'.length)];
    if (has(`${pathname}.html`)) return [200, `${pathname}.html`];
    if (has(`${pathname}/index.html`)) return [308, `${pathname}/`];
    return [404, '/404.html'];
  };
}

/** Site files and the MARK each one holds. */
const files: Record<string, string> = {
  'index.html': 'home',
  'menu.html': 'menu',
  'blog/index.html': 'blog',
  'blog/2020/rye-bread.html': 'rye',
  'author/maria/index.html': 'maria',
  'x.html': 'x',
  'docs/index.html': 'docs',
  'gallery/IMG_1.jpg': 'image',
  'gallery/IMG_1.jpg.html': 'slide-1',
  'gallery/IMG_2.jpg.html': 'slide-2',
  'café.html': 'cafe',
  '404.html': 'not-found',
  '__wbd/f/x.html': 'x.html-route',
  '__wbd/f/docs.html': 'docs-index-route',
  '__wbd/f/dl.pdf': 'pdf',
  '__wbd/f/talk.html': 'talk',
  '__wbd/f/talk2.html': 'talk.html',
};
const routes: Route[] = [
  // Read by Pages as a pattern: the plain paths after it must stay plain.
  { path: '/wiki/Talk:Main', rawPath: '/wiki/Talk:Main', file: '__wbd/f/talk.html' },
  { path: '/wiki/Talk:Main.html', rawPath: '/wiki/Talk:Main.html', file: '__wbd/f/talk2.html' },
  // Another page than /x (x.html) and /docs/ (docs/index.html).
  { path: '/x.html', rawPath: '/x.html', file: '__wbd/f/x.html' },
  { path: '/docs/index.html', rawPath: '/docs/index.html', file: '__wbd/f/docs.html' },
  { path: '/download', rawPath: '/download', file: '__wbd/f/dl.pdf' },
  { path: '/index.php', rawPath: '/index.php', query: 'page=contact', file: '__wbd/q/c.html' },
];
const site: ServerRules = {
  domain: 'example.com',
  host: 'example.com',
  routes,
  redirects: [{ path: '/old-page.html', rawPath: '/old-page.html', to: '/menu.html', status: 301 }],
  types: [],
  files: Object.keys(files).filter((f) => !f.startsWith('__wbd/')),
};
const assets = new Set(Object.keys(files).map((f) => '/' + f));

/** [request, status, MARK of the page or the redirect target] */
const expected: Array<[string, number, string]> = [
  ['/', 200, 'home'],
  ['/index.html', 200, 'home'],
  ['/menu.html', 200, 'menu'],
  ['/blog/', 200, 'blog'],
  ['/blog/index.html', 200, 'blog'],
  ['/blog/2020/rye-bread', 200, 'rye'],
  ['/author/maria/index.html', 200, 'maria'],
  ['/x', 200, 'x'],
  ['/x.html', 200, 'x.html-route'],
  ['/docs/', 200, 'docs'],
  ['/docs/index.html', 200, 'docs-index-route'],
  ['/gallery/IMG_1.jpg', 200, 'image'],
  ['/gallery/IMG_1.jpg.html', 200, 'slide-1'],
  ['/gallery/IMG_2.jpg.html', 200, 'slide-2'],
  ['/caf%C3%A9.html', 200, 'cafe'],
  ['/download', 200, 'pdf'],
  ['/wiki/Talk:Main', 200, 'talk'],
  ['/wiki/Talk:Main.html', 200, 'talk.html'],
  ['/old-page.html', 301, '/menu.html'],
  ['/nope.html', 404, 'not-found'],
];
const mark = ([status, got]: [number, string]): [number, string] => [status, status >= 300 && status < 400 ? got : files[got.slice(1)]];

describe('_redirects on Cloudflare Pages', () => {
  it('is needed: Pages redirects .html and /index.html URLs by itself', () => {
    const bare = pages('', assets);
    assert.deepEqual(bare('/menu.html'), [308, '/menu']);
    assert.deepEqual(bare('/blog/index.html'), [308, '/blog/']);
    assert.deepEqual(bare('/index.html'), [308, '/']);
    // Also after a rewrite to a stored .html file.
    assert.deepEqual(pages('/x.html  /__wbd/f/x.html  200', assets)('/x.html'), [308, '/__wbd/f/x']);
  });

  it('keeps every original URL at its own address', () => {
    const serve = pages(netlifyRedirects(site), assets);
    for (const [url, status, want] of expected) assert.deepEqual(mark(serve(url)), [status, want], url);
  });

  it('works without the file list, except for x.html next to a file x', () => {
    const serve = pages(netlifyRedirects({ ...site, files: undefined }), assets);
    for (const [url, status, want] of expected) {
      if (url !== '/gallery/IMG_1.jpg.html') assert.deepEqual(mark(serve(url)), [status, want], url);
    }
  });

  it('keeps plain paths plain and reads the .html rules, whatever patterns the site has', () => {
    const many: Route[] = Array.from({ length: 150 }, (_, i) => ({ path: `/wiki/Page:${i}`, rawPath: `/wiki/Page:${i}`, file: `__wbd/f/p${i}.html` }));
    const serve = pages(netlifyRedirects({ ...site, routes: [...many, ...routes] }), assets);
    for (const [url, status, want] of expected) assert.deepEqual(mark(serve(url)), [status, want], url);
  });

  it('leaves out the /index.html rule when that URL has its own', () => {
    const text = netlifyRedirects({ ...site, redirects: [{ path: '/index.html', rawPath: '/index.html', to: '/', status: 301 }] });
    assert.deepEqual(
      text.split('\n').filter((l) => l.startsWith('/index.html ')),
      ['/index.html  /  301'],
    );
  });
});

describe('_redirects on Netlify', () => {
  const lines = netlifyRedirects(site)
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/));

  it('adds only rewrites that Netlify skips for an existing file', () => {
    // Netlify serves an existing file before a rule that is not forced ("!"), so the lines for
    // Pages change nothing for the site's own files.
    for (const [from, to, status] of lines) {
      if (from === '/old-page.html') assert.deepEqual([to, status], ['/menu.html', '301']);
      else assert.equal(status, '200', from);
    }
    assert.ok(lines.every((l) => l.length === 3 && !l[2].includes('!')));
  });

  it('points rewrites at the stored file, which Netlify also serves without .html', () => {
    const targets = Object.fromEntries(lines.map(([from, to]) => [from, to]));
    assert.equal(targets['/x.html'], '/__wbd/f/x');
    assert.equal(targets['/docs/index.html'], '/__wbd/f/docs');
    assert.equal(targets['/download'], '/__wbd/f/dl.pdf');
  });

  it('names both hosts in _headers', () => {
    assert.match(netlifyHeaders(site), /^# Generated by Wayback Downloader for example\.com \(Netlify \/ Cloudflare Pages\)\.\n/);
  });
});

// Real Cloudflare Pages emulator, when installed.
const probe = spawnSync('wrangler', ['--version'], { encoding: 'utf8' });
const noWrangler = probe.error || probe.status !== 0 ? 'wrangler is not installed' : false;

describe('generated _redirects on wrangler pages dev', { skip: noWrangler }, () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'wbd-pages-'));
  let wrangler: ReturnType<typeof spawn> | undefined;
  let base = '';

  before(async () => {
    const root = path.join(work, 'site');
    for (const [file, m] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), `<!doctype html><title>${m}</title><p>MARK[${m}]</p>\n`);
    }
    writeFileSync(path.join(root, '_redirects'), netlifyRedirects(site));
    writeFileSync(path.join(root, '_headers'), netlifyHeaders(site));
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    wrangler = spawn('wrangler', ['pages', 'dev', root, '--ip', '127.0.0.1', '--port', String(port)], {
      cwd: work,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: 'ignore',
    });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 600; i++) {
      const up = await fetch(base + '/').then(
        (r) => r.ok,
        () => false,
      );
      if (up) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('wrangler pages dev did not start');
  });

  after(() => {
    wrangler?.kill();
    rmSync(work, { recursive: true, force: true });
  });

  it('serves every original URL at its own address', async () => {
    for (const [url, status, want] of expected) {
      const res = await fetch(base + url, { redirect: 'manual' });
      const body = await res.text();
      const got = res.status >= 300 && res.status < 400 ? res.headers.get('location')!.replace(base, '') : /MARK\[([^\]]+)\]/.exec(body)?.[1];
      assert.deepEqual([res.status, got], [status, want], url);
    }
  });
});
