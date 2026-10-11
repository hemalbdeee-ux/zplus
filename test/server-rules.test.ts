// Server rules for archived URLs that are awkward to express: quotes and control characters in
// paths, case variants, long keys, "$" in redirect targets, % and # in extensionless paths, and
// folder URLs next to their own index.html. When nginx is installed, the generated nginx.conf is
// also loaded and requested for real.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { htaccess, nginxConf, type Redirect, type Route, type ServerRules } from '../src/engine/serverconfig.ts';

const rules = (routes: Route[], redirects: Redirect[]): ServerRules => ({ domain: 'example.com', host: 'example.com', routes, redirects, types: [] });

/** Port of parseargline() in mod_rewrite.c: a quote always ends a quoted argument, and a backslash only matters before whitespace. */
function rewriteArgs(line: string): { args: string[]; rest: string } {
  const args: string[] = [];
  let i = 0;
  while (args.length < 3) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const quote = line[i] === '"' || line[i] === "'" ? line[i++] : '';
    let arg = '';
    for (; i < line.length; i++) {
      if ((/\s/.test(line[i]) && !quote) || line[i] === quote) break;
      if (line[i] === '\\' && /\s/.test(line[i + 1] ?? '')) arg += line[i++];
      arg += line[i];
    }
    i++;
    args.push(arg);
  }
  return { args, rest: line.slice(i) };
}

describe('Apache rules for odd archived paths', () => {
  const odd = ['/"http:/www.other.com/"', '/foo\n', '/a\rb', '/tab\tx', '/sp ace "x"', '/end\\', '/100%-natural'];

  it('keeps each rule on one line with its arguments intact, whatever bytes the path has', () => {
    const routes: Route[] = odd.map((p, i) => ({ path: p + 'r', rawPath: encodeURI(p + 'r'), file: `__wbd/f/${i}.html` }));
    routes.push({ path: '/s.php', rawPath: '/s.php', query: 'a="b"', file: '__wbd/q/s.html' });
    const redirects: Redirect[] = odd.map((p) => ({ path: p, rawPath: encodeURI(p), to: '/x"y', status: 301 }));
    const text = htaccess(rules(routes, redirects));
    assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f]/);

    const lines = text.split('\n');
    for (const line of lines) {
      if (line === '' || line.startsWith('#') || line.startsWith('<') || line.startsWith('  ')) continue;
      assert.match(line, /^[A-Z][A-Za-z]+ /, `stray line: ${JSON.stringify(line)}`);
    }
    const rewrites = lines.filter((l) => l.startsWith('RewriteRule ')).map((l) => rewriteArgs(l.slice(12)));
    for (const d of redirects) {
      const rule = rewrites.find((r) => new RegExp(r.args[0]).test(d.path.slice(1)) && r.args[2] === '[R=301,NE,L]');
      assert.ok(rule, `no redirect rule for ${JSON.stringify(d.path)}`);
      assert.equal(rule.args[1], '/x\\%22y');
      assert.equal(rule.rest.trim(), '');
    }
    for (const x of routes) {
      const rule = rewrites.find((r) => new RegExp(r.args[0]).test(x.path.slice(1)) && r.args[1] === x.file);
      assert.ok(rule, `no route rule for ${JSON.stringify(x.path)}`);
      assert.equal(rule.args[2], '[NS,L]');
      assert.equal(rule.rest.trim(), '');
      assert.ok(!new RegExp(rule.args[0]).test(x.path.slice(1) + 'z'));
    }
    const cond = lines.find((l) => l.startsWith('RewriteCond %{ENV:WBD_QUERY} "^&a'));
    assert.ok(cond);
    const { args } = rewriteArgs(cond.slice(12));
    assert.equal(args.length, 2);
    assert.ok(new RegExp(args[1]).test('&a="b"&'));
  });

  it('keeps folder URLs off the route of their own index.html', () => {
    const text = htaccess(
      rules(
        [
          { path: '/index.html', rawPath: '/index.html', file: '__wbd/f/a.html' },
          { path: '/blog/index.html', rawPath: '/blog/index.html', file: '__wbd/f/b.html' },
          { path: '/index.html', rawPath: '/index.html', query: 'x=1', file: '__wbd/q/c.html' },
        ],
        [],
      ),
    );
    // mod_dir finds / and /blog/ through a subrequest for index.html; NS keeps the routes out of it.
    const internal = text.split('\n').filter((l) => /^RewriteRule .* "__wbd\//.test(l));
    assert.equal(internal.length, 3);
    for (const l of internal) assert.match(l, / \[NS,L\]$/);
  });

  it('serves extensionless URLs with % or # from the still-encoded request path', () => {
    const lines = htaccess(rules([], [])).split('\n');
    const special = lines.indexOf('RewriteRule [%#] %1.html [L]');
    const general = lines.indexOf('RewriteRule ^(.+)$ $1.html [L]');
    assert.ok(special > 0 && special < general);
    assert.deepEqual(lines.slice(special - 3, special), [
      'RewriteCond %{REQUEST_FILENAME} !-f',
      'RewriteCond %{REQUEST_FILENAME}.html -f',
      'RewriteCond %{THE_REQUEST} ^\\S+\\s+(/[^?\\s]*)',
    ]);
    // The rule only takes paths that need it (mod_rewrite matches the decoded path) ...
    const pattern = new RegExp(rewriteArgs(lines[special].slice(12)).args[0]);
    assert.deepEqual(['100%-natural', 'tag/c#', 'about'].map((p) => pattern.test(p)), [true, true, false]);
    // ... and %1 is the path as the browser sent it, so Apache decodes it only once.
    const request = new RegExp(rewriteArgs(lines[special - 1].slice(12)).args[1]);
    assert.equal(request.exec('GET /tag/c%23 HTTP/1.1')?.[1], '/tag/c%23');
    assert.equal(request.exec('GET /100%25-natural?x=1 HTTP/2.0')?.[1], '/100%25-natural');
  });
});

