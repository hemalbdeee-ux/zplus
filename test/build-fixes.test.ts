// Regression tests for the build step: every original URL keeps working at its exact address and
// the restored files read the way they did on the original site.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildSite, planFiles } from '../src/engine/build.ts';
import type { Manifest, Resource } from '../src/engine/crawl.ts';
import type { Redirect, Route } from '../src/engine/serverconfig.ts';
import { createPreviewServer } from '../src/engine/serve.ts';
import {
  cleanSearch,
  decodePathBytes,
  hasNonUtf8Escapes,
  makeRootRelative,
  parseTimestamp,
  pathAndQuery,
  pathBytesPattern,
  queryPattern,
  tsToIso,
  unwrapWaybackInText,
  urlKey,
} from '../src/engine/url.ts';

const cleanup: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const f of cleanup) await f();
});

const res = (url: string, contentType: string, sha1: string): Resource => {
  const u = new URL(url);
  return { key: urlKey(u), url, path: pathAndQuery(u), timestamp: '20200101000000', status: 200, contentType, file: sha1, sha1, via: 'link' };
};
const kindOf = (ct: string) =>
  ct.includes('html') ? ('html' as const) : ct.includes('css') ? ('css' as const) : ct.includes('xml') ? ('xml' as const) : ('other' as const);
/** Original URL -> "file" or "file <- query|path" for routed ones; doubled-slash duplicates are left out. */
const plan = (list: Resource[]) => {
  const kinds = new Map(list.map((r) => [r.key, kindOf(r.contentType!)]));
  return Object.fromEntries(planFiles(list, kinds).map((p) => [new URL(p.res.url).pathname + new URL(p.res.url).search, p.route ? `${p.file} <- ${p.route.query ?? 'path'}` : p.file]));
};

interface Capture {
  url: string;
  type: string;
  body?: string | Buffer;
  status?: number;
  location?: string;
}

/** Builds a site from captures and serves it with the preview server. */
async function build(captures: Capture[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-build-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'work', 'raw'), { recursive: true });
  const resources: Resource[] = [];
  for (const c of captures) {
    const u = new URL(c.url);
    const body = typeof c.body === 'string' ? Buffer.from(c.body) : (c.body ?? Buffer.alloc(0));
    const sha1 = createHash('sha1').update(body).digest('hex');
    const status = c.status ?? 200;
    if (status === 200) await writeFile(path.join(dir, 'work', 'raw', sha1), body);
    resources.push({
      key: urlKey(u),
      url: c.url,
      path: pathAndQuery(u),
      timestamp: '20200101000000',
      status,
      contentType: c.type,
      ...(status === 200 ? { file: sha1, sha1 } : { location: c.location }),
      via: 'link',
    });
  }
  const manifest: Manifest = { version: 1, domain: 'example.com', target: '20200101000000', window: {}, indexSize: resources.length, truncated: false, resources, missing: [] };
  const site = path.join(dir, 'site');
  const result = await buildSite(manifest, { domain: 'example.com', siteUrl: 'https://example.com', workDir: path.join(dir, 'work'), outDir: site, serverDir: path.join(dir, 'server'), stripTracking: false });
  const server: Server = await createPreviewServer(site);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => {
    const r = await fetch(base + p, { redirect: 'manual' });
    const body = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type') ?? '', body, text: body.toString('utf8') };
  };
  return { result, site, get, read: (rel: string) => readFile(path.join(site, rel)) };
}

const page = (mark: string, extra = '') => `<!doctype html><html><head><title>${mark} | Example</title>${extra}</head><body><p>MARK[${mark}]</p></body></html>`;

/** Single-byte legacy encoder for test data (Node can decode these charsets but not encode them). */
function encode(text: string, charset: string): Buffer {
  const decoder = new TextDecoder(charset);
  const bytes = new Map<string, number>();
  for (let b = 0x80; b < 0x100; b++) bytes.set(decoder.decode(Uint8Array.of(b)), b);
  return Buffer.from([...text].map((ch) => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : bytes.get(ch)!)));
}

