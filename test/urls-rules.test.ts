// How the generated rules compare a request with an archived URL: the query string without
// tracking parameters and empty segments (Apache normalizes it once, nginx per key), the path as the
// server reads it (merged slashes, decoded bytes) or, for one spelling only, as sent. Also the rules
// for Cloudflare Pages that depend on what the build passes in.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildSite, planFiles } from '../src/engine/build.ts';
import type { Manifest, Resource } from '../src/engine/crawl.ts';
import { htaccess, netlifyHeaders, netlifyRedirects, nginxConf, pagesOverflow, type Redirect, type Route, type ServerRules } from '../src/engine/serverconfig.ts';
import { cleanSearch, pathAndQuery, rawPathKey, serverPath, urlKey } from '../src/engine/url.ts';

const rules = (routes: Route[], redirects: Redirect[] = []): ServerRules => ({ domain: 'example.com', host: 'example.com', routes, redirects, types: [] });
const res = (url: string, sha1: string, status = 200, location?: string): Resource => {
  const u = new URL(url);
  return { key: urlKey(u), url, path: pathAndQuery(u), timestamp: '20200101000000', status, contentType: 'text/html', ...(status === 200 ? { file: sha1, sha1 } : { location }), via: 'link' };
};

/** Second argument of a quoted mod_rewrite line ("RewriteCond %{X} "pattern""), as a RegExp. */
const condPattern = (line: string, flags = '') => new RegExp(/^\S+ \S+ "?([^"]*?)"?(?: \[NC\])?$/.exec(line)![1], flags);

