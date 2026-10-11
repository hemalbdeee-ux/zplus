// Every archived spelling of an address answers as the address does on every host the restored site
// ships rules for (finding 48, third round). Apache, nginx and the preview merge doubled slashes and
// decode escapes by themselves, so //old.php is /old.php there. Cloudflare Pages compares a
// _redirects line with the path as sent, and its own .html rules read "//p" as a host: a spelling
// that answers like its address (same redirect, same bytes) needs a line of its own there.
// The Pages answer is worked out with a port of its request handler that, unlike `wrangler pages
// dev`, does not merge slashes to find a file; when wrangler is installed (or WRANGLER names it), the
// site is also served with `wrangler pages dev`. nginx and Apache run when installed (APACHE2_ROOT
// as in urls-servers.test.ts).
// Also: a redirect that does not look at the query string passes it on, as Apache, Netlify and
// Pages do by themselves, on nginx and the preview too (/st.php?a=1 to /?a=1).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildSite, type BuildResult } from '../src/engine/build.ts';
import type { Manifest, Resource } from '../src/engine/crawl.ts';
import { createPreviewServer } from '../src/engine/serve.ts';
import { htaccess, netlifyHeaders, netlifyRedirects, nginxConf, type ServerRules } from '../src/engine/serverconfig.ts';
import { pathAndQuery, urlKey } from '../src/engine/url.ts';

const H = 'http://example.com';
const page = (mark: string) => `<!doctype html><html><head><title>${mark} | Example</title></head><body><p>MARK[${mark}]</p></body></html>`;

interface Capture {
  url: string;
  type?: string;
  body?: string;
  status?: number;
  location?: string;
}