describe('build: a query URL next to a page at the same path', () => {
  it('routes it by its query instead of shadowing or replacing the page', () => {
    const files = plan([
      res('http://example.com/', 'text/html', 'home'),
      res('http://example.com/?feed=rss2', 'application/rss+xml', 'feed'),
      res('http://example.com/?ical=1', 'text/calendar', 'ical'),
      res('http://example.com/download.php', 'text/html', 'dl'),
      res('http://example.com/download.php?file=manual', 'application/pdf', 'pdf'),
      res('http://example.com/blog/post', 'text/html', 'post'),
      res('http://example.com/blog/post?output=pdf', 'application/pdf', 'postpdf'),
      res('http://example.com/css/site.css?ver=2', 'text/css', 'css'),
    ]);
    assert.equal(files['/'], 'index.html');
    assert.match(files['/?feed=rss2'], /^__wbd\/q\/[0-9a-f]{12}\.xml <- feed=rss2$/);
    assert.match(files['/?ical=1'], /^__wbd\/q\/[0-9a-f]{12}\.bin <- ical=1$/);
    assert.equal(files['/download.php'], 'download.php');
    assert.match(files['/download.php?file=manual'], /^__wbd\/q\/[0-9a-f]{12}\.pdf <- file=manual$/);
    assert.equal(files['/blog/post'], 'blog/post.html');
    assert.match(files['/blog/post?output=pdf'], /^__wbd\/q\/[0-9a-f]{12}\.pdf <- output=pdf$/);
    // Alone at its path, a query string that does not change the bytes is still ignored.
    assert.equal(files['/css/site.css?ver=2'], 'css/site.css');
  });

  it('never gives a query URL a path-only route', () => {
    const list = [
      res('http://example.com/thumb.php?id=3', 'image/jpeg', 'same'),
      res('http://example.com/thumb.php?id=4', 'image/jpeg', 'same'),
      res('http://example.com/feed.xml?x=1', 'application/rss+xml', 'feed'),
      res('http://example.com/feed.xml/item', 'text/html', 'item'),
    ];
    const files = plan(list);
    assert.match(files['/thumb.php?id=3'], /^__wbd\/q\/.+\.jpg <- id=3$/);
    assert.match(files['/thumb.php?id=4'], /^__wbd\/q\/.+\.jpg <- id=4$/);
    // Moved aside for the folder of the same name, it keeps its query.
    assert.match(files['/feed.xml?x=1'], /^__wbd\/q\/.+\.xml <- x=1$/);
  });

  it('serves the page and the query URL each at its own address', async () => {
    const { get } = await build([
      { url: 'http://example.com/', type: 'text/html', body: page('home') },
      { url: 'http://example.com/?feed=rss2', type: 'application/rss+xml', body: '<?xml version="1.0"?><rss version="2.0"><channel><title>MARK[feed]</title></channel></rss>' },
      { url: 'http://example.com/download.php', type: 'text/html', body: page('dlpage') },
      { url: 'http://example.com/download.php?file=manual', type: 'application/pdf', body: '%PDF-1.4 MARK[pdf]\n%%EOF' },
    ]);
    assert.match((await get('/')).text, /MARK\[home\]/);
    assert.match((await get('/?feed=rss2')).text, /MARK\[feed\]/);
    const dl = await get('/download.php');
    assert.match(dl.text, /MARK\[dlpage\]/);
    assert.match(dl.type, /text\/html/);
    assert.match((await get('/download.php?file=manual')).text, /MARK\[pdf\]/);
  });
});

