// How the generated rules compare a request with an archived URL: the query string without
// tracking parameters and empty segments (normalized once per request, in a fixed number of passes),
// the path as the server reads it (merged slashes, decoded bytes) or, for one spelling only, as
// sent. Also the rules for Cloudflare Pages that depend on what the build passes in.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildSite, planFiles } from '../src/engine/build.ts';
import type { Manifest, Resource } from '../src/engine/crawl.ts';
import { htaccess, netlifyHeaders, netlifyRedirects, nginxConf, pagesOverflow, type Redirect, type Route, type ServerRules } from '../src/engine/serverconfig.ts';
import { cleanSearch, pathAndQuery, QUERY_PASSES, rawPathKey, ruleQuery, serverPath, urlKey } from '../src/engine/url.ts';

const rules = (routes: Route[], redirects: Redirect[] = []): ServerRules => ({ domain: 'example.com', host: 'example.com', routes, redirects, types: [] });
const res = (url: string, sha1: string, status = 200, location?: string): Resource => {
  const u = new URL(url);
  return { key: urlKey(u), url, path: pathAndQuery(u), timestamp: '20200101000000', status, contentType: 'text/html', ...(status === 200 ? { file: sha1, sha1 } : { location }), via: 'link' };
};

/**
 * A PCRE pattern of the rules as a RegExp. JavaScript has no possessive quantifiers; the patterns
 * use them only where giving back characters could never lead to a match, so they match the same.
 */
const pcre = (pattern: string, flags = '') => new RegExp(pattern.replace(/([+*])\+/g, '$1'), flags);

/** Second argument of a quoted mod_rewrite line ("RewriteCond %{X} "pattern""), as a RegExp. */
const condPattern = (line: string) => pcre(/^\S+ \S+ "?([^"]*?)"?(?: \[NC\])?$/.exec(line)![1], line.endsWith(' [NC]') ? 'i' : '');