const captures: Capture[] = [
  { url: `${H}/`, body: page('home') },
  // Redirect spellings with the same target as their address (the round-3 checker's site).
  { url: `${H}/old.php`, status: 301, location: `${H}/` },
  { url: `${H}//old.php`, status: 301, location: `${H}/` },
  { url: `${H}//x.php`, status: 301, location: `${H}/` },
  { url: `${H}///x.php`, status: 301, location: `${H}/` },
  { url: `${H}/blog/a.php`, status: 302, location: `${H}/` },
  { url: `${H}/blog//a.php`, status: 302, location: `${H}/` },
  { url: `${H}/same.php`, status: 301, location: `${H}/` },
  { url: `${H}//same.php`, status: 301, location: `${H}/` },
  // A path-only redirect that must not fire with a query string, and its twin.
  { url: `${H}/st2.php`, status: 301, location: `${H}/` },
  { url: `${H}//st2.php`, status: 301, location: `${H}/` },
  { url: `${H}/st2.php?x=1`, body: page('st2x') },
  // Same bytes as their address, served from a rewrite (extensionless image, feed).
  { url: `${H}/photo`, type: 'image/png', body: 'PNG MARK[photo]' },
  { url: `${H}//photo`, type: 'image/png', body: 'PNG MARK[photo]' },
  { url: `${H}/feed`, type: 'application/rss+xml', body: '<?xml version="1.0"?><rss><!--MARK[feed]--></rss>' },
  { url: `${H}//feed`, type: 'application/rss+xml', body: '<?xml version="1.0"?><rss><!--MARK[feed]--></rss>' },
  // Same bytes as their address, served from a plain file.
  { url: `${H}/p.html`, body: page('p') },
  { url: `${H}//p.html`, body: page('p') },
  { url: `${H}/img/c.png`, type: 'image/png', body: 'PNG MARK[c]' },
  { url: `${H}//img/c.png`, type: 'image/png', body: 'PNG MARK[c]' },
  { url: `${H}/blog/b.html`, body: page('b') },
  { url: `${H}/blog//b.html`, body: page('b') },
  { url: `${H}/team`, body: page('team') },
  { url: `${H}//team`, body: page('team') },
  { url: `${H}/about.php`, body: page('about') },
  { url: `${H}//about.php`, body: page('about') },
  // Only the doubled spelling was archived.
  { url: `${H}//solo.html`, body: page('solo') },
  { url: `${H}//solo2`, body: page('solo2') },
  { url: `${H}//img/d.png`, type: 'image/png', body: 'PNG MARK[d]' },
  // index.html spellings.
  { url: `${H}//index.html`, body: page('home') },
  { url: `${H}/dir2/`, body: page('dir2') },
  { url: `${H}//dir2/`, body: page('dir2') },
  { url: `${H}//dir2/index.html`, body: page('dir2') },
  // x.html next to a file x: Pages serves x.html as it is.
  { url: `${H}/g/i.jpg`, type: 'image/jpeg', body: 'JPEG MARK[jpg]' },
  { url: `${H}/g/i.jpg.html`, body: page('slide') },
  { url: `${H}//g/i.jpg.html`, body: page('slide') },
  // A Latin-1 address in other spellings: doubled slash, other escape case.
  { url: `${H}/caf%E9.html`, body: page('cafe') },
  { url: `${H}//caf%e9.html`, body: page('cafe') },
  { url: `${H}/caf%e9.html`, body: page('cafe') },
  // A redirect to its own address in another escape case: the page answers there.
  { url: `${H}/cr%E8me.php`, body: page('creme') },
  { url: `${H}/cr%e8me.php`, status: 301, location: `${H}/cr%E8me.php` },
  // Spellings that answer differently keep a rule for themselves (already working).
  { url: `${H}/a.png`, type: 'image/png', body: 'PNG MARK[a1]' },
  { url: `${H}//a.png`, type: 'image/png', body: 'PNG MARK[a2]' },
  { url: `${H}/st.php`, status: 301, location: `${H}/` },
  { url: `${H}//st.php`, status: 302, location: `${H}/` },
  { url: `${H}/pg.php`, body: page('pg') },
  { url: `${H}//pg.php`, status: 301, location: `${H}/pg.php` },
  // Redirects that look at the query string, or whose target has one.
  { url: `${H}/qq.php?id=7`, status: 301, location: `${H}/` },
  { url: `${H}/go.php`, status: 302, location: `${H}/p.html?x=1` },
];

/** [request exactly as sent, "status MARK" or "status Location"] */
const expected: Array<[string, string]> = [
  ['/', '200 home'],
  ['/old.php', '301 /'],
  ['//old.php', '301 /'],
  ['/x.php', '301 /'],
  ['//x.php', '301 /'],
  ['///x.php', '301 /'],
  ['/blog/a.php', '302 /'],
  ['/blog//a.php', '302 /'],
  ['/same.php', '301 /'],
  ['//same.php', '301 /'],
  ['/st2.php', '301 /'],
  ['//st2.php', '301 /'],
  ['/st2.php?x=1', '200 st2x'],
  ['/photo', '200 photo'],
  ['//photo', '200 photo'],
  ['/feed', '200 feed'],
  ['//feed', '200 feed'],
  ['/p.html', '200 p'],
  ['//p.html', '200 p'],
  ['/img/c.png', '200 c'],
  ['//img/c.png', '200 c'],
  ['/blog/b.html', '200 b'],
  ['/blog//b.html', '200 b'],
  ['/team', '200 team'],
  ['//team', '200 team'],
  ['/about.php', '200 about'],
  ['//about.php', '200 about'],
  ['//solo.html', '200 solo'],
  ['/solo.html', '200 solo'],
  ['//solo2', '200 solo2'],
  ['/solo2', '200 solo2'],
  ['//img/d.png', '200 d'],
  ['/img/d.png', '200 d'],
  ['//index.html', '200 home'],
  ['/dir2/', '200 dir2'],
  ['//dir2/', '200 dir2'],
  ['//dir2/index.html', '200 dir2'],
  ['/g/i.jpg', '200 jpg'],
  ['/g/i.jpg.html', '200 slide'],
  ['//g/i.jpg.html', '200 slide'],
  ['/caf%E9.html', '200 cafe'],
  ['//caf%e9.html', '200 cafe'],
  ['/caf%e9.html', '200 cafe'],
  ['/cr%E8me.php', '200 creme'],
  ['/cr%e8me.php', '200 creme'],
  ['/a.png', '200 a1'],
  ['//a.png', '200 a2'],
  ['/st.php', '301 /'],
  ['//st.php', '302 /'],
  ['/pg.php', '200 pg'],
  ['//pg.php', '301 /pg.php'],
  // The query string goes on with a redirect that does not look at it.
  ['/st.php?a=1', '301 /?a=1'],
  ['//st.php?a=1', '302 /?a=1'],
  ['//same.php?a=1&fbclid=x', '301 /?a=1&fbclid=x'],
  ['///x.php?a=1', '301 /?a=1'],
  ['//pg.php?a=1', '301 /pg.php?a=1'],
  ['/st2.php?fbclid=1', '301 /'],
  ['/qq.php?id=7&utm_source=a', '301 /'],
  ['/go.php?a=1', '302 /p.html?x=1'],
];

