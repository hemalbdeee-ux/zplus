import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCdxJson } from '../src/engine/archive.ts';
import { phpSafe, planFiles } from '../src/engine/build.ts';
import { decodeText, detectCharset } from '../src/engine/charset.ts';
import { cleanDocument } from '../src/engine/clean.ts';
import type { Resource } from '../src/engine/crawl.ts';
import { analyzePage, scoreSignals } from '../src/engine/health.ts';
import { loadHtml, rewriteCss, rewriteSrcset } from '../src/engine/html.ts';
import { extractMeta, guessSiteName } from '../src/engine/meta.ts';
import { htaccess } from '../src/engine/serverconfig.ts';
import { cleanSearch, makeRootRelative, normalizeDomain, parseTimestamp, unwrapWayback, unwrapWaybackInText, urlKey } from '../src/engine/url.ts';

describe('url', () => {
  it('normalizes domains', () => {
    assert.equal(normalizeDomain('https://www.Example.com/path'), 'example.com');
    assert.equal(normalizeDomain('www2.example.co.uk'), 'example.co.uk');
    assert.throws(() => normalizeDomain('not a domain'));
  });

  it('keys ignore scheme, www, port and tracking parameters but keep the exact path and query', () => {
    assert.equal(urlKey(new URL('https://www.example.com:443/About.php?id=3&utm_source=x')), 'example.com/About.php?id=3');
    assert.notEqual(urlKey(new URL('http://example.com/about')), urlKey(new URL('http://example.com/about/')));
    assert.equal(cleanSearch('?fbclid=1'), '');
    assert.equal(cleanSearch('?b=2&a=1'), '?b=2&a=1');
  });

  it('unwraps links that go through the Wayback Machine', () => {
    assert.equal(unwrapWayback('https://web.archive.org/web/20190101000000/http://www.example.com/a.html'), 'http://www.example.com/a.html');
    assert.equal(unwrapWayback('//web.archive.org/web/20190101000000im_/http://example.com/a.png'), 'http://example.com/a.png');
    assert.equal(unwrapWayback('/web/20190101000000/http://example.com/x'), 'http://example.com/x');
    assert.equal(unwrapWayback('https://web.archive.org/web/2019/example.com/x'), 'http://example.com/x');
    assert.equal(unwrapWayback('/about.php'), '/about.php');
    assert.equal(
      unwrapWaybackInText('url(https://web.archive.org/web/20190101000000im_/http://example.com/bg.png)'),
      'url(http://example.com/bg.png)',
    );
  });

  it('makes absolute links to the site root-relative without touching the rest', () => {
    const rel = makeRootRelative('example.com');
    assert.equal(rel('http://www.example.com/About.php?x=1#top'), '/About.php?x=1#top');
    assert.equal(rel('https://example.com'), '/');
    assert.equal(rel('//example.com?p=1'), '/?p=1');
    assert.equal(rel('http://other.com/a'), 'http://other.com/a');
    assert.equal(rel('http://example.com.evil.net/a'), 'http://example.com.evil.net/a');
    assert.equal(rel('relative/path.html'), 'relative/path.html');
  });

  it('parses dates into Wayback timestamps', () => {
    assert.equal(parseTimestamp('2019'), '20190101000000');
    assert.equal(parseTimestamp('2019-06'), '20190601000000');
    assert.equal(parseTimestamp('2019-06-12'), '20190612000000');
    assert.equal(parseTimestamp('2019-06', true), '20190631235959');
    assert.throws(() => parseTimestamp('June'));
  });
});

describe('archive index', () => {
  it('reads CDX JSON with a resume key', () => {
    const text = JSON.stringify([
      ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
      ['com,example)/', '20190101000000', 'http://example.com/', 'text/html', '200', 'AAA', '1234'],
      [],
      ['com,example)/about 20190101000000'],
    ]);
    const r = parseCdxJson(text);
    assert.equal(r.captures.length, 1);
    assert.equal(r.captures[0].length, 1234);
    assert.equal(r.resumeKey, 'com,example)/about 20190101000000');
    assert.deepEqual(parseCdxJson(''), { captures: [] });
  });
});

describe('charset', () => {
  it('decodes windows-1252 pages declared in a meta tag', () => {
    const body = Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>crème</p>', 'latin1');
    assert.equal(detectCharset(body, 'text/html'), 'windows-1252');
    assert.match(decodeText(body, 'text/html').text, /crème/);
  });
  it('falls back to windows-1252 when "UTF-8" bytes are not UTF-8', () => {
    const body = Buffer.from('<meta charset="utf-8"><p>caf\xe9</p>', 'latin1');
    assert.match(decodeText(body, '').text, /café/);
  });
  it('trusts the header charset', () => {
    const body = Buffer.from('<p>テスト</p>', 'utf8');
    assert.equal(detectCharset(body, 'text/html; charset=utf-8'), 'utf-8');
  });
});