describe('build: URLs that differ only in letter case', () => {
  it('gives the second spelling of identical bytes its own copy', () => {
    const files = plan([
      res('http://example.com/Images/logo.gif', 'image/gif', 'same'),
      res('http://example.com/images/logo.gif', 'image/gif', 'same'),
      res('http://example.com/style.css', 'text/css', 'css'),
      res('http://example.com/style.css?ver=1', 'text/css', 'css'),
    ]);
    assert.equal(files['/Images/logo.gif'], 'Images/logo.gif');
    assert.match(files['/images/logo.gif'], /^__wbd\/f\/[0-9a-f]{12}\.gif <- path$/);
    // The same name exactly is still shared.
    assert.equal(files['/style.css?ver=1'], 'style.css');
  });

  it('serves every spelling, with one page in the sitemap', async () => {
    const gif = Buffer.from('GIF89a MARK[logo]');
    const { get, result } = await build([
      { url: 'http://example.com/Default.aspx', type: 'text/html', body: page('default') },
      { url: 'http://example.com/default.aspx', type: 'text/html', body: page('default') },
      { url: 'http://example.com/DEFAULT.ASPX', type: 'text/html', body: page('default') },
      { url: 'http://example.com/Images/logo.gif', type: 'image/gif', body: gif },
      { url: 'http://example.com/images/logo.gif', type: 'image/gif', body: gif },
    ]);
    for (const p of ['/Default.aspx', '/default.aspx', '/DEFAULT.ASPX']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.text, /MARK\[default\]/, p);
      assert.match(r.type, /text\/html/, p);
    }
    for (const p of ['/Images/logo.gif', '/images/logo.gif']) assert.deepEqual((await get(p)).body, gif, p);
    assert.equal(result.pages.filter((pg) => pg.path.toLowerCase() === '/default.aspx').length, 1);
    assert.equal((await get('/DeFault.aspx')).status, 404);
  });
});

describe('build: scripts and stylesheets of legacy-charset pages', () => {
  it('converts them to UTF-8 along with the page', async () => {
    const ru = 'document.write("Главная | Контакты");';
    const jaJs = Buffer.concat([Buffer.from('var s = "'), Buffer.from([0x95, 0x5c]), Buffer.from('"; var t = "'), Buffer.from([0x83, 0x5c]), Buffer.from('";')]);
    const jaCss = Buffer.concat([Buffer.from('@charset "Shift_JIS";\nh1:after{content:"'), Buffer.from([0x83, 0x5c]), Buffer.from('"}')]);
    const utf8Js = 'var ok = "café";';
    const { read, site } = await build([
      {
        url: 'http://example.com/ru.html',
        type: 'text/html',
        body: encode(
          '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"><title>Главная</title>' +
            '<script src="/js/menu.js"></script><link rel="stylesheet" href="css/s.css"><script src="/js/utf8.js"></script>' +
            '<script src="http://cdn.other.com/x.js" charset="koi8-r"></script></head><body><p>Привет</p></body></html>',
          'windows-1251',
        ),
      },
      { url: 'http://example.com/js/menu.js', type: 'application/javascript', body: encode(ru, 'windows-1251') },
      { url: 'http://example.com/css/s.css', type: 'text/css', body: encode('h1:before{content:"Привет"}', 'windows-1251') },
      { url: 'http://example.com/js/utf8.js', type: 'application/javascript', body: utf8Js },
      {
        url: 'http://example.com/ja.html',
        type: 'text/html; charset=utf-8',
        body: '<html><head><title>ja</title><script src="/js/ja.js" charset="Shift_JIS"></script><link rel="stylesheet" href="/css/ja.css"></head><body>x</body></html>',
      },
      { url: 'http://example.com/js/ja.js', type: 'application/javascript', body: jaJs },
      { url: 'http://example.com/css/ja.css', type: 'text/css', body: jaCss },
    ]);
    assert.equal((await read('js/menu.js')).toString('utf8'), ru);
    assert.equal((await read('css/s.css')).toString('utf8'), 'h1:before{content:"Привет"}');
    assert.equal((await read('js/utf8.js')).toString('utf8'), utf8Js);
    const ja = (await read('js/ja.js')).toString('utf8');
    assert.equal(ja, 'var s = "表"; var t = "ソ";');
    assert.doesNotThrow(() => new Function(ja));
    assert.equal((await read('css/ja.css')).toString('utf8'), '@charset "utf-8";\nh1:after{content:"ソ"}');
    const jaPage = await readFile(path.join(site, 'ja.html'), 'utf8');
    assert.match(jaPage, /<script src="\/js\/ja\.js" charset="utf-8">/);
    // Another site's script keeps its own charset.
    assert.match(await readFile(path.join(site, 'ru.html'), 'utf8'), /<script src="http:\/\/cdn\.other\.com\/x\.js" charset="koi8-r">/);
  });
});