async function build(list: Capture[], work: string): Promise<BuildResult> {
  mkdirSync(path.join(work, 'raw'), { recursive: true });
  const resources: Resource[] = [];
  for (const c of list) {
    const u = new URL(c.url);
    const body = Buffer.from(c.body ?? '');
    const sha1 = createHash('sha1').update(body).digest('hex');
    const status = c.status ?? 200;
    if (status === 200) writeFileSync(path.join(work, 'raw', sha1), body);
    resources.push({
      key: urlKey(u),
      url: c.url,
      path: pathAndQuery(u),
      timestamp: '20200101000000',
      status,
      contentType: c.type ?? 'text/html',
      ...(status === 200 ? { file: sha1, sha1 } : { location: c.location }),
      via: 'link',
    });
  }
  const manifest: Manifest = { version: 1, domain: 'example.com', target: '20200101000000', window: {}, indexSize: resources.length, truncated: false, resources, missing: [] };
  return buildSite(manifest, { domain: 'example.com', siteUrl: 'https://example.com', workDir: work, outDir: path.join(work, 'site'), serverDir: path.join(work, 'server'), stripTracking: false });
}

/**
 * Cloudflare Pages answering a request (workers-shared parseRedirects, pages-shared asset-server
 * generateHandler): a _redirects line matches the path as sent, a 200 swaps the path for its
 * target resolved as a URL (so "//p" names a host), and files are found by their exact path.
 * Returns [status, file served or Location].
 */
