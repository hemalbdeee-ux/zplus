// Every original URL answers at its exact address on every server the restored site ships rules
// for: the preview, nginx (generated nginx.conf) and Apache (generated .htaccess). One site holds the
// awkward cases: query strings with "&&" or tracking parameters, Latin-1 escapes, doubled slashes,
// letter-case twins, an extensionless page next to its redirected .html, and % or # in a path.
// nginx and Apache are started when installed; set APACHE2_ROOT to an unpacked apache2 package
// (usr/sbin/apache2, usr/lib/apache2/modules) to use one that is not.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildSite, type BuildResult } from '../src/engine/build.ts';
import type { Manifest, Resource } from '../src/engine/crawl.ts';
import { createPreviewServer } from '../src/engine/serve.ts';
import { pathAndQuery, QUERY_PASSES, urlKey } from '../src/engine/url.ts';

const H = 'http://example.com';
/** A raw query with this many runs of segments the rules drop ("a=1&&b=2" has one). */
const runs = (n: number) => Array.from({ length: n }, (_, i) => `k${i}=v`).join('&&') + '&&last=1';
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
  { url: `${H}/about.html`, body: page('about') },
  // Query strings as archived: "&&", a trailing "&", tracking parameters (finding 9).
  { url: `${H}/?p=1`, body: page('post1') },
  { url: `${H}/list.php?a=1&&b=2`, body: page('double-amp') },
  { url: `${H}/list.php?a=5&`, body: page('trailing-amp') },
  { url: `${H}/page.php?id=3&utm_source=newsletter`, body: page('page3') },
  { url: `${H}/go.php`, status: 301, location: `${H}/page.php?id=3` },
  { url: `${H}/go.php?x=1`, body: page('go-x1') },
  { url: `${H}/old.php?id=7&utm_medium=email`, status: 301, location: `${H}/` },
  { url: `${H}/s.php?q=a+b&r=(1)|x.y`, body: page('special') },
  { url: `${H}/index.php?page=Contact`, body: page('Contact') },
  { url: `${H}/index.php?page=contact`, body: page('contact') },
  { url: `${H}/index.php`, status: 301, location: `${H}/` },
  { url: `${H}/runs.php?${runs(QUERY_PASSES - 1)}`, body: page('runs') },
  // Latin-1 escapes (finding 26).
  { url: `${H}/caf%E9.html`, body: page('latin1') },
  { url: `${H}/caf%E9.html?x=1`, body: page('latin1-q') },
  { url: `${H}/cr%E8me/`, body: page('latin1-dir') },
  { url: `${H}/img/gar%E7on.gif`, type: 'image/gif', body: 'GIF89a MARK[latin1-gif]' },
  { url: `${H}/p%E2te`, body: page('latin1-bare') },
  { url: `${H}/alt%E9.html`, status: 301, location: `${H}/about.html` },
  { url: `${H}/caf%C3%A9.html`, body: page('utf8') },
  // Doubled slashes (finding 48).
  { url: `${H}//double/slash.png`, type: 'image/png', body: 'PNG MARK[double]' },
  { url: `${H}//?p=123`, body: page('post123') },
  { url: `${H}///?p=123`, body: page('post123b') },
  { url: `${H}/?p=7`, status: 301, location: `${H}/about.html` },
  { url: `${H}//?p=7`, status: 301, location: `${H}/about.html` },
  { url: `${H}/r.php?id=2`, body: page('r2') },
  { url: `${H}//r.php?id=2`, status: 301, location: `${H}/` },
  { url: `${H}/nq.php`, status: 301, location: `${H}/` },
  { url: `${H}//nq.php`, status: 301, location: `${H}/` },
  { url: `${H}/nq.php?x=1`, body: page('nq-x1') },
  { url: `${H}//only.php?id=3`, status: 301, location: `${H}/about.html` },
  { url: `${H}/same.php`, body: page('same') },
  { url: `${H}//same.php`, status: 301, location: `${H}/same.php` },
  { url: `${H}/a.png`, type: 'image/png', body: 'PNG MARK[a1]' },
  { url: `${H}//a.png`, type: 'image/png', body: 'PNG MARK[a2]' },
  // Letter-case twins of an IIS site (findings 8, 22, 45).
  { url: `${H}/Default.aspx`, body: page('default') },
  { url: `${H}/default.aspx`, body: page('default') },
  { url: `${H}/DEFAULT.ASPX`, body: page('default') },
  { url: `${H}/Images/logo.gif`, type: 'image/gif', body: 'GIF89a MARK[logo]' },
  { url: `${H}/images/logo.gif`, type: 'image/gif', body: 'GIF89a MARK[logo]' },
  { url: `${H}/About-Us.html`, body: page('about-us') },
  { url: `${H}/about-us.html`, body: page('about-us') },
  { url: `${H}/Page.html`, body: page('Page') },
  { url: `${H}/page.html`, body: page('page') },
  { url: `${H}/q.php?id=A`, body: page('qA') },
  { url: `${H}/q.php?id=a`, body: page('qa') },
  // An extensionless page whose .html spelling the site redirected to it, or is another page.
  { url: `${H}/team`, body: page('team') },
  { url: `${H}/team.html`, status: 301, location: `${H}/team` },
  { url: `${H}/menu`, body: page('menu') },
  { url: `${H}/menu.html`, body: page('menu-html') },
  // % and # in an extensionless path (finding 25).
  { url: `${H}/100%25-natural`, body: page('percent') },
  { url: `${H}/a%23b`, body: page('hash') },
  { url: `${H}/a`, body: page('plain-a') },
];