describe('build: Latin-1 percent escapes in a path', () => {
  it('stores the file under __wbd/ and routes the original address to it', async () => {
    assert.equal(hasNonUtf8Escapes('/caf%E9.html'), true);
    assert.equal(hasNonUtf8Escapes('/caf%C3%A9.html'), false);
    assert.equal(hasNonUtf8Escapes('/a%20b/'), false);
    assert.deepEqual(decodePathBytes('/caf%E9.html'), Buffer.from([0x2f, 0x63, 0x61, 0x66, 0xe9, 0x2e, 0x68, 0x74, 0x6d, 0x6c]));
    const { result, site, get } = await build([
      { url: 'http://example.com/', type: 'text/html', body: page('home') },
      { url: 'http://example.com/about.html', type: 'text/html', body: page('about') },
      { url: 'http://example.com/caf%E9.html', type: 'text/html', body: page('latin1') },
      { url: 'http://example.com/m%FCsli/', type: 'text/html', body: page('latin1dir') },
      { url: 'http://example.com/caf%C3%A9.html', type: 'text/html', body: page('utf8') },
      { url: 'http://example.com/alt%E9.html', type: 'text/html', status: 301, location: 'http://example.com/about.html' },
    ]);
    const files = await readdir(site, { recursive: true });
    assert.ok(!files.some((f) => f.includes('%')), files.join(', '));
    assert.ok(files.includes('café.html'));
    assert.deepEqual(
      result.routes.map((r) => r.rawPath).sort(),
      ['/caf%E9.html', '/m%FCsli/'],
    );
    assert.deepEqual(result.redirects.map((d) => [d.rawPath, d.to]), [['/alt%E9.html', '/about.html']]);
    // What Apache and nginx compare these addresses with: the decoded byte, not "%E9".
    const bytes = (raw: string) => decodePathBytes(raw).toString('latin1');
    for (const raw of [...result.routes.map((r) => r.rawPath), '/alt%E9.html', '/caf%C3%A9.html']) {
      const re = new RegExp('^' + pathBytesPattern(raw) + '$');
      assert.ok(re.test(bytes(raw)), raw);
      assert.ok(!re.test(raw), raw);
      assert.match(pathBytesPattern(raw), /^[\x20-\x7e]+$/);
    }
    assert.equal(pathBytesPattern('/caf%E9.html'), '/caf\\xE9\\.html');
    assert.equal(pathBytesPattern('//m%fcsli//'), '/m\\xFCsli/');
    assert.equal(pathBytesPattern('/caf%C3%A9.html'), '/caf\\xC3\\xA9\\.html');
    assert.match((await get('/caf%E9.html')).text, /MARK\[latin1\]/);
    assert.match((await get('/m%FCsli/')).text, /MARK\[latin1dir\]/);
    assert.match((await get('/caf%C3%A9.html')).text, /MARK\[utf8\]/);
    assert.equal((await get('/alt%E9.html')).status, 301);
  });
});