function pages(siteDir: string): (target: string) => [number, string] {
  const statics = new Map<string, [to: string, status: number]>();
  const patterns: Array<[RegExp, string, number]> = [];
  let staticOk = true;
  for (const raw of readFileSync(path.join(siteDir, '_redirects'), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [token, to, status = '302'] = line.replace(/\s+#.*$/, '').split(/\s+/);
    const from = new URL('//' + token, 'relative://').pathname;
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
  const has = (p: string) => !p.includes('//') && existsSync(path.join(siteDir, p)) && statSync(path.join(siteDir, p)).isFile();
  const redirectTo = (p: string): [number, string] => [308, p.split('/').map(encodeURIComponent).join('/')];
  return (target) => {
    const url = new URL('https://example.com' + target);
    let pathname = url.pathname;
    let match = statics.get(pathname);
    for (const [re, to, status] of match ? [] : patterns) {
      const m = re.exec(pathname);
      if (!m) continue;
      match = [Object.entries(m.groups ?? {}).reduce((t, [k, v]) => t.replaceAll(`:${k}`, v), to), status];
      break;
    }
    if (match && match[1] !== 200) return [match[1], match[0]];
    if (match) {
      try {
        pathname = new URL(match[0], url).pathname;
      } catch {
        return [502, 'Invalid URL'];
      }
    }
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Latin-1 escapes stay as they are.
    }
    if (pathname.endsWith('/')) {
      if (has(`${pathname}index.html`)) return [200, `${pathname}index.html`];
      if (pathname.endsWith('/index/')) return redirectTo(`/${pathname.slice(1, -'index/'.length)}`);
      if (has(pathname.replace(/\/$/, '.html'))) return redirectTo(`/${pathname.slice(1, -1)}`);
      return [404, '/404.html'];
    }
    if (has(pathname)) {
      if (!pathname.endsWith('.html')) return [200, pathname];
      const bare = pathname.slice(0, -'.html'.length);
      if (bare.endsWith('/index')) return redirectTo(bare.replace(/\/index$/, '/'));
      return has(bare) || bare === '/' ? [200, pathname] : redirectTo(bare);
    }
    if (pathname.endsWith('/index')) return redirectTo(`/${pathname.slice(1, -'index'.length)}`);
    if (has(`${pathname}.html`)) return [200, `${pathname}.html`];
    if (has(`${pathname}/index.html`)) return redirectTo(`${pathname}/`);
    return [404, '/404.html'];
  };
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

/** "status MARK" for a page or file, "status Location" for a redirect; the path is sent as is. */
const probe = (port: number, p: string) =>
  new Promise<string>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: 'example.com' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const s = res.statusCode!;
        if (s >= 300 && s < 400) resolve(`${s} ${String(res.headers.location).replace(/^https?:\/\/[^/]+/, '')}`);
        else resolve(`${s} ${/MARK\[([^\]]+)\]/.exec(Buffer.concat(chunks).toString('latin1'))?.[1] ?? '-'}`);
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`no answer for ${p}`)));
    req.end();
  });

async function waitFor(port: number) {
  for (let i = 0; i < 200; i++) {
    if (await probe(port, '/').then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`nothing answers on port ${port}`);
}

const work = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls3-'));
const siteDir = path.join(work, 'site');
const serverDir = path.join(work, 'server');
let result: BuildResult;
const stops: Array<() => void> = [];

before(async () => {
  result = await build(captures, work);
  // Apache drops root rights to read the site.
  const open = (p: string) => {
    chmodSync(p, statSync(p).isDirectory() ? 0o755 : 0o644);
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) open(path.join(p, f));
  };
  open(work);
});

after(async () => {
  for (const stop of stops) stop();
  await rm(work, { recursive: true, force: true });
});

const check = async (port: number) => {
  const wrong: string[] = [];
  for (const [url, want] of expected) {
    const got = await probe(port, url);
    if (got !== want) wrong.push(`${url}: ${got}, expected ${want}`);
  }
  assert.deepEqual(wrong, []);
};