// Case variants, long keys and "$" in targets, as one site.
const files: Record<string, string> = {
  'index.html': 'home',
  'About.html': 'About-upper',
  'news.html': 'news',
  'menu.html': 'menu',
  'index.php': 'index-php',
  '404.html': 'not-found',
};
const siteRoutes: Route[] = [];
const route = (p: string, file: string, mark: string, query?: string) => {
  siteRoutes.push({ path: p, rawPath: p, query, file });
  files[file] = mark;
};
route('/about.html', '__wbd/f/ccc.html', 'about-lower');
route('/search.php', '__wbd/q/d1.html', 'q-Bread', 'q=Bread');
route('/search.php', '__wbd/q/d2.html', 'q-bread', 'q=bread');
route('/index.php', '__wbd/q/j.html', 'joomla', 'option=com_content&view=article&id=12&Itemid=5');
route('/index.php', '__wbd/q/c.html', 'contact', 'page=contact');
route('/wp-content/uploads/2011/03/a-rather-long-file-name-for-an-image.html', '__wbd/f/long.html', 'long-route');
route('/odata.svc', '__wbd/q/o.html', 'odata', '$format=json');
const siteRedirects: Redirect[] = [
  { path: '/News', rawPath: '/News', to: '/news', status: 301 },
  { path: '/Old', rawPath: '/Old', to: '/About.html', status: 301 },
  { path: '/old', rawPath: '/old', to: '/menu.html', status: 302 },
  { path: '/2011/03/our-favourite-sourdough-recipe-for-beginners', rawPath: '/2011/03/our-favourite-sourdough-recipe-for-beginners', to: '/menu.html', status: 301 },
  { path: '/buy', rawPath: '/buy', to: '/shop/?currency=$usd', status: 302 },
  { path: '/buy5', rawPath: '/buy5', to: '/shop/?price=$5&x=${y}', status: 302 },
  { path: '/"http:/www.other.com/"', rawPath: '/%22http:/www.other.com/%22', to: '/', status: 301 },
  { path: '/index.php', rawPath: '/index.php', noQuery: true, to: '/', status: 301 },
];
const site = rules(siteRoutes, siteRedirects);

/** [request, status, MARK of the page or the redirect target] */
const expected: Array<[string, number, string]> = [
  ['/', 200, 'home'],
  ['/About.html', 200, 'About-upper'],
  ['/about.html', 200, 'about-lower'],
  ['/search.php?q=Bread', 200, 'q-Bread'],
  ['/search.php?q=bread', 200, 'q-bread'],
  ['/News', 301, '/news'],
  ['/news', 200, 'news'],
  ['/Old', 301, '/About.html'],
  ['/old', 302, '/menu.html'],
  ['/index.php?option=com_content&view=article&id=12&Itemid=5', 200, 'joomla'],
  ['/index.php?page=contact', 200, 'contact'],
  ['/index.php', 301, '/'],
  ['/index.php?other=1', 200, 'index-php'],
  ['/wp-content/uploads/2011/03/a-rather-long-file-name-for-an-image.html', 200, 'long-route'],
  ['/2011/03/our-favourite-sourdough-recipe-for-beginners', 301, '/menu.html'],
  ['/odata.svc?$format=json', 200, 'odata'],
  ['/buy', 302, '/shop/?currency=$usd'],
  ['/buy5', 302, '/shop/?price=$5&x=${y}'],
  ['/%22http:/www.other.com/%22', 301, '/'],
];