/** [request exactly as sent, "status MARK" or "status Location"] */
const expected: Array<[string, string]> = [
  ['/', '200 home'],
  ['/?p=1', '200 post1'],
  ['/?p=1&fbclid=x', '200 post1'],
  ['/?fbclid=x&p=1', '200 post1'],
  ['/?p=2', '200 home'],
  ['/list.php?a=1&&b=2', '200 double-amp'],
  ['/list.php?a=1&b=2', '200 double-amp'],
  ['/list.php?a=5&', '200 trailing-amp'],
  ['/list.php?a=5', '200 trailing-amp'],
  ['/list.php?a=50', '404 -'],
  ['/list.php?b=2&a=1', '404 -'],
  ['/page.php?id=3&utm_source=newsletter', '200 page3'],
  ['/page.php?id=3', '200 page3'],
  ['/page.php?UTM_Source=a&id=3&fbclid=X', '200 page3'],
  ['/page.php?id=33', '404 -'],
  ['/page.php?id=3&utm%5Fsource=x', '404 -'],
  ['/go.php', '301 /page.php?id=3'],
  ['/go.php?fbclid=IwAR0abc', '301 /page.php?id=3'],
  ['/go.php?&&', '301 /page.php?id=3'],
  ['/go.php?x=1', '200 go-x1'],
  ['/go.php?x=1&fbclid=z', '200 go-x1'],
  ['/go.php?y=2', '404 -'],
  ['/old.php?id=7&utm_medium=email', '301 /'],
  ['/old.php?id=7', '301 /'],
  ['/old.php?id=8', '404 -'],
  ['/s.php?q=a+b&r=(1)|x.y', '200 special'],
  ['/s.php?q=aab&r=(1)|x.y', '404 -'],
  ['/index.php?page=Contact', '200 Contact'],
  ['/index.php?page=contact', '200 contact'],
  ['/index.php?page=CONTACT', '404 -'],
  ['/index.php', '301 /'],
  ['/index.php?fbclid=1', '301 /'],
  // The rules drop a fixed number of runs, whatever the query costs to clean: one more and no rule
  // compares it.
  [`/runs.php?${runs(QUERY_PASSES - 1)}`, '200 runs'],
  [`/runs.php?${runs(QUERY_PASSES - 1).replaceAll('&&', '&')}`, '200 runs'],
  [`/runs.php?${runs(QUERY_PASSES - 1)}&&fbclid=1`, '200 runs'],
  [`/runs.php?&${runs(QUERY_PASSES - 1)}`, '200 runs'],
  [`/runs.php?&${runs(QUERY_PASSES - 1)}&&fbclid=1`, '404 -'],
  [`/?${'a&&'.repeat(1000)}`, '200 home'],
  [`/?p=1${'&'.repeat(3000)}`, '200 post1'],
  [`/?${'_ga&'.repeat(700)}p=1`, '200 post1'],
  ['/caf%E9.html', '200 latin1'],
  ['/caf%e9.html', '200 latin1'],
  ['/caf%E9.html?fbclid=1', '200 latin1'],
  ['/caf%e9.html?x=1', '200 latin1-q'],
  ['/caf%25E9.html', '404 -'],
  ['/cr%E8me/', '200 latin1-dir'],
  ['/img/gar%E7on.gif', '200 latin1-gif'],
  ['/p%E2te', '200 latin1-bare'],
  ['/alt%E9.html', '301 /about.html'],
  ['/alt%e9.html', '301 /about.html'],
  ['/caf%C3%A9.html', '200 utf8'],
  ['/caf%c3%a9.html', '200 utf8'],
  ['//double/slash.png', '200 double'],
  ['/double/slash.png', '200 double'],
  ['/?p=123', '200 post123'],
  ['//?p=123', '200 post123'],
  ['///?p=123', '200 post123b'],
  ['////?p=123', '200 post123'],
  ['/?p=7', '301 /about.html'],
  ['//?p=7', '301 /about.html'],
  ['/r.php?id=2', '200 r2'],
  ['//r.php?id=2', '301 /'],
  ['/nq.php', '301 /'],
  ['//nq.php', '301 /'],
  ['/nq.php?x=1', '200 nq-x1'],
  ['//nq.php?x=1', '200 nq-x1'],
  ['//only.php?id=3', '301 /about.html'],
  ['/only.php?id=3', '301 /about.html'],
  ['/same.php', '200 same'],
  ['//same.php', '301 /same.php'],
  ['/a.png', '200 a1'],
  ['//a.png', '200 a2'],
  ['/Default.aspx', '200 default'],
  ['/default.aspx', '200 default'],
  ['/DEFAULT.ASPX', '200 default'],
  ['/DeFault.aspx', '404 -'],
  ['/Images/logo.gif', '200 logo'],
  ['/images/logo.gif', '200 logo'],
  ['/About-Us.html', '200 about-us'],
  ['/about-us.html', '200 about-us'],
  ['/About-us.html', '404 -'],
  ['/Page.html', '200 Page'],
  ['/page.html', '200 page'],
  ['/q.php?id=A', '200 qA'],
  ['/q.php?id=a', '200 qa'],
  ['/team', '200 team'],
  ['/team.html', '301 /team'],
  ['/menu', '200 menu'],
  ['/menu.html', '200 menu-html'],
  ['/100%25-natural', '200 percent'],
  ['//100%25-natural', '200 percent'],
  ['/a%23b', '200 hash'],
  ['/a', '200 plain-a'],
  ['/__wbd/routes.json', '404 -'],
];

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