/** Raw queries with this many runs of segments to drop ("a=1&&b=2" has one). */
const runs = (n: number) => Array.from({ length: n }, (_, i) => `k${i}=v`).join('&&') + (n ? '&&last=1' : '');

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
  // The rules that set WBD_QUERY, run once each in file order, as mod_rewrite runs them.
  const init = lines.indexOf('RewriteRule ^ - [E=WBD_QUERY:&%{QUERY_STRING}&]');
  const steps = lines
    .map((l, i) => (/^RewriteRule \^ - \[E=WBD_QUERY:(%1%2|-)\]$/.test(l) ? { at: i, re: condPattern(lines[i - 1]), drop: l.endsWith(':-]') } : null))
    .filter((x) => x !== null);
  const apacheQuery = (raw: string) => {
    let v = `&${raw}&`;
    for (const { re, drop } of steps) {
      const m = re.exec(v);
      if (m) v = drop ? '-' : m[1] + m[2];
    }
    return v;
  };
  const conds = lines.filter((l) => l.startsWith('RewriteCond %{ENV:WBD_QUERY} "^&'));
  const hits = (raw: string) => conds.filter((c) => condPattern(c).test(apacheQuery(raw))).map((c) => lines[lines.indexOf(c) + 1]);

  it('is set once, before every rule that reads it, in a fixed number of steps', () => {
    assert.ok(init > 0);
    assert.equal(steps.length, QUERY_PASSES + 1);
    assert.ok(steps[0].at > init);
    assert.ok(steps.at(-1)!.drop);
    assert.ok(!lines.some((l) => /\bN\b|N=/.test(/\[([^\]]*)\]$/.exec(l)?.[1] ?? '')));
    const firstUse = lines.findIndex((l) => l.startsWith('RewriteCond %{ENV:WBD_QUERY} "^&'));
    assert.ok(firstUse > steps.at(-1)!.at);
  });

  it('is the query cleanSearch() keeps, so every rule matches the URLs that clean to its own', () => {
    assert.equal(conds.length, routes.length + 1);
    for (const raw of rawQueries(3000)) {
      const clean = cleanSearch('?' + raw).slice(1);
      assert.equal(ruleQuery('?' + raw), clean, raw);
      assert.equal(apacheQuery(raw), clean ? `&${clean}&` : '&', raw);
      const want = [...routes.filter((x) => x.query === clean).map((x) => x.file), ...(clean === '' ? ['"/?"'] : [])];
      assert.deepEqual(hits(raw).map((h) => want.find((w) => h.includes(w))), want, raw);
    }
  });

  it('drops a fixed number of runs, so that a long crafted query costs no more than a few scans', () => {
    const route = { path: '/s.php', rawPath: '/s.php', query: 'k0=v&last=1', file: '__wbd/q/k.html' };
    const one = htaccess(rules([route])).split('\n');
    const cond = one.find((l) => l.startsWith('RewriteCond %{ENV:WBD_QUERY} "^&k0'))!;
    assert.ok(condPattern(cond).test(apacheQuery(runs(1))));
    assert.equal(apacheQuery(runs(QUERY_PASSES)).length, runs(QUERY_PASSES).length + 2 - QUERY_PASSES);
    assert.equal(ruleQuery('?' + runs(QUERY_PASSES)), cleanSearch('?' + runs(QUERY_PASSES)).slice(1));
    // One more, and no rule compares the query: the preview says the same.
    assert.equal(apacheQuery(runs(QUERY_PASSES + 1)), '-');
    assert.equal(ruleQuery('?' + runs(QUERY_PASSES + 1)), undefined);
    assert.equal(apacheQuery('a&&'.repeat(2700)), '-');
    assert.equal(apacheQuery('_ga&'.repeat(2000) + 'id=3'), '&id=3&');
    assert.equal(apacheQuery('id=3' + '&'.repeat(8000)), '&id=3&');
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

/** $wbd_example_com_args for a raw query: the maps that drop runs, applied in turn. */
function nginxArgs(conf: string, raw: string): string {
  const passes = [...conf.matchAll(/^ {4}"~\*(.*)" \$1\$2;$/gm)].map((m) => pcre(m[1].replace(/\\(["\\])/g, '$1'), 'i'));
  assert.equal(passes.length, QUERY_PASSES);
  let v = `&${raw}&`;
  for (const re of passes) {
    const m = re.exec(v);
    if (m) v = m[1] + m[2];
  }
  return v;
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
    assert.match(conf, /^map "&\$args&" \$wbd_example_com_args1 \{$/m);
    assert.match(conf, /^map "\$uri\?\$wbd_example_com_args" \$wbd_example_com_route_q \{$/m);
    assert.match(conf, /^map "\$uri\?\$wbd_example_com_args" \$wbd_example_com_q301 \{$/m);
    assert.match(conf, /^map \$uri \$wbd_example_com_route_p \{$/m);
    assert.doesNotMatch(conf, /^map \$request_uri/m);
    assert.doesNotMatch(conf, /[^\x20-\x7e\n]/);
    const maps = nginxMaps(conf);
    // What nginx compares: "$uri?$wbd_example_com_args" (the path merged and decoded, the cleaned
    // query) or $uri.
    const find = (map: string, uri: string, args?: string) =>
      maps.find(([n, k]) => n === map && new RegExp(k.slice(1)).test(args === undefined ? uri : `${uri}?${nginxArgs(conf, args)}`))?.[2];
    for (const raw of [...rawQueries(500), runs(QUERY_PASSES), runs(QUERY_PASSES + 1)]) {
      const clean = ruleQuery('?' + raw);
      assert.equal(find('route_q', serverPath('/list.php'), raw), clean === 'a=1&b=2' ? '/__wbd/q/1.html' : undefined, raw);
      assert.equal(find('route_q', serverPath('///'), raw), clean === 'p=1' ? '/__wbd/q/2.html' : undefined, raw);
      assert.equal(find('q301', serverPath('/go.php'), raw), clean === '' ? '/' : undefined, raw);
    }
    assert.equal(nginxArgs(conf, runs(QUERY_PASSES)), `&${cleanSearch('?' + runs(QUERY_PASSES)).slice(1)}&`);
    assert.match(nginxArgs(conf, runs(QUERY_PASSES + 1)), /&&/);
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
    assert.match(conf, /^map \$request_uri \$wbd_example_com_path \{$/m);
    assert.match(conf, /^map "\$wbd_example_com_path\?\$wbd_example_com_args" \$wbd_example_com_route_x \{$/m);
    assert.ok(conf.indexOf('if ($wbd_example_com_x301)') < conf.indexOf('if ($wbd_example_com_q301)'));
    assert.ok(conf.indexOf('if ($wbd_example_com_route_x)') < conf.indexOf('if ($wbd_example_com_route_q)'));
    const maps = nginxMaps(conf);
    // What nginx compares: the path of $request_uri, "?" and the cleaned query.
    const find = (map: string, requestUri: string) => {
      const [p, ...q] = requestUri.split('?');
      return maps.find(([n, k]) => n === map && new RegExp(k.slice(1)).test(`${p}?${nginxArgs(conf, q.join('?'))}`))?.[2];
    };
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

describe('build: pages at a spelling with doubled slashes', () => {
  it('name the address the servers answer from, and leave a twin of another page out of the sitemap', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-urls-twins-'));
    try {
      await mkdir(path.join(dir, 'raw'));
      const page = (mark: string) => `<!doctype html><html><head><title>${mark}</title></head><body><p>${mark} ${'text '.repeat(40)}</p></body></html>`;
      const resources: Resource[] = [];
      for (const [url, body] of [
        ['http://example.com/', page('home')],
        ['http://example.com/twin.html', page('twin')],
        ['http://example.com//twin.html', page('twin-double')],
        ['http://example.com//only.html', page('only')],
        ['http://example.com/blog//post.html', page('post')],
        ['http://example.com/blog/y.html', page('y')],
        ['http://example.com/blog//y.html', page('y-double')],
        ['http://example.com/caf%E9.html', page('latin1')],
        ['http://example.com//caf%e9.html', page('latin1-double')],
        ['http://example.com/' + `list.php?${runs(QUERY_PASSES + 1)}`, page('runs')],
      ]) {
        const sha1 = createHash('sha1').update(body).digest('hex');
        await writeFile(path.join(dir, 'raw', sha1), body);
        resources.push(res(url, sha1));
      }
      const manifest: Manifest = { version: 1, domain: 'example.com', target: '20200101000000', window: {}, indexSize: resources.length, truncated: false, resources, missing: [] };
      const site = path.join(dir, 'site');
      const result = await buildSite(manifest, { domain: 'example.com', siteUrl: 'https://example.com', workDir: dir, outDir: site, serverDir: path.join(dir, 'server'), stripTracking: false });
      const locs = [...(await readFile(path.join(site, 'sitemap-pages.xml'), 'utf8')).matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
      // Each address once; a page that is no spelling of another keeps its own URL.
      for (const u of ['twin.html', 'only.html', 'caf%E9.html', 'blog//post.html', 'blog/y.html']) assert.equal(locs.filter((l) => l === 'https://example.com/' + u).length, 1, u);
      assert.ok(locs.every((l) => l.startsWith('https://example.com/')), locs.join(' '));
      assert.ok(!locs.includes('https://example.com/blog//y.html'));
      const twin = result.routes.find((x) => x.rawPath === '//twin.html')!;
      assert.ok(twin.exact);
      const html = await readFile(path.join(site, twin.file), 'utf8');
      assert.match(html, /twin-double/);
      assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/twin\.html">/);
      assert.match(await readFile(path.join(site, 'only.html'), 'utf8'), /<meta property="og:url" content="https:\/\/example\.com\/only\.html">/);
      assert.match(await readFile(path.join(site, 'blog/post.html'), 'utf8'), /<link rel="canonical" href="https:\/\/example\.com\/blog\/\/post\.html">/);
      const y = result.routes.find((x) => x.rawPath === '/blog//y.html')!;
      assert.match(await readFile(path.join(site, y.file), 'utf8'), /<link rel="canonical" href="https:\/\/example\.com\/blog\/y\.html">/);
      // An archived query with more runs to drop than the server rules strip is named.
      assert.equal(result.warnings.filter((w) => w.includes('list.php?k0=v&&k1=v')).length, 1, result.warnings.join('\n'));
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
    // _headers holds one rule per .php page (no fixed /__wbd/* rule any more): 101 rules, 1 past the limit.
    const types = Array.from({ length: 101 }, (_, i) => ({ file: `p${i}.php`, contentType: 'text/html; charset=utf-8' }));
    assert.equal(pagesOverflow(netlifyRedirects(rules([])), netlifyHeaders({ ...rules([]), types })), 1);
  });

  it('gets a line for the address and one for the doubled slashes, which Pages compares as sent', () => {
    const text = netlifyRedirects(
      rules(
        [
          { path: '/a.png', rawPath: '/a.png', file: '__wbd/f/a1.png' },
          { path: '/a.png', rawPath: '//a.png', file: '__wbd/f/a2.png', exact: true },
          { path: '/b', rawPath: '//b', file: '__wbd/f/b.png' },
          { path: '/c', rawPath: '/c', query: 'x=1', file: '__wbd/q/c.html' },
        ],
        [{ path: '/old.php', rawPath: '//old.php', to: '/', status: 301 }],
      ),
    );
    const plain = text.split('\n').filter((l) => l && !l.startsWith('#') && !l.includes('*'));
    assert.deepEqual(plain.slice(1), [
      '/old.php  /  301',
      '//old.php  /  301',
      '/a.png  /__wbd/f/a1.png  200',
      '//a.png  /__wbd/f/a2.png  200',
      '/b  /__wbd/f/b.png  200',
      '//b  /__wbd/f/b.png  200',
    ]);
    assert.match(text, /^# 1 URLs with a query string need Apache, LiteSpeed or nginx/m);
    assert.match(text, /^#   \/c\?x=1$/m);
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