/** Seeded random numbers, so a failure can be reproduced. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = ['a=1', 'b=2', '', '', 'utm_source=x', 'UTM_Medium', 'fbclid=IwAR0', 'gclid', 'utm_=1', 'utm%5Fsource=x', '=', 'a', '_GA=1', 'mc_cid=2', 'fbclidx=1', 'utm_source.x=1', 'p=%26', 'q=a+b', 'r=(1)|x.y', 'id=3', 'x=$1'];
const rawQueries = (count: number) => {
  const next = random(9);
  const out = ['', 'a=1', 'a=1&b=2', 'a=1&&b=2', '&a=1&b=2&', 'fbclid=1', '&&', 'utm_source=a&a=1&FBCLID=2&b=2&gclid'];
  while (out.length < count) out.push(Array.from({ length: 1 + Math.floor(next() * 6) }, () => SEGMENTS[Math.floor(next() * SEGMENTS.length)]).join('&'));
  return out;
};

describe('Apache: the query string a rule compares', () => {
  const routes: Route[] = ['a=1', 'a=1&b=2', 'id=3', 'q=a+b&r=(1)|x.y', 'x=$1'].map((q, i) => ({ path: '/s.php', rawPath: '/s.php', query: q, file: `__wbd/q/${i}.html` }));
  const lines = htaccess(rules(routes, [{ path: '/go.php', rawPath: '/go.php', noQuery: true, to: '/', status: 301 }])).split('\n');
  // The rules that set WBD_QUERY, run the way mod_rewrite runs them: [N] starts again from the top.
  const init = lines.indexOf('RewriteRule ^ - [E=WBD_QUERY:&%{QUERY_STRING}&]');
  const loops = lines
    .map((l, i) => (l.startsWith('RewriteRule ^ - [E=WBD_QUERY:%1%2,N]') ? condPattern(lines[i - 1], lines[i - 1].endsWith('[NC]') ? 'i' : '') : null))
    .filter((re): re is RegExp => re !== null);
  const apacheQuery = (raw: string) => {
    let v = `&${raw}&`;
    for (let i = 0; i < 1000; i++) {
      const m = loops.map((re) => re.exec(v)).find((x) => x);
      if (!m) return v;
      v = m[1] + m[2];
    }
    throw new Error(`no end for ${raw}`);
  };

  it('is set once, before every rule that reads it', () => {
    assert.ok(init > 0);
    assert.equal(lines[init - 1], 'RewriteCond %{ENV:WBD_QUERY} ^$');
    assert.equal(loops.length, 2);
    const firstUse = lines.findIndex((l) => l.startsWith('RewriteCond %{ENV:WBD_QUERY} "'));
    assert.ok(firstUse > init + 4);
  });

  it('is the query cleanSearch() keeps, so every rule matches the URLs that clean to its own', () => {
    const conds = lines.filter((l) => l.startsWith('RewriteCond %{ENV:WBD_QUERY} "'));
    assert.equal(conds.length, routes.length + 1);
    for (const raw of rawQueries(3000)) {
      const clean = cleanSearch('?' + raw).slice(1);
      const v = apacheQuery(raw);
      assert.equal(v, clean ? `&${clean}&` : '&', raw);
      const hits = conds.filter((c) => condPattern(c).test(v)).map((c) => lines[lines.indexOf(c) + 1]);
      const want = [...routes.filter((x) => x.query === clean).map((x) => x.file), ...(clean === '' ? ['"/?"'] : [])];
      assert.deepEqual(hits.map((h) => want.find((w) => h.includes(w))), want, raw);
    }
  });

  it('leaves the query out of an original redirect that matched without one', () => {
    assert.ok(lines.includes('RewriteRule "^go\\.php$" "/?" [R=301,NE,L]'));
  });

  it('is not set up for a site without query URLs', () => {
    assert.doesNotMatch(htaccess(rules([{ path: '/a', rawPath: '/a', file: '__wbd/f/a.png' }])), /WBD_QUERY/);
  });
});

/** nginx map entries as [name, key, value], unescaped the way nginx reads quoted strings. */
function nginxMaps(conf: string): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  let name = '';
  for (const line of conf.split('\n')) {
    const m = /^map \S+ \$wbd_example_com_(\w+) \{$/.exec(line);
    if (m) name = m[1];
    const e = /^ {4}"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)";$/.exec(line);
    if (e) out.push([name, ...(e.slice(1, 3).map((s) => s.replace(/\\(["\\])/g, '$1')) as [string, string])]);
  }
  return out;
}

describe('nginx: the keys a rule is found by', () => {
  it('compare the path as nginx reads it and the cleaned query', () => {
    const routes: Route[] = [
      { path: '/list.php', rawPath: '/list.php', query: 'a=1&b=2', file: '__wbd/q/1.html' },
      { path: '/', rawPath: '//', query: 'p=1', file: '__wbd/q/2.html' },
      { path: '/caf%E9.php', rawPath: '/caf%E9.php', query: 'x=1', file: '__wbd/q/3.html' },
      { path: '/caf%E9.html', rawPath: '/caf%E9.html', file: '__wbd/f/4.html' },
    ];
    const conf = nginxConf(rules(routes, [{ path: '/go.php', rawPath: '//go.php', noQuery: true, to: '/', status: 301 }]));
    assert.match(conf, /^map "\$uri\?\$args" \$wbd_example_com_route_q \{$/m);
    assert.match(conf, /^map "\$uri\?\$args" \$wbd_example_com_q301 \{$/m);
    assert.match(conf, /^map \$uri \$wbd_example_com_route_p \{$/m);
    assert.doesNotMatch(conf, /^map \$request_uri/m);
    assert.doesNotMatch(conf, /[^\x20-\x7e\n]/);
    const maps = nginxMaps(conf);
    // What nginx compares: "$uri?$args" (the path merged and decoded, the query as sent) or $uri.
    const find = (map: string, uri: string, args?: string) => maps.find(([n, k]) => n === map && new RegExp(k.slice(1)).test(args === undefined ? uri : `${uri}?${args}`))?.[2];
    for (const raw of rawQueries(500)) {
      const clean = cleanSearch('?' + raw).slice(1);
      assert.equal(find('route_q', serverPath('/list.php'), raw), clean === 'a=1&b=2' ? '/__wbd/q/1.html' : undefined, raw);
      assert.equal(find('route_q', serverPath('///'), raw), clean === 'p=1' ? '/__wbd/q/2.html' : undefined, raw);
      assert.equal(find('q301', serverPath('/go.php'), raw), clean === '' ? '/' : undefined, raw);
    }
    assert.equal(find('route_q', serverPath('/caf%e9.php'), 'x=1&fbclid=2'), '/__wbd/q/3.html');
    assert.equal(find('route_q', serverPath('/caf%25E9.php'), 'x=1'), undefined);
    assert.equal(find('route_p', serverPath('//caf%e9.html')), '/__wbd/f/4.html');
    assert.equal(find('route_p', serverPath('/caf%25E9.html')), undefined);
  });

  it('compare the raw request for a rule of one spelling only, and check those first', () => {
    const conf = nginxConf(
      rules(
        [
          { path: '/a.png', rawPath: '//a.png', file: '__wbd/f/a2.png', exact: true },
          { path: '/', rawPath: '///', query: 'p=1', file: '__wbd/q/b.html', exact: true },
        ],
        [
          { path: '/r.php', rawPath: '//r.php', query: 'id=2', to: '/', status: 301, exact: true },
          { path: '/n%C3%A9.php', rawPath: '//n%C3%A9.php', noQuery: true, to: '/x', status: 302, exact: true },
        ],
      ),
    );
    assert.match(conf, /^map \$request_uri \$wbd_example_com_route_x \{$/m);
    assert.ok(conf.indexOf('if ($wbd_example_com_x301)') < conf.indexOf('if ($wbd_example_com_q301)'));
    assert.ok(conf.indexOf('if ($wbd_example_com_route_x)') < conf.indexOf('if ($wbd_example_com_route_q)'));
    const maps = nginxMaps(conf);
    const find = (map: string, requestUri: string) => maps.find(([n, k]) => n === map && new RegExp(k.slice(1)).test(requestUri))?.[2];
    assert.equal(find('route_x', '//a.png'), '/__wbd/f/a2.png');
    assert.equal(find('route_x', '//a.png?v=2'), '/__wbd/f/a2.png');
    assert.equal(find('route_x', '/a.png'), undefined);
    assert.equal(find('route_x', '///a.png'), undefined);
    assert.equal(find('route_x', '///?p=1&fbclid=x'), '/__wbd/q/b.html');
    assert.equal(find('route_x', '//?p=1'), undefined);
    assert.equal(find('x301', '//r.php?id=2&&'), '/');
    assert.equal(find('x301', '/r.php?id=2'), undefined);
    assert.equal(find('x302', '//n%c3%a9.php'), '/x');
    assert.equal(find('x302', '//n%C3%A9.php?utm_source=a'), '/x');
    assert.equal(find('x302', '//n%C3%A9.php?a=1'), undefined);
  });
});

describe('Apache: a rule for one spelling only', () => {
  it('checks the request line before the rule of the address it shares', () => {
    const lines = htaccess(
      rules(
        [
          { path: '/a.png', rawPath: '/a.png', file: '__wbd/f/a1.png' },
          { path: '/a.png', rawPath: '//a.png', file: '__wbd/f/a2.png', exact: true },
        ],
        [{ path: '/r.php', rawPath: '//r%c3%a9.php', query: 'id=2', to: '/', status: 301, exact: true }],
      ),
    ).split('\n');
    const a2 = lines.indexOf('RewriteRule "^a\\.png$" "__wbd/f/a2.png" [NS,L]');
    assert.ok(a2 > 0 && a2 < lines.indexOf('RewriteRule "^a\\.png$" "__wbd/f/a1.png" [NS,L]'));
    const request = condPattern(lines[a2 - 1]);
    assert.ok(lines[a2 - 1].startsWith('RewriteCond %{THE_REQUEST} '));
    assert.ok(request.test('GET //a.png HTTP/1.1'));
    assert.ok(request.test('GET //a.png?v=1 HTTP/1.1'));
    assert.ok(!request.test('GET /a.png HTTP/1.1'));
    assert.ok(!request.test('GET ///a.png HTTP/1.1'));
    const r = lines.findIndex((l) => l.startsWith('RewriteRule "^r\\xC3\\xA9\\.php$" "/?"'));
    assert.ok(r > 0);
    assert.ok(condPattern(lines[r - 2]).test('GET //r%C3%A9.php?id=2 HTTP/1.1'));
    assert.ok(condPattern(lines[r - 1]).test('&id=2&'));
  });

  it('stops after a rule has picked a file, so the file is not taken for an original URL', () => {
    const lines = htaccess(rules([], [{ path: '/about.html', rawPath: '/about.html', to: '/about', status: 301 }])).split('\n');
    const stop = lines.indexOf('RewriteRule ^ - [L]');
    assert.equal(lines[stop - 1], 'RewriteCond %{ENV:REDIRECT_STATUS} .');
    assert.ok(stop < lines.findIndex((l) => l.includes('[R=301,NE,L]')));
    assert.ok(stop < lines.indexOf('RewriteRule ^(.+)$ $1.html [L]'));
  });
});

describe('build: archived spellings of one address', () => {

  it('serve each address from its first capture, and other bytes from their own spelling only', () => {
    const list = [
      res('http://example.com/?p=1', 'a'),
      res('http://example.com//?p=1', 'a'),
      res('http://example.com///?p=1', 'b'),
      res('http://example.com/caf%C3%A9.html', 'c'),
      res('http://example.com/caf%c3%a9.html', 'd'),
      res('http://example.com/list.php?a=1&b=2', 'e'),
      res('http://example.com/list.php?a=1&&b=2', 'f'),
    ];
    const plans = planFiles(list, new Map(list.map((r) => [r.key, 'html' as const])));
    const got = Object.fromEntries(plans.map((p) => [p.res.url.slice(18), p.route ? `${p.route.rawPath}${p.route.query ? '?' + p.route.query : ''}${p.route.exact ? ' exact' : ''}` : p.file]));
    assert.deepEqual(got, { '/?p=1': '/?p=1', '///?p=1': '///?p=1 exact', '/caf%C3%A9.html': 'café.html', '/list.php?a=1&b=2': '/list.php?a=1&b=2' });
  });

  it('keep redirects to another spelling of the same address for that spelling only', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls-rules-'));
    try {
      await mkdir(path.join(dir, 'raw'));
      const body = Buffer.from('<!doctype html><title>x</title><p>x</p>');
      const sha1 = createHash('sha1').update(body).digest('hex');
      await writeFile(path.join(dir, 'raw', sha1), body);
      const resources = [
        res('http://example.com/x.php', sha1),
        res('http://example.com//x.php', '', 301, 'http://example.com/x.php'),
        res('http://example.com/y.php', '', 301, 'http://example.com//y.php'),
        res('http://example.com/z.php', '', 301, 'http://example.com//new/z.php'),
        res('http://example.com/c%e9.php', '', 301, 'http://example.com/c%E9.php'),
        res('http://example.com/t.php?id=1', '', 301, 'http://example.com/t.php?id=1&utm_source=x'),
      ];
      const manifest: Manifest = { version: 1, domain: 'example.com', target: '20200101000000', window: {}, indexSize: resources.length, truncated: false, resources, missing: [] };
      const { redirects } = await buildSite(manifest, { domain: 'example.com', siteUrl: 'https://example.com', workDir: dir, outDir: path.join(dir, 'site'), serverDir: path.join(dir, 'server'), stripTracking: false });
      // /y.php to //y.php and the others to themselves would loop; //new/z.php would name a host.
      assert.deepEqual(redirects.map((d) => [d.rawPath, d.to, !!d.exact]), [
        ['/z.php', '/new/z.php', false],
        ['//x.php', '/x.php', true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('url: addresses', () => {
  it('are what Apache and nginx look a path up by', () => {
    assert.equal(serverPath('//caf%e9.html'), serverPath('/caf%E9.html'));
    assert.equal(serverPath('/caf%E9.html'), '/caf\xe9.html');
    assert.equal(serverPath('/caf%C3%A9.html'), '/caf\xc3\xa9.html');
    assert.notEqual(serverPath('/caf%25E9.html'), serverPath('/caf%E9.html'));
    assert.notEqual(serverPath('/About.html'), serverPath('/about.html'));
    assert.equal(rawPathKey('//caf%e9.html'), '//caf%E9.html');
  });
});

describe('Cloudflare Pages', () => {
  const cleanup: string[] = [];
  after(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true });
  });

  it('gets the plain files from the build, so x.html next to a file x stays itself', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls-pages-'));
    cleanup.push(dir);
    await mkdir(path.join(dir, 'raw'));
    const captures: Array<[string, string, string]> = [
      ['http://example.com/', 'text/html', '<!doctype html><title>home</title><p>home</p>'],
      ['http://example.com/gallery/IMG_1.jpg', 'image/jpeg', 'JPEG'],
      ['http://example.com/gallery/IMG_1.jpg.html', 'text/html', '<!doctype html><title>slide</title><p>slide</p>'],
      ['http://example.com/menu.html', 'text/html', '<!doctype html><title>menu</title><p>menu</p>'],
    ];
    const resources: Resource[] = [];
    for (const [url, type, body] of captures) {
      const sha1 = createHash('sha1').update(body).digest('hex');
      await writeFile(path.join(dir, 'raw', sha1), body);
      resources.push({ ...res(url, sha1), contentType: type });
    }
    const manifest: Manifest = { version: 1, domain: 'example.com', target: '20200101000000', window: {}, indexSize: resources.length, truncated: false, resources, missing: [] };
    const result = await buildSite(manifest, { domain: 'example.com', siteUrl: 'https://example.com', workDir: dir, outDir: path.join(dir, 'site'), serverDir: path.join(dir, 'server'), stripTracking: false });
    const text = await readFile(path.join(dir, 'site', '_redirects'), 'utf8');
    assert.match(text, /^\/gallery\/IMG_1\.jpg\.html {2}\/gallery\/IMG_1\.jpg\.html {2}200$/m);
    assert.doesNotMatch(text, /^\/menu\.html /m);
    assert.deepEqual(result.warnings, []);
  });

  it('reads the .html rules among its first 2,000 plain lines, and the build says when rules are past its limits', () => {
    const many: Route[] = Array.from({ length: 2100 }, (_, i) => ({ path: `/p${i}`, rawPath: `/p${i}`, file: `__wbd/f/${i}.png` }));
    const site = { ...rules(many), files: ['index.html', 'x.html', 'x'] };
    const plain = netlifyRedirects(site)
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(plain.slice(0, 2), ['/index.html  /  200', '/x.html  /x.html  200']);
    assert.equal(pagesOverflow(netlifyRedirects(site), netlifyHeaders(site)), 102);
    assert.equal(pagesOverflow(netlifyRedirects(rules(many.slice(0, 1990))), netlifyHeaders(rules([]))), 0);
    const patterns: Route[] = Array.from({ length: 99 }, (_, i) => ({ path: `/wiki/Talk:P${i}.html`, rawPath: `/wiki/Talk:P${i}.html`, file: `__wbd/f/t${i}.html` }));
    assert.equal(pagesOverflow(netlifyRedirects(rules(patterns)), netlifyHeaders(rules([]))), 1);
    const types = Array.from({ length: 100 }, (_, i) => ({ file: `p${i}.php`, contentType: 'text/html; charset=utf-8' }));
    assert.equal(pagesOverflow(netlifyRedirects(rules([])), netlifyHeaders({ ...rules([]), types })), 1);
  });

  it('gets no rule it cannot match: doubled slashes are merged, one-spelling rules left to Apache and nginx', () => {
    const text = netlifyRedirects(
      rules(
        [
          { path: '/a.png', rawPath: '//a.png', file: '__wbd/f/a2.png', exact: true },
          { path: '/b', rawPath: '//b', file: '__wbd/f/b.png' },
        ],
        [{ path: '/old.php', rawPath: '//old.php', to: '/', status: 301 }],
      ),
    );
    assert.match(text, /^\/b {2}\/__wbd\/f\/b\.png {2}200$/m);
    assert.match(text, /^\/old\.php {2}\/ {2}301$/m);
    assert.doesNotMatch(text, /^\/\//m);
    assert.match(text, /^#   \/\/a\.png$/m);
  });
});

describe('generated rules', () => {
  it('name zplus.ai', () => {
    const site = rules([]);
    for (const text of [htaccess(site), nginxConf(site), netlifyRedirects(site), netlifyHeaders(site)]) {
      assert.match(text.split('\n')[0], /^# Generated by zplus\.ai for example\.com\b/);
      assert.doesNotMatch(text, /Wayback Downloader/);
    }
  });
});