describe('build: Wayback links the author wrote', () => {
  it('keeps links to snapshots of other sites and unwraps links to this one', async () => {
    const { read } = await build([
      {
        url: 'http://example.com/',
        type: 'text/html',
        body: page(
          'home',
          '<link rel="stylesheet" href="/s.css"><meta http-equiv="refresh" content="30; url=https://web.archive.org/web/2010/http://deadsite.com/moved">',
        ).replace(
          '</body>',
          '<a id="cite" href="https://web.archive.org/web/20100101000000/http://deadsite.com/report.pdf">archived copy</a>' +
            '<img id="img" src="https://web.archive.org/web/20100101000000im_/http://deadsite.com/chart.png">' +
            '<iframe src="https://web.archive.org/web/20090101000000/http://othersite.org/widget.html"></iframe>' +
            '<a id="rel" href="/web/2009/http://othersite.org/x">rel</a>' +
            '<a id="own" href="https://web.archive.org/web/20190101000000/http://www.example.com/about.html">about</a></body>',
        ),
      },
      { url: 'http://example.com/about.html', type: 'text/html', body: page('about') },
      {
        url: 'http://example.com/s.css',
        type: 'text/css',
        body: '@import url(https://web.archive.org/web/2009/http://fonts.deadcdn.com/f.css); .a{background:url(https://web.archive.org/web/2009im_/http://example.com/a.png)}',
      },
      { url: 'http://example.com/a.png', type: 'image/png', body: 'png' },
      {
        url: 'http://example.com/app.js',
        type: 'application/javascript',
        body: 'var a = "https://web.archive.org/web/2009/http://other.net/api"; var b = "https://web.archive.org/web/2009/http://www.example.com/api";',
      },
    ]);
    const html = (await read('index.html')).toString('utf8');
    assert.match(html, /<a id="cite" href="https:\/\/web\.archive\.org\/web\/20100101000000\/http:\/\/deadsite\.com\/report\.pdf">/);
    assert.match(html, /<img id="img" src="https:\/\/web\.archive\.org\/web\/20100101000000im_\/http:\/\/deadsite\.com\/chart\.png">/);
    assert.match(html, /<iframe src="https:\/\/web\.archive\.org\/web\/20090101000000\/http:\/\/othersite\.org\/widget\.html">/);
    assert.match(html, /<a id="rel" href="https:\/\/web\.archive\.org\/web\/2009\/http:\/\/othersite\.org\/x">/);
    assert.match(html, /url=https:\/\/web\.archive\.org\/web\/2010\/http:\/\/deadsite\.com\/moved/);
    assert.match(html, /<a id="own" href="\/about\.html">/);
    assert.equal(
      (await read('s.css')).toString('utf8'),
      '@import url(https://web.archive.org/web/2009/http://fonts.deadcdn.com/f.css); .a{background:url(/a.png)}',
    );
    assert.equal(
      (await read('app.js')).toString('utf8'),
      'var a = "https://web.archive.org/web/2009/http://other.net/api"; var b = "http://www.example.com/api";',
    );
  });

  it('unwraps text only for the given domain', () => {
    const css = 'url(https://web.archive.org/web/2019im_/http://other.com/a.png) url(//web.archive.org/web/2019im_/https://www.Example.com:80/b.png)';
    assert.equal(unwrapWaybackInText(css, 'example.com'), 'url(https://web.archive.org/web/2019im_/http://other.com/a.png) url(https://www.Example.com:80/b.png)');
    assert.equal(unwrapWaybackInText(css), 'url(http://other.com/a.png) url(https://www.Example.com:80/b.png)');
  });
});

describe('build: .xhtml pages', () => {
  it('are stored so that every server sends them as text/html', async () => {
    const files = plan([res('http://example.com/page.xhtml', 'application/xhtml+xml', 'x'), res('http://example.com/page.html', 'text/html', 'h')]);
    assert.equal(files['/page.xhtml'], 'page.xhtml.html');
    assert.equal(files['/page.html'], 'page.html');
    const { get, result } = await build([
      { url: 'http://example.com/', type: 'text/html', body: page('home') },
      {
        url: 'http://example.com/page.xhtml',
        type: 'application/xhtml+xml',
        body: '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>MARK[xhtml]<br/></p></body></html>',
      },
    ]);
    const r = await get('/page.xhtml');
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\/html/);
    assert.match(r.text, /MARK\[xhtml\]/);
    assert.deepEqual(result.routes, []);
  });
});