const work = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls-'));
const siteDir = path.join(work, 'site');
const serverDir = path.join(work, 'server');
let result: BuildResult;
const stops: Array<() => void> = [];

before(async () => {
  mkdirSync(path.join(work, 'raw'), { recursive: true });
  const resources: Resource[] = [];
  for (const c of captures) {
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
  result = await buildSite(manifest, { domain: 'example.com', siteUrl: 'https://example.com', workDir: work, outDir: siteDir, serverDir, stripTracking: false });
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

describe('original URLs on the preview server', () => {
  it('answer as on the original site', async () => {
    const server = await createPreviewServer(siteDir);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    stops.push(() => server.close());
    await check((server.address() as net.AddressInfo).port);
  });

  it('keeps running after odd request targets', async () => {
    const server = await createPreviewServer(siteDir);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    stops.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    for (const p of ['//', '//?p=1', '///x', '//[::1]/', '//a:b@c/']) assert.match(await probe(port, p), /^\d{3} /, p);
    assert.equal(await probe(port, '/'), '200 home');
  });
});

const nginxProbe = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
describe('original URLs on nginx', { skip: nginxProbe.error || nginxProbe.status !== 0 ? 'nginx is not installed' : false }, () => {
  it('answer as on the original site', async () => {
    const dir = path.join(work, 'nginx');
    mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    const port = await freePort();
    const conf = (await readFile(path.join(serverDir, 'nginx.conf'), 'utf8')).replace('listen 80;', `listen 127.0.0.1:${port};`).replace(/root [^;]+;/, `root ${siteDir};`);
    writeFileSync(path.join(dir, 'site.conf'), conf);
    writeFileSync(path.join(dir, 'mime.types'), 'types { text/html html; image/png png; image/gif gif; }\n');
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

describe('original URLs on Apache', { skip: apacheOk ? false : 'Apache is not installed (set APACHE2_ROOT)' }, () => {
  it('answer as on the original site', async () => {
    const dir = path.join(work, 'apache');
    mkdirSync(dir, { recursive: true });
    const port = await freePort();
    writeFileSync(path.join(dir, 'mime.types'), 'text/html html\nimage/png png\nimage/gif gif\n');
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

describe('rules of the restored site', () => {
  it('keep one rule per address, and one for a spelling only when it answers differently', () => {
    const key = (x: { rawPath: string; query?: string; exact?: boolean }) => x.rawPath + (x.query !== undefined ? '?' + x.query : '') + (x.exact ? ' (exact)' : '');
    const redirects = result.redirects.map(key);
    assert.ok(redirects.includes('//r.php?id=2 (exact)'));
    assert.ok(redirects.includes('//same.php (exact)'));
    assert.ok(redirects.includes('//only.php?id=3'));
    assert.ok(!redirects.some((k) => k.startsWith('//?p=7') || k.startsWith('//nq.php')), redirects.join(', '));
    const routes = result.routes.map(key);
    assert.ok(routes.includes('///?p=123 (exact)'));
    assert.ok(routes.includes('//a.png (exact)'));
    assert.ok(!routes.some((k) => k.startsWith('/?p=123')), routes.join(', '));
  });

  it('write redirect targets the browser reads as a path', async () => {
    for (const d of result.redirects) assert.ok(!d.to.startsWith('//'), d.to);
    const lines = (await readFile(path.join(siteDir, '_redirects'), 'utf8')).split('\n').filter((l) => l && !l.startsWith('#'));
    for (const l of lines) assert.ok(!l.split(/\s+/)[1].startsWith('//'), l);
  });
});