describe('health', () => {
  const good = `<html lang="en"><head><title>Bakery</title></head><body>${'<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/d">d</a><a href="/e">e</a>'}<p>${'word '.repeat(300)}</p></body></html>`;

  it('scores a real page as good', () => {
    const s = analyzePage(good, 'http://example.com/', 'example.com');
    assert.equal(s.fatal, null);
    assert.equal(scoreSignals(s, {}).verdict, 'good');
  });
  it('recognizes parking, suspension and hosting pages', () => {
    const parked = analyzePage('<html><body><h1>example.com</h1><p>This domain may be for sale!</p></body></html>', 'http://example.com/', 'example.com');
    assert.match(parked.fatal ?? '', /parked/);
    const suspended = analyzePage('<html><body><h1>Account Suspended</h1><p>Contact your hosting provider.</p></body></html>', 'http://example.com/', 'example.com');
    assert.match(suspended.fatal ?? '', /hosting or error/);
    const moved = analyzePage('<html><head><meta http-equiv="refresh" content="0; url=http://spam.net/"></head><body></body></html>', 'http://example.com/', 'example.com');
    assert.match(moved.fatal ?? '', /spam\.net/);
  });
  it('flags spam that appeared after a new owner took over', () => {
    const spam = analyzePage(`<html lang="id"><body>${'<a href="/x">x</a>'.repeat(6)}<p>${'slot gacor casino judi togel '.repeat(10)}${'word '.repeat(200)}</p></body></html>`, 'http://example.com/', 'example.com');
    assert.equal(scoreSignals(spam, { baseSpam: 0, baseLang: 'en' }).verdict, 'bad');
  });
  it('does not call a long article that mentions "coming soon" dead', () => {
    const s = analyzePage(`<html><body>${'<a href="/x">x</a>'.repeat(6)}<p>New flavours coming soon. ${'word '.repeat(400)}</p></body></html>`, 'http://example.com/', 'example.com');
    assert.equal(s.fatal, null);
  });
});

describe('html', () => {
  it('rewrites CSS url() and @import', () => {
    const css = '@import "a.css"; body{background:url( "../img/bg.png" )} .x{background:url(data:image/png;base64,AAA)}';
    const out = rewriteCss(css, (u) => (u.startsWith('../') ? '/img/bg.png' : undefined));
    assert.match(out, /url\( "\/img\/bg\.png" \)/);
    assert.match(out, /data:image\/png/);
  });
  it('rewrites srcset entries', () => {
    const out = rewriteSrcset('http://example.com/a.jpg 1x, /b.jpg 2x', (u) => (u.startsWith('http') ? '/a.jpg' : undefined));
    assert.equal(out, '/a.jpg 1x, /b.jpg 2x');
  });
  it('removes old analytics and ads but leaves the site scripts', () => {
    const $ = loadHtml(`<head><script src="/js/site.js"></script><script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
<script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}gtag('config','G-1');</script></head>
<body><ins class="adsbygoogle"></ins><script src="//pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script></body>`);
    const stats = cleanDocument($, { stripTracking: true });
    assert.equal(stats.trackersRemoved, 4);
    assert.equal($('script[src="/js/site.js"]').length, 1);
  });
});

describe('meta', () => {
  it('reads post metadata and type', () => {
    const $ = loadHtml(`<html lang="en"><head><title>Rye | Bakery</title><meta property="og:type" content="article"></head>
<body><article><h1>Rye</h1><time datetime="2020-03-18">18 March</time><a rel="author" href="/author/m/">Maria</a>
<p>Rye has almost no gluten, so the dough behaves more like clay than like wheat dough does.</p>
<img src="/missing.jpg"><img src="/rye.jpg"><a rel="tag" href="/tag/bread/">Bread</a></article></body></html>`);
    const meta = extractMeta($, new URL('http://www.example.com/2020/03/rye/'), 'example.com', { hasPath: (p) => p === '/rye.jpg' });
    assert.equal(meta.type, 'post');
    assert.equal(meta.headline, 'Rye');
    assert.equal(meta.publishedAt, '2020-03-18T00:00:00Z');
    assert.equal(meta.author, 'Maria');
    assert.deepEqual(meta.tags, ['Bread']);
    assert.equal(meta.image, '/rye.jpg');
    assert.match(meta.description, /^Rye has almost no gluten/);
  });
  it('classifies archives and keeps query strings in the path', () => {
    const $ = loadHtml('<html><body><p>x</p></body></html>');
    assert.equal(extractMeta($, new URL('http://example.com/tag/bread/'), 'example.com').type, 'tag');
    assert.equal(extractMeta($, new URL('http://example.com/page/2/'), 'example.com').type, 'archive');
    assert.equal(extractMeta($, new URL('http://example.com/index.php?page=contact'), 'example.com').path, '/index.php?page=contact');
  });
  it('guesses the site name from shared title parts', () => {
    assert.equal(guessSiteName(['About | Bakery', 'Menu | Bakery', 'Blog | Bakery', 'Home'], 'Home', undefined, 'x.com'), 'Bakery');
    assert.equal(guessSiteName([], 'Bakery - fresh bread', undefined, 'x.com'), 'Bakery');
    assert.equal(guessSiteName([], '', 'Hint', 'x.com'), 'Hint');
  });
});