describe('build: doubled slashes in a path', () => {
  it('keeps links to the site on the site', () => {
    const rel = makeRootRelative('example.com');
    assert.equal(rel('http://example.com//wp-content/uploads/a.jpg'), '/wp-content/uploads/a.jpg');
    assert.equal(rel('https://www.example.com///a.jpg?x=1'), '/a.jpg?x=1');
    assert.equal(rel('http://example.com/a//b.jpg'), '/a//b.jpg');
  });

  it('stores the file where the merged path finds it', async () => {
    const files = plan([
      res('http://example.com//double/slash.png', 'image/png', 'd'),
      res('http://example.com/a.png', 'image/png', 'a1'),
      res('http://example.com//a.png', 'image/png', 'a2'),
      res('http://example.com//index.php?page=x', 'text/html', 'q'),
    ]);
    assert.equal(files['//double/slash.png'], 'double/slash.png');
    assert.equal(files['/a.png'], 'a.png');
    // Other bytes than /a.png: kept for the doubled-slash spelling only.
    assert.match(files['//a.png'], /^__wbd\/f\/[0-9a-f]{12}\.png <- path$/);
    assert.match(files['//index.php?page=x'], /^__wbd\/q\/.+ <- page=x$/);
    const kinds = new Map([[urlKey(new URL('http://example.com//index.php?page=x')), 'html' as const]]);
    const [routed] = planFiles([res('http://example.com//index.php?page=x', 'text/html', 'q')], kinds);
    assert.deepEqual({ path: routed.route?.path, rawPath: routed.route?.rawPath }, { path: '/index.php', rawPath: '//index.php' });

    const { get, read, result } = await build([
      { url: 'http://example.com/', type: 'text/html', body: page('home').replace('</body>', '<img id="i" src="http://example.com//double/slash.png"></body>') },
      { url: 'http://example.com//double/slash.png', type: 'image/png', body: 'MARK[double]' },
      { url: 'http://example.com/old.php', type: 'text/html', body: page('old') },
      { url: 'http://example.com//old.php', type: 'text/html', status: 301, location: 'http://example.com/' },
    ]);
    // Apache and nginx turn //double/slash.png into /double/slash.png before they look for it.
    assert.match((await get('/double/slash.png')).text, /MARK\[double\]/);
    assert.match((await read('index.html')).toString('utf8'), /<img id="i" src="\/double\/slash\.png">/);
    // The redirect at //old.php must not catch the page at /old.php: it fires for //old.php only.
    assert.deepEqual(result.redirects.map((d) => [d.rawPath, d.exact]), [['//old.php', true]]);
    assert.match((await get('/old.php')).text, /MARK\[old\]/);
    assert.equal((await get('//old.php')).status, 301);
  });

  it('answers query URLs and redirects at the merged address too', async () => {
    const H = 'http://example.com';
    const { get, read, result } = await build([
      { url: `${H}/`, type: 'text/html', body: page('home').replace('</body>', `<a id="p" href="${H}//?p=123">post</a><a id="l" href="${H}//list.php">list</a></body>`) },
      { url: `${H}//?p=123`, type: 'text/html', body: page('post123') },
      { url: `${H}///?p=123`, type: 'text/html', body: page('post123b') },
      { url: `${H}//index.php?page_id=5`, type: 'text/html', body: page('page5') },
      { url: `${H}/index.php`, type: 'text/html', body: page('indexphp') },
      { url: `${H}//list.php`, type: 'text/html', status: 301, location: `${H}/` },
      { url: `${H}//list.php?p=2`, type: 'text/html', body: page('list2') },
      { url: `${H}//go.php?id=1`, type: 'text/html', status: 302, location: `${H}/index.php` },
      { url: `${H}//Both.php?x=1`, type: 'text/html', body: page('Both') },
      { url: `${H}/both.php?x=1`, type: 'text/html', body: page('both') },
    ]);
    // Links lose the doubled slash, and nginx matches query rules on the raw request.
    const html = (await read('index.html')).toString('utf8');
    assert.match(html, /<a id="p" href="\/\?p=123">/);
    assert.match(html, /<a id="l" href="\/list\.php">/);
    // One rule per address the server reads; ///?p=123 has other bytes than //?p=123, so it keeps
    // a rule for its own spelling.
    const rules = JSON.parse((await read('__wbd/routes.json')).toString('utf8')) as { routes: Route[]; redirects: Redirect[] };
    const key = (x: Route | Redirect) => x.rawPath + (x.query !== undefined ? '?' + x.query : '') + (x.exact ? ' exact' : '');
    assert.deepEqual(rules.routes.map(key).sort(), ['///?p=123 exact', '//?p=123', '//Both.php?x=1', '//index.php?page_id=5', '//list.php?p=2', '/both.php?x=1']);
    assert.deepEqual(rules.redirects.map(key).sort(), ['//go.php?id=1', '//list.php']);
    assert.deepEqual(result.redirects.map(key).sort(), ['//go.php?id=1', '//list.php']);
    assert.match((await get('///?p=123')).text, /MARK\[post123b\]/);
    assert.match((await get('/Both.php?x=1')).text, /MARK\[Both\]/);
    assert.match((await get('/?p=123')).text, /MARK\[post123\]/);
    assert.match((await get('/index.php?page_id=5')).text, /MARK\[page5\]/);
    assert.match((await get('/index.php')).text, /MARK\[indexphp\]/);
    assert.match((await get('/list.php?p=2')).text, /MARK\[list2\]/);
    assert.equal((await get('/list.php')).status, 301);
    assert.equal((await get('/go.php?id=1')).status, 302);
    assert.match((await get('/both.php?x=1')).text, /MARK\[both\]/);
  });
});