describe('archived spellings of an address on Cloudflare Pages', () => {
  it('answer as the address does, each from a line of its own', () => {
    const answer = pages(siteDir);
    const wrong: string[] = [];
    // Pages cannot match a query string; the rules say so in a comment.
    for (const [url, want] of expected.filter(([u]) => !u.includes('?'))) {
      const [status, where] = answer(url);
      const got = status === 200 ? `200 ${/MARK\[([^\]]+)\]/.exec(readFileSync(path.join(siteDir, where), 'latin1'))?.[1] ?? '-'}` : status >= 300 && status < 400 ? `${status} ${where}` : `${status} -`;
      if (got !== want) wrong.push(`${url}: ${got}, expected ${want}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('get the lines the checker asked for', async () => {
    const lines = (await readFile(path.join(siteDir, '_redirects'), 'utf8')).split('\n');
    for (const want of [
      /^\/\/old\.php {2}\/ {2}301$/,
      /^\/\/\/x\.php {2}\/ {2}301$/,
      /^\/blog\/\/a\.php {2}\/ {2}302$/,
      /^\/\/same\.php {2}\/ {2}301$/,
      /^\/\/photo {2}\/__wbd\/f\/\w+\.png {2}200$/,
      /^\/\/feed {2}\/__wbd\/f\/\w+\.xml {2}200$/,
      /^\/\/p\.html {2}\/p {2}200$/,
      /^\/\/g\/i\.jpg\.html {2}\/g\/i\.jpg\.html {2}200$/,
      /^\/\/dir2\/index\.html {2}\/dir2\/ {2}200$/,
      /^\/caf%e9\.html {2}\/__wbd\/f\/\w+ {2}200$/,
    ]) {
      assert.ok(lines.some((l) => want.test(l)), String(want));
    }
  });

  it('send another spelling of a .php page as HTML', async () => {
    const text = await readFile(path.join(siteDir, '_headers'), 'utf8');
    assert.match(text, /^\/about\.php\n {2}Content-Type: text\/html; charset=utf-8$/m);
    assert.match(text, /^\/\/about\.php\n {2}Content-Type: text\/html; charset=utf-8$/m);
  });

  it('are recorded with the rule of their address', () => {
    assert.deepEqual(result.routes.find((x) => x.rawPath === '/photo')?.aliases, ['//photo']);
    assert.deepEqual(result.routes.find((x) => x.rawPath === '/caf%E9.html')?.aliases, ['/caf%e9.html', '//caf%e9.html']);
    assert.deepEqual(result.redirects.find((d) => d.rawPath === '//x.php')?.aliases, ['///x.php']);
    assert.deepEqual(result.redirects.find((d) => d.rawPath === '/old.php')?.aliases, ['//old.php']);
    // A spelling that answers differently is a rule of its own.
    assert.equal(result.redirects.find((d) => d.rawPath === '//st.php')?.exact, true);
    assert.equal(result.routes.find((x) => x.rawPath === '//a.png')?.exact, true);
  });
});

describe('the rules of the other hosts', () => {
  it('do not change with the spellings Pages needs', () => {
    const site: ServerRules = { domain: 'example.com', host: 'example.com', routes: result.routes, redirects: result.redirects, types: result.types };
    const bare: ServerRules = {
      ...site,
      routes: result.routes.map(({ aliases: _, ...x }) => x),
      redirects: result.redirects.map(({ aliases: _, ...d }) => d),
    };
    assert.equal(htaccess({ ...site, fileAliases: [{ rawPath: '//p.html', file: 'p.html' }] }), htaccess(bare));
    assert.equal(nginxConf({ ...site, fileAliases: [{ rawPath: '//p.html', file: 'p.html' }] }), nginxConf(bare));
  });
});

describe('a line for a path starting with //', () => {
  it('comes after the site\'s own rule for /, which Netlify reads it as', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls3-root-'));
    try {
      await build(
        [
          { url: `${H}/en/`, body: page('en') },
          { url: `${H}/old.php`, status: 301, location: `${H}/en/` },
          { url: `${H}//old.php`, status: 301, location: `${H}/en/` },
          { url: `${H}/`, status: 301, location: `${H}/en/` },
          { url: `${H}/photo`, type: 'image/png', body: 'PNG MARK[photo]' },
          { url: `${H}//photo`, type: 'image/png', body: 'PNG MARK[photo]' },
        ],
        dir,
      );
      const lines = (await readFile(path.join(dir, 'site', '_redirects'), 'utf8')).split('\n').filter((l) => l && !l.startsWith('#'));
      // Netlify: the first line for "/" wins, and "//old.php" is one.
      const first = lines.find((l) => /^\/(\/|\s)/.test(l));
      assert.equal(first, '/  /en/  301');
      assert.ok(lines.includes('//old.php  /en/  301'));
      assert.ok(lines.some((l) => /^\/\/photo {2}\/__wbd\/f\/\w+\.png {2}200$/.test(l)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is written for every alias the build passes in', () => {
    const text = netlifyRedirects({
      domain: 'example.com',
      host: 'example.com',
      routes: [{ path: '/b', rawPath: '/b', file: '__wbd/f/b.png', aliases: ['//b', '/b'] }],
      redirects: [{ path: '/old.php', rawPath: '//old.php', to: '/', status: 301, aliases: ['///old.php'] }],
      types: [{ file: 'about.php', contentType: 'text/html; charset=utf-8' }],
      files: ['index.html', 'about.php', 'x.html', 'x'],
      fileAliases: [
        { rawPath: '//about.php', file: 'about.php' },
        { rawPath: '//x.html', file: 'x.html' },
        { rawPath: '//index.html', file: 'index.html' },
      ],
    });
    const plain = text.split('\n').filter((l) => l && !l.startsWith('#') && !l.includes('*'));
    assert.deepEqual(plain, [
      '/index.html  /  200',
      '/x.html  /x.html  200',
      '/old.php  /  301',
      '//old.php  /  301',
      '///old.php  /  301',
      '/b  /__wbd/f/b.png  200',
      '//b  /__wbd/f/b.png  200',
      '//about.php  /about.php  200',
      '//x.html  /x.html  200',
      '//index.html  /  200',
    ]);
    const headers = netlifyHeaders({
      domain: 'example.com',
      host: 'example.com',
      routes: [],
      redirects: [],
      types: [{ file: 'about.php', contentType: 'text/html; charset=utf-8' }],
      fileAliases: [{ rawPath: '//about.php', file: 'about.php' }],
    });
    assert.deepEqual(headers.split('\n').slice(1, -1), ['/about.php', '  Content-Type: text/html; charset=utf-8', '//about.php', '  Content-Type: text/html; charset=utf-8']);
  });
});

describe('archived spellings on the preview server', () => {
  it('answer as the address does', async () => {
    const server = await createPreviewServer(siteDir);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    stops.push(() => server.close());
    await check((server.address() as net.AddressInfo).port);
  });
});

const nginxProbe = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
describe('archived spellings on nginx', { skip: nginxProbe.error || nginxProbe.status !== 0 ? 'nginx is not installed' : false }, () => {
  it('answer as the address does', async () => {
    const dir = path.join(work, 'nginx');
    mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    const port = await freePort();
    const conf = (await readFile(path.join(serverDir, 'nginx.conf'), 'utf8')).replace('listen 80;', `listen 127.0.0.1:${port};`).replace(/root [^;]+;/, `root ${siteDir};`);
    writeFileSync(path.join(dir, 'site.conf'), conf);
    writeFileSync(path.join(dir, 'mime.types'), 'types { text/html html; image/png png; image/jpeg jpg; }\n');
    writeFileSync(
      path.join(dir, 'nginx.conf'),
      `daemon off; master_process off; pid ${dir}/nginx.pid; error_log ${dir}/error.log;\nevents {}\n` +
        `http {\n  access_log off;\n  client_body_temp_path ${dir}/tmp;\n  include ${dir}/site.conf;\n}\n`,
    );
    const t = spawnSync('nginx', ['-t', '-p', dir, '-c', path.join(dir, 'nginx.conf')], { encoding: 'utf8' });
    assert.equal(t.status, 0, t.stderr);
    const nginx = spawn('nginx', ['-p', dir, '-c', path.join(dir, 'nginx.conf')], { stdio: 'ignore' });
    stops.push(() => nginx.kill());
    await waitFor(port);
    await check(port);
  });
});

// Apache: APACHE2_ROOT (an unpacked package), or apache2 / httpd on the PATH.
const apacheRoot = process.env.APACHE2_ROOT;
const apacheBin = apacheRoot ? path.join(apacheRoot, 'usr/sbin/apache2') : ['apache2', 'httpd'].find((b) => !spawnSync(b, ['-v']).error);
const apacheModules = apacheRoot
  ? path.join(apacheRoot, 'usr/lib/apache2/modules')
  : ['/usr/lib/apache2/modules', '/usr/lib64/httpd/modules', '/usr/lib/httpd/modules'].find((d) => existsSync(d));
const apacheEnv = { ...process.env, ...(apacheRoot ? { LD_LIBRARY_PATH: path.join(apacheRoot, 'usr/lib/x86_64-linux-gnu') } : {}) };
const apacheOk = apacheBin && apacheModules && !spawnSync(apacheBin, ['-v'], { env: apacheEnv }).error;

describe('archived spellings on Apache', { skip: apacheOk ? false : 'Apache is not installed (set APACHE2_ROOT)' }, () => {
  it('answer as the address does', async () => {
    const dir = path.join(work, 'apache');
    mkdirSync(dir, { recursive: true });
    const port = await freePort();
    writeFileSync(path.join(dir, 'mime.types'), 'text/html html\nimage/png png\nimage/jpeg jpg\n');
    const root = process.getuid?.() === 0;
    writeFileSync(
      path.join(dir, 'httpd.conf'),
      [
        `ServerRoot "${dir}"`,
        'ServerName localhost',
        `Listen 127.0.0.1:${port}`,
        `PidFile ${dir}/httpd.pid`,
        `ErrorLog ${dir}/error.log`,
        ...['mpm_prefork', 'authz_core', 'mime', 'dir', 'rewrite', 'headers', 'alias']
          .filter((m) => existsSync(path.join(apacheModules!, `mod_${m}.so`)))
          .map((m) => `LoadModule ${m}_module ${apacheModules}/mod_${m}.so`),
        ...(root ? ['User nobody', 'Group nogroup'] : []),
        `TypesConfig ${dir}/mime.types`,
        `DocumentRoot "${siteDir}"`,
        `<Directory "${siteDir}">`,
        '  AllowOverride All',
        '  Require all granted',
        '</Directory>',
      ].join('\n') + '\n',
    );
    const apache = spawn(apacheBin!, ['-f', path.join(dir, 'httpd.conf'), '-X'], { env: apacheEnv, stdio: 'ignore' });
    stops.push(() => apache.kill());
    await waitFor(port);
    await check(port);
  });
});

// The real Cloudflare Pages emulator: wrangler on the PATH, or the binary WRANGLER names.
const wranglerBin = process.env.WRANGLER ?? 'wrangler';
const wranglerProbe = spawnSync(wranglerBin, ['--version'], { encoding: 'utf8' });
describe('archived spellings on wrangler pages dev', { skip: wranglerProbe.error || wranglerProbe.status !== 0 ? 'wrangler is not installed' : false }, () => {
  it('answer as the address does', async () => {
    const port = await freePort();
    const wrangler = spawn(wranglerBin, ['pages', 'dev', siteDir, '--ip', '127.0.0.1', '--port', String(port)], {
      cwd: work,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: 'ignore',
    });
    stops.push(() => wrangler.kill());
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 600; i++) {
      if (await fetch(base + '/').then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const wrong: string[] = [];
    for (const [url, want] of expected.filter(([u]) => !u.includes('?'))) {
      const res = await fetch(base + url, { redirect: 'manual' });
      const body = Buffer.from(await res.arrayBuffer()).toString('latin1');
      const got = res.status >= 300 && res.status < 400 ? `${res.status} ${res.headers.get('location')}` : `${res.status} ${/MARK\[([^\]]+)\]/.exec(body)?.[1] ?? '-'}`;
      if (got !== want) wrong.push(`${url}: ${got}, expected ${want}`);
    }
    assert.deepEqual(wrong, []);
    const php = await fetch(base + '//about.php');
    assert.match(php.headers.get('content-type') ?? '', /^text\/html/);
  });
});