describe('file plan (URLs never change)', () => {
  const res = (url: string, contentType: string, sha1: string): Resource => {
    const u = new URL(url);
    return { key: urlKey(u), url, path: u.pathname + u.search, timestamp: '20200101000000', status: 200, contentType, file: sha1, sha1, via: 'link' };
  };
  const plan = (list: Resource[]) => {
    const kinds = new Map(list.map((r) => [r.key, r.contentType!.includes('html') ? ('html' as const) : r.contentType!.includes('css') ? ('css' as const) : ('other' as const)]));
    return Object.fromEntries(planFiles(list, kinds).map((p) => [p.res.path, p.route ? `${p.file} <- ${p.route.query ?? 'path'}` : p.file]));
  };

  it('maps each URL shape to a file that serves it at the same address', () => {
    const files = plan([
      res('http://example.com/', 'text/html', 'h1'),
      res('http://example.com/about/', 'text/html', 'h2'),
      res('http://example.com/about.php', 'text/html', 'h3'),
      res('http://example.com/blog/post', 'text/html', 'h4'),
      res('http://example.com/v1.2', 'text/html', 'h5'),
      res('http://example.com/index.php?page=contact', 'text/html', 'h6'),
      res('http://example.com/css/site.css?ver=2', 'text/css', 'c1'),
      res('http://example.com/img/a.png', 'image/png', 'i1'),
      res('http://example.com/thumb.php?id=3', 'image/jpeg', 'i2'),
      res('http://example.com/thumb.php?id=4', 'image/jpeg', 'i3'),
      res('http://example.com/photo', 'image/jpeg', 'i4'),
    ]);
    assert.equal(files['/'], 'index.html');
    assert.equal(files['/about/'], 'about/index.html');
    assert.equal(files['/about.php'], 'about.php');
    assert.equal(files['/blog/post'], 'blog/post.html');
    assert.equal(files['/v1.2'], 'v1.2.html');
    assert.match(files['/index.php?page=contact'], /^__wbd\/q\/[0-9a-f]{12}\.html <- page=contact$/);
    assert.equal(files['/css/site.css?ver=2'], 'css/site.css');
    assert.equal(files['/img/a.png'], 'img/a.png');
    assert.match(files['/thumb.php?id=3'], /^__wbd\/q\/[0-9a-f]{12}\.jpg <- id=3$/);
    assert.match(files['/thumb.php?id=4'], /^__wbd\/q\/[0-9a-f]{12}\.jpg <- id=4$/);
    assert.match(files['/photo'], /^__wbd\/f\/[0-9a-f]{12}\.jpg <- path$/);
  });

  it('keeps a file and a folder with the same name apart', () => {
    const files = plan([res('http://example.com/index.php', 'text/html', 'a'), res('http://example.com/index.php/about', 'text/html', 'b')]);
    assert.equal(files['/index.php/about'], 'index.php/about.html');
    assert.match(files['/index.php'], /^__wbd\/f\/.+\.html <- path$/);
  });

  it('shares identical files and separates different ones on a case-insensitive disk', () => {
    const files = plan([
      res('http://example.com/', 'text/html', 'same'),
      res('http://example.com/index.html', 'text/html', 'same'),
      res('http://example.com/About.html', 'text/html', 'x'),
      res('http://example.com/about.html', 'text/html', 'y'),
    ]);
    assert.equal(files['/'], 'index.html');
    assert.equal(files['/index.html'], 'index.html');
    assert.equal(files['/About.html'], 'About.html');
    assert.match(files['/about.html'], /^__wbd\/f\//);
  });
});

describe('php safety', () => {
  it('neutralizes "<?" outside scripts so PHP hosts print the page as is', () => {
    const r = phpSafe('<?xml version="1.0"?><p title="a<?b">x</p><script>var s="<?";</script>');
    assert.equal(r.html, '<p title="a&lt;?b">x</p><script>var s="<?";</script>');
    assert.equal(r.leftovers, 1);
  });
});

describe('server rules', () => {
  it('writes query-string rewrites and original redirects for Apache', () => {
    const text = htaccess({
      domain: 'example.com',
      host: 'example.com',
      routes: [{ path: '/index.php', rawPath: '/index.php', query: 'page=contact&x=1', file: '__wbd/q/abc.html' }],
      redirects: [
        { path: '/index.php', rawPath: '/index.php', noQuery: true, to: '/', status: 301 },
        { path: '/a b.html', rawPath: '/a%20b.html', to: '/x$1', status: 302 },
      ],
      types: [],
    });
    assert.match(text, /RewriteCond %\{QUERY_STRING\} "\^page=contact&x=1\$"\nRewriteRule "\^index\\\.php\$" "__wbd\/q\/abc\.html" \[L\]/);
    assert.match(text, /RewriteCond %\{QUERY_STRING\} \^\$\nRewriteRule "\^index\\\.php\$" "\/" \[R=301,NE,L\]/);
    assert.match(text, /RewriteRule "\^a b\\\.html\$" "\/x\\\$1" \[R=302,NE,L\]/);
  });
});