describe('url: dates for --target, --from and --to', () => {
  it('pads one-digit months and days field by field', () => {
    assert.equal(parseTimestamp('2019-6'), '20190601000000');
    assert.equal(parseTimestamp('2019-6-5'), '20190605000000');
    assert.equal(parseTimestamp('2019/6/5'), '20190605000000');
    assert.equal(parseTimestamp('2019.06.05'), '20190605000000');
    assert.equal(parseTimestamp('2019-06-12 08:30'), '20190612083000');
    assert.equal(parseTimestamp('20190612083015'), '20190612083015');
    assert.equal(parseTimestamp('2019-6', true), '20190631235959');
    assert.equal(parseTimestamp('2019-6-5', true), '20190605235959');
  });

  it('rejects dates the calendar does not have', () => {
    for (const bad of ['2019-13', '2019-02-30', '2019-6-31', '6/5/2019', '201913', '20190230', '2019-06-12 25:00', '2019-6-5-1']) {
      assert.throws(() => parseTimestamp(bad), /Not a date/, bad);
    }
    assert.equal(parseTimestamp('2020-02-29'), '20200229000000');
  });

  it('never turns an odd timestamp into 1 January', () => {
    assert.equal(tsToIso('20190612083015'), '2019-06-12T08:30:15Z');
    assert.equal(tsToIso('20190631235959'), '2019-06-30T23:59:59Z');
    assert.equal(tsToIso('20191301000000'), '2019-12-01T00:00:00Z');
    assert.equal(tsToIso('2019'), '2019-01-01T00:00:00Z');
  });
});

describe('url: query patterns for server rules', () => {
  it('match exactly the raw queries that clean to the stored one', () => {
    const raws = [
      'a=1&b=2', 'a=1&&b=2', '&a=1&b=2&', 'a=1&b=2&utm_source=x', 'fbclid=1&a=1&UTM_Medium=e&b=2', 'a=1&gclid', 'a=1',
      'a=1&b=2&c=3', 'b=2&a=1', 'a=12&b=2', 'xa=1&b=2', 'a=1&b=2x', '', 'fbclid=IwAR0abc', '&&', 'x=1', 'utm_=1', 'a.1&b=2',
      // Escaped names are not tracking parameters to either side.
      'a=1&b=2&utm%5Fsource=x', '%66bclid=1&a=1&b=2', 'utm%5Fsource=x', 'a=1&GCLID=2&b=2&_gl=', 'A=1&b=2',
    ];
    for (const query of ['a=1&b=2', 'a=1', '', 'x=1']) {
      const re = new RegExp(queryPattern(query));
      for (const raw of raws) assert.equal(re.test(raw), cleanSearch('?' + raw).slice(1) === query, `${query} vs ${raw}`);
    }
  });
});