describe('nginx rules', () => {
  const conf = nginxConf(site);
  const entries = [...conf.matchAll(/^ {4}"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)";$/gm)].map((m) => m.slice(1, 3).map((s) => s.replace(/\\(["\\])/g, '$1')));

  it('matches every key case-sensitively, with no limit on its length', () => {
    assert.equal(entries.length, siteRoutes.length + siteRedirects.length);
    const keys = [
      ...siteRoutes.map((x) => (x.query !== undefined ? `${x.rawPath}?&${x.query}&` : x.path)),
      ...siteRedirects.map((d) => (d.noQuery ? d.rawPath + '?&' : d.path)),
    ];
    for (const [key] of entries) {
      // "~" is a case-sensitive regex; plain strings go into a case-insensitive, size-limited hash.
      assert.match(key, /^~\^.*\$$/);
      const re = new RegExp(key.slice(1));
      const own = keys.filter((k) => re.test(k));
      assert.equal(own.length, 1, `${key} matches ${JSON.stringify(own)}`);
      assert.ok(!re.test(own[0].toUpperCase()) || own[0] === own[0].toUpperCase());
    }
  });

  it('writes "$" in redirect targets as a literal dollar sign', () => {
    assert.match(conf, /^geo \$wbd_example_com_dollar \{ default "\$"; \}$/m);
    const buy = entries.find(([k]) => k === '~^/buy$');
    assert.equal(buy?.[1], '/shop/?currency=${wbd_example_com_dollar}usd');
    for (const [, v] of entries) assert.doesNotMatch(v.replaceAll('${wbd_example_com_dollar}', ''), /\$/);
    assert.doesNotMatch(nginxConf(rules(siteRoutes, [])), /geo /);
  });
});

// Real nginx, when installed: the config must load and every URL must answer as on the original site.
const work = mkdtempSync(path.join(os.tmpdir(), 'wbd-nginx-'));
const nginxMain = (port: number) =>
  `daemon off; master_process off; pid ${work}/nginx.pid; error_log ${work}/error.log;\n` +
  `events {}\nhttp {\n  access_log off;\n  client_body_temp_path ${work}/tmp;\n  include ${work}/site.conf;\n}\n`;
writeFileSync(path.join(work, 'mime.types'), 'types { text/html html; }\n');
writeFileSync(path.join(work, 'site.conf'), 'server { listen 127.0.0.1:1; }\n');
writeFileSync(path.join(work, 'nginx.conf'), nginxMain(1));
const probe = spawnSync('nginx', ['-t', '-q', '-p', work, '-c', path.join(work, 'nginx.conf')], { encoding: 'utf8' });
const noNginx = probe.error || probe.status !== 0 ? 'nginx is not installed or cannot run here' : false;

describe('generated nginx.conf on real nginx', { skip: noNginx }, () => {
  let nginx: ReturnType<typeof spawn> | undefined;
  let base = '';

  before(async () => {
    const root = path.join(work, 'site');
    for (const [file, mark] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), `<!doctype html><title>${mark}</title><p>MARK[${mark}]</p>\n`);
    }
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    writeFileSync(path.join(work, 'site.conf'), nginxConf(site).replace('listen 80;', `listen 127.0.0.1:${port};`).replace(/root [^;]+;/, `root ${root};`));
    writeFileSync(path.join(work, 'nginx.conf'), nginxMain(port));
    const t = spawnSync('nginx', ['-t', '-p', work, '-c', path.join(work, 'nginx.conf')], { encoding: 'utf8' });
    assert.equal(t.status, 0, t.stderr);
    nginx = spawn('nginx', ['-p', work, '-c', path.join(work, 'nginx.conf')], { stdio: 'ignore' });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      const up = await fetch(base + '/').then(
        () => true,
        () => false,
      );
      if (up) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('nginx did not start');
  });

  after(() => {
    nginx?.kill();
  });

  it('serves every original URL at its own address', async () => {
    for (const [url, status, want] of expected) {
      const res = await fetch(base + url, { redirect: 'manual' });
      const body = await res.text();
      const got = res.status >= 300 ? res.headers.get('location')!.replace(base, '') : /MARK\[([^\]]+)\]/.exec(body)?.[1];
      assert.deepEqual([res.status, got], [status, want], url);
    }
  });
});

after(() => rmSync(work, { recursive: true, force: true }));
