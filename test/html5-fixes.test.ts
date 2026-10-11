// Regression tests for round five of the HTML layer: forms the parser nested, pages nested past
// what the tree walkers can take, charset prescan, tracker cutting, and the SEO layer's robots,
// canonical and JSON-LD.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext, Script } from 'node:vm';
import { after, describe, it } from 'node:test';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { buildSite } from '../src/engine/build.ts';
import { decodeText, detectCharset } from '../src/engine/charset.ts';
import { cleanDocument } from '../src/engine/clean.ts';
import type { Manifest, Resource } from '../src/engine/crawl.ts';
import { loadHtml } from '../src/engine/html.ts';
import { extractMeta } from '../src/engine/meta.ts';
import { applySeo, type SiteContext } from '../src/engine/seo.ts';
import { pathAndQuery, urlKey } from '../src/engine/url.ts';

const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  for (const f of cleanup) await f();
});

/** Builds a site from captures; returns the build result and a reader for its files. */
async function build(captures: Array<{ url: string; type: string; body: string }>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wbd-html5-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'work', 'raw'), { recursive: true });
  const resources: Resource[] = [];
  for (const c of captures) {
    const u = new URL(c.url);
    const sha1 = createHash('sha1').update(c.body).digest('hex');
    await writeFile(path.join(dir, 'work', 'raw', sha1), c.body);
    resources.push({ key: urlKey(u), url: c.url, path: pathAndQuery(u), timestamp: '20200101000000', status: 200, contentType: c.type, file: sha1, sha1, via: 'link' });
  }
  const manifest: Manifest = { version: 1, domain: 'example.com', target: '20200101000000', window: {}, indexSize: resources.length, truncated: false, resources, missing: [] };
  const site = path.join(dir, 'site');
  const result = await buildSite(manifest, { domain: 'example.com', siteUrl: 'https://example.com', workDir: path.join(dir, 'work'), outDir: site, serverDir: path.join(dir, 'server'), stripTracking: true });
  return { result, read: (rel: string) => readFile(path.join(site, rel), 'utf8') };
}

/**
 * What a browser makes of the written page: each control's form (its form="" target, else the
 * form around it), the forms in document order, and how many forms sit inside another.
 */
function browserForms(html: string) {
  const $ = cheerio.load(html);
  const owners = $('input, button, select, textarea')
    .toArray()
    .map((el) => {
      const id = $(el).attr('form');
      const form = id !== undefined ? $(`[id="${id}"]`).first() : $(el).closest('form');
      return `${$(el).attr('name') ?? $(el).attr('value')}->${form.is('form') ? form.attr('action') : '-'}`;
    });
  return { owners, forms: $('form').toArray().map((f) => $(f).attr('action')), nested: $('form form').length };
}

describe('a form the parser left open no longer swallows the forms after it (finding 14)', () => {
  // Owners and forms as Chromium gives them for each original page.
  const cases: Array<[string, string, string[], string[]]> = [
    [
      '</form> in a cell, the form opened before the table',
      `<form action="/login.php" method="post"><table><tr><td>User</td><td><input name="user"></td></tr>
<tr><td colspan="2"><input type="submit" value="Log in"></form></td></tr></table>
<p>Search the site:</p><form action="/search.php" method="get"><input name="q"><input type="submit" value="Search"></form>`,
      ['user->/login.php', 'Log in->/login.php', 'q->/search.php', 'Search->/search.php'],
      ['/login.php', '/search.php'],
    ],
    [
      '</form> while a <font> is open',
      `<table><tr><td width="160">
<form action="/search.php"><font face="Verdana" size="1">Search<br><input name="q" size="12"> <input type="submit" value="Go"></form>
<form action="/newsletter.php" method="post">Newsletter<br><input name="email" size="12"> <input type="submit" value="Join"></form>
</font></td><td>content</td></tr></table>
<table><form action="/poll.php"><tr><td><input type="radio" name="vote" value="1"> Yes <input type="submit" value="Vote"></td></tr></form></table>`,
      ['q->/search.php', 'Go->/search.php', 'email->/newsletter.php', 'Join->/newsletter.php', 'vote->/poll.php', 'Vote->/poll.php'],
      ['/search.php', '/newsletter.php', '/poll.php'],
    ],
    [
      'a form placed in a table after the open form',
      `<form action="/login.php" method="post"><table><tr><td><input name="user"> <input type="submit" value="Log in"></form></td></tr></table>
<table><form action="/search.php"><tr><td><input name="q"> <input type="submit" value="Search"></td></tr></form></table>`,
      ['user->/login.php', 'Log in->/login.php', 'q->/search.php', 'Search->/search.php'],
      ['/login.php', '/search.php'],
    ],
    [
      'a PayPal button followed by a site search',
      `<form action="https://www.paypal.com/cgi-bin/webscr" method="post"><table><tr><td><input type="hidden" name="cmd" value="_s-xclick"><input type="image" name="buy" src="b.gif"></form></td></tr></table>
<form method="get" action="https://www.google.com/search"><input name="q"><input type="hidden" name="sitesearch" value="example.com"><input type="submit" value="Google"></form>`,
      ['cmd->https://www.paypal.com/cgi-bin/webscr', 'buy->https://www.paypal.com/cgi-bin/webscr', 'q->https://www.google.com/search', 'sitesearch->https://www.google.com/search', 'Google->https://www.google.com/search'],
      ['https://www.paypal.com/cgi-bin/webscr', 'https://www.google.com/search'],
    ],
  ];

  it('gives every control the form a browser gave it on the original page', () => {
    for (const [name, body, owners, forms] of cases) {
      const out = loadHtml(`<html><head><title>x</title></head><body>${body}</body></html>`).html();
      const seen = browserForms(out);
      assert.equal(seen.nested, 0, name);
      assert.deepEqual(seen.owners, owners, name);
      assert.deepEqual(seen.forms, forms, `${name}: document.forms keeps its order`);
    }
  });

  it('leaves what the inner form held where it was, in a block, and hides the moved form', () => {
    const out = loadHtml(`<html><body>${cases[1][1]}</body></html>`).html();
    assert.match(out, /<td width="160">[\s\S]*<div>Newsletter<br><input name="email" size="12" form="wbd-form-\d"> <input type="submit" value="Join" form="wbd-form-\d"><\/div>[\s\S]*<\/td><td>content/);
    assert.match(out, /<\/form><form action="\/newsletter\.php" method="post" id="wbd-form-\d" style="display:none !important"><\/form><\/td>/);
  });

  it('keeps the id a nested form had, so form="" and scripts still find it', () => {
    const out = loadHtml(`<form action="/a"><table><tr><td><input name="a"></form></td></tr></table><form action="/b" id="search" name="s"><input name="q"></form>`).html();
    assert.match(out, /<form action="\/b" id="search" name="s" style="display:none !important"><\/form>/);
    assert.deepEqual(browserForms(out).owners, ['a->/a', 'q->/b']);
  });
});

describe('a page nested thousands deep is flattened the way Blink does (finding 18)', () => {
  const guestbook = (n: number, form = '') =>
    `<html><head><title>Guestbook</title></head><body>${form}${Array.from({ length: n }, (_, i) => `<div class="entry"><b>Visitor ${i}</b> wrote:<br><font color="#333366">Great site!`).join('\n')}</body></html>`;
  const depth = (root: AnyNode) => {
    let max = 0;
    const todo: Array<[AnyNode, number]> = [[root, 0]];
    while (todo.length) {
      const [n, d] = todo.pop()!;
      max = Math.max(max, d);
      if ('children' in n) for (const c of n.children) todo.push([c, d + 1]);
    }
    return max;
  };

  it('keeps every entry and no element deeper than 513 levels', () => {
    for (const form of ['', '<form action="/sign.cgi"><input name="x">']) {
      const $ = loadHtml(guestbook(3000, form));
      assert.ok(depth($.root().get(0)!) <= 514, form);
      const text = $('body').text();
      for (const i of [0, 511, 512, 2999]) assert.ok(text.includes(`Visitor ${i}`), `${form} ${i}`);
      assert.doesNotThrow(() => $.html());
      assert.doesNotThrow(() => extractMeta($, new URL('http://example.com/guestbook.html'), 'example.com'));
    }
  });

  it('keeps text in the element that was open for it, as Blink does', () => {
    const $ = loadHtml(`<body>${'<div>'.repeat(600)}<b>x</b>tail${'</div>'.repeat(600)}</body>`);
    // What Chromium makes of the same markup.
    assert.equal($('b').parent().children().length, 91, 'the deep divs and the b sit side by side in the div at level 512');
    assert.equal($('b').parents().length, 512);
    assert.equal($('b').text(), 'x');
    assert.equal($('b').prev().text(), 'tail', 'the text stays in the div it was written in');
  });

  it('builds the site when one page is a guestbook of 1,500 unclosed entries', async () => {
    const { read } = await build([
      { url: 'http://example.com/', type: 'text/html', body: '<html><head><title>Home</title></head><body><p>hi</p></body></html>' },
      { url: 'http://example.com/guestbook.html', type: 'text/html', body: guestbook(1500) },
    ]);
    const out = await read('guestbook.html');
    assert.match(out, /Visitor 1499<\/b>/);
  });
});

describe('the charset prescan reads tags as browsers do (finding 15)', () => {
  const utf8 = (s: string) => Buffer.from(s, 'utf8');
  const latin = (s: string) => Buffer.from(s, 'latin1');

  it('skips a declaration left in a comment', () => {
    const body = utf8('<html><head><!-- <meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"> --><meta charset="utf-8"><title>Café</title></head><body><p>Crème brûlée</p></body></html>');
    assert.equal(detectCharset(body, 'text/html'), 'utf-8');
    assert.match(decodeText(body, '').text, /<title>Café<\/title>.*<p>Crème brûlée<\/p>/);
  });

  it('takes charset= from content only with http-equiv="Content-Type"', () => {
    assert.equal(detectCharset(utf8('<meta name="keywords" content="charset=iso-8859-1, foo"><meta charset="utf-8"><p>Café</p>'), ''), 'utf-8');
    assert.equal(detectCharset(latin('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>Caf\xe9</p>'), ''), 'windows-1252');
    assert.equal(detectCharset(latin('<META CONTENT=text/html;charset=windows-1251 HTTP-EQUIV=content-type><p>\xc3\xeb</p>'), ''), 'windows-1251');
  });

  it('does not read a <meta> inside an attribute value or a script', () => {
    assert.equal(detectCharset(utf8('<img alt="<meta charset=shift_jis>"><meta charset=utf-8><p>Café</p>'), ''), 'utf-8');
    assert.equal(detectCharset(latin(`<script>if (a<b) s = "<meta charset='utf-8'>";</script><meta charset="windows-1251"><p>\xc3\xeb</p>`), ''), 'windows-1251');
  });
});

const TRACKER_HOST = /google-analytics\.com|googletagmanager\.com/;

/** Cleans a page that holds the one script; what is left of it ('' when it went whole) and whether the stubs went in. */
function clean(code: string): { out: string; stubbed: boolean } {
  const $ = loadHtml(`<html><head></head><body><a href="#" onclick="toggleNav(); return false">Menu</a><script id="s">${code}</script></body></html>`);
  cleanDocument($, { stripTracking: true });
  return { out: $('#s').html() ?? '', stubbed: $('script:not([src])').toArray().some((el) => ($(el).html() ?? '').includes('hitCallback')) };
}

function assertSiteKept(code: string, keep: RegExp[]): string {
  const { out, stubbed } = clean(code);
  for (const re of keep) assert.match(out, re, code);
  assert.doesNotMatch(out, TRACKER_HOST, code);
  assert.doesNotThrow(() => new Script(out), code);
  assert.ok(stubbed, code);
  return out;
}

describe("a site function that sets globals or handlers is not taken for a tracker's loader (finding 16)", () => {
  const ga = `var ga = document.createElement('script'); ga.async = true; ga.src = ('https:' == document.location.protocol ? 'https://ssl' : 'http://www') + '.google-analytics.com/ga.js';
  var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(ga, s);`;
  const gtm = `var g = d.createElement('script'); g.async = true; g.src = '//www.googletagmanager.com/gtm.js?id=GTM-ABC';
  d.getElementsByTagName('head')[0].appendChild(g);`;

  it('keeps what the site sets on the window or on its elements, and cuts only the loader', () => {
    const cases: Array<[string, RegExp]> = [
      [`(function(){\n  window.toggleNav = function(){ document.getElementById('nav').classList.toggle('open'); };\n  ${ga}\n})();`, /window\.toggleNav = function/],
      [`(function(){\n  window.onload = function(){ initSlider(); };\n  ${ga}\n})();`, /window\.onload = function/],
      [`(function(){\n  window.siteConfig = { lang: 'de', cart: '/warenkorb/' };\n  window.dataLayer = window.dataLayer || [];\n  ${ga}\n})();`, /window\.siteConfig = \{/],
      [`(function(){\n  window.App = { base: '/shop/' };\n  App.toggle = function(id){ document.getElementById(id).hidden ^= 1; };\n  ${ga}\n})();`, /App\.toggle = function/],
      [`(function(d){\n  var nav = d.getElementById('nav');\n  nav.onclick = function(){ nav.className = 'open'; };\n  ${gtm}\n})(document);`, /nav\.onclick = function/],
      [`(function(d){\n  var nav = d.getElementById('nav');\n  if (nav) { nav.onclick = function(){ nav.className = 'open'; }; }\n  ${gtm}\n})(document);`, /nav\.onclick = function/],
      [`(function(w, d){\n  w.toggleNav = function(){};\n  ${gtm}\n})(window, document);`, /w\.toggleNav = function/],
    ];
    for (const [code, keep] of cases) assert.match(assertSiteKept(code, [keep]), /^\(function\(/, code);
  });

  it('still removes a Hotjar snippet whole', () => {
    const { out } = clean(`(function(h,o,t,j,a,r){ h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)}; h._hjSettings={hjid:1,hjsv:6}; a=o.getElementsByTagName('head')[0]; r=o.createElement('script');r.async=1; r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv; a.appendChild(r); })(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');`);
    assert.equal(out, '');
  });
});

describe('a tracker address handed to another loader goes on its own (finding 17)', () => {
  it('keeps the site code and turns the address into an empty data: URL', () => {
    const cases: Array<[string, RegExp[]]> = [
      [
        `jQuery(function($){
  $('.menu-toggle').click(function(){ $('nav').toggleClass('open'); });
  $('.slider').slick({ autoplay: true });
  $.getScript('//www.google-analytics.com/analytics.js', function(){ ga('create','UA-1-1','auto'); ga('send','pageview'); });
});`,
        [/\.slick\(/, /menu-toggle/, /\$\.getScript\('data:,', function/],
      ],
      [
        `function loadScript(src){ var s=document.createElement('script'); s.async=true; s.src=src; document.head.appendChild(s); }
document.getElementById('cookie-accept').addEventListener('click', function(){
  document.cookie = 'consent=1; path=/';
  document.getElementById('cookie-banner').style.display = 'none';
  loadScript("https://www.googletagmanager.com/gtag/js?id=G-ABC123");
  gtag('config', 'G-ABC123');
});`,
        [/cookie-banner'\)\.style\.display = 'none'/, /loadScript\("data:,"\)/],
      ],
      [`loadJS('/js/site.min.js');\nwindow.ga=window.ga||function(){(ga.q=ga.q||[]).push(arguments)};\nga('create', 'UA-1-1', 'auto');\nloadJS(\`https://www.google-analytics.com/analytics.js\`);`, [/loadJS\('\/js\/site\.min\.js'\)/, /loadJS\(`data:,`\)/]],
    ];
    for (const [code, keep] of cases) assertSiteKept(code, keep);
  });
});

describe('a cut loader leaves a ; so the statements around it stay apart (finding 20)', () => {
  const FBQ = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');`;

  it('runs the site code before and after the snippet', () => {
    for (const code of [
      `var siteName = 'Example'\n${FBQ}\n(function(){ window.ok = siteName })()\nfbq('init', '1');`,
      `var x = 'Example'\n${FBQ}\n['Example'].forEach(function(n){ window.ok = n })\nfbq('init', '1');`,
      `var cfg = { a: 'Example' }\n${FBQ}\n(function(){ window.ok = cfg.a })()\nfbq('init', '1');`,
      `if (true) {\n  var siteName = 'Example'\n  ${FBQ}\n  (function(){ window.ok = siteName })()\n}\nfbq('init', '1');`,
    ]) {
      const { out } = clean(code);
      assert.doesNotMatch(out, /facebook\.net/, code);
      const sandbox: Record<string, unknown> = { fbq() {} };
      sandbox.window = sandbox;
      runInNewContext(out, sandbox);
      assert.equal(sandbox.ok, 'Example', code);
    }
  });
});

const SITE: SiteContext = { siteUrl: 'https://example.com', siteName: 'Example' };
const metaOf = (html: string, url: string, hasPath?: (p: string) => boolean) => extractMeta(loadHtml(html), new URL(url), 'example.com', { hasPath });

describe('robots: every robots and googlebot meta counts, and "none" is noindex (finding 24)', () => {
  it('reads noindex from any of them', () => {
    for (const head of [
      '<meta name="robots" content="none">',
      '<meta name="robots" content="index, follow"><meta name="robots" content="noindex, follow">',
      '<meta name="googlebot" content="noindex">',
      '<meta name="ROBOTS" content="NOINDEX">',
    ]) {
      assert.equal(metaOf(`<html><head><title>x</title>${head}</head><body><p>x</p></body></html>`, 'http://example.com/a.html').noindex, true, head);
    }
    assert.equal(metaOf('<html><head><meta name="robots" content="index, follow"><meta name="googlebot" content="nosnippet"></head></html>', 'http://example.com/a.html').noindex, false);
  });
});

describe('an original canonical is kept only when the restored site has its target (finding 23)', () => {
  const html = (href: string) => `<html><head><title>Hello</title><link rel="canonical" href="${href}"><meta property="article:published_time" content="2019-05-03"></head><body><article><p>Hi</p></article></body></html>`;

  it('falls back to the page itself when the target was not restored', () => {
    const has = (p: string) => p === '/?p=12' || p === '/about/';
    assert.equal(metaOf(html('http://example.com/2019/05/hello-world/'), 'http://example.com/?p=12', has).canonicalPath, undefined);
    assert.equal(metaOf(html('http://example.com/about/'), 'http://example.com/?p=12', has).canonicalPath, '/about/');
    assert.equal(metaOf(html('/?p=12'), 'http://example.com/?p=12', () => false).canonicalPath, '/?p=12');
  });

  it('writes the page as its own canonical and lists it in the sitemap', async () => {
    const { read } = await build([
      { url: 'http://example.com/', type: 'text/html', body: '<html><head><title>Home</title></head><body><p>hi</p></body></html>' },
      { url: 'http://example.com/?p=12', type: 'text/html', body: html('http://example.com/2019/05/hello-world/') },
    ]);
    const files = await Promise.all(['sitemap-pages.xml', 'sitemap-posts.xml'].map((f) => read(f).catch(() => '')));
    assert.match(files.join(''), /<loc>https:\/\/example\.com\/\?p=12<\/loc>/);
  });
});

describe('JSON-LD: a page keeps its own article unless the seo-head writes one, and no name is empty (findings 22, 26)', () => {
  const ldTypes = ($: ReturnType<typeof loadHtml>) =>
    $('script[type="application/ld+json"]')
      .toArray()
      .flatMap((el) => [JSON.parse($(el).html() ?? '')].flat())
      .map((o: Record<string, unknown>) => o['@type']);
  const article = { '@context': 'https://schema.org', '@type': 'Article', headline: 'Pruning roses', author: { '@type': 'Person', name: 'Ann Gardner' }, datePublished: '2018-04-02' };

  it('keeps the Article of a WordPress static page and of an undated news story', () => {
    for (const [body, url] of [
      ['<body class="page page-id-42"><article class="type-page"><h1>Pruning roses</h1><p>Cut back in early spring.</p></article></body>', 'http://example.com/guides/pruning-roses/'],
      ['<body><h1>Pruning roses</h1><p>Cut back in early spring.</p></body>', 'http://example.com/news/big-story'],
    ]) {
      const ld = body.includes('page-id') ? article : { ...article, '@type': 'NewsArticle', datePublished: undefined };
      const $ = loadHtml(`<html><head><title>Pruning roses</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head>${body}</html>`);
      const meta = extractMeta($, new URL(url), 'example.com');
      assert.equal(meta.type, 'page', url);
      applySeo($, meta, SITE);
      assert.deepEqual(ldTypes($), [ld['@type'], 'WebPage', 'BreadcrumbList'], url);
      assert.match($.html(), /"name": ?"Ann Gardner"/, url);
    }
  });

  it("still replaces a post's own Article with the seo-head one", () => {
    const $ = loadHtml(`<html><head><title>Pruning roses</title><script type="application/ld+json">${JSON.stringify(article)}</script></head><body><article><h1>Pruning roses</h1></article></body></html>`);
    const meta = extractMeta($, new URL('http://example.com/2018/04/02/pruning-roses/'), 'example.com');
    assert.equal(meta.type, 'post');
    applySeo($, meta, SITE);
    assert.deepEqual(ldTypes($), ['Article', 'BreadcrumbList']);
  });

  it('names an untitled page after the site, as og:title does, and gives it no breadcrumb trail', () => {
    for (const head of ['', '<title></title>', '<title> </title>']) {
      const $ = loadHtml(`<html><head>${head}</head><body><a href="/a.html">A</a> <a href="/b.html">B</a></body></html>`);
      applySeo($, extractMeta($, new URL('http://example.com/menu.html'), 'example.com'), SITE);
      const out = $.html();
      assert.doesNotMatch(out, /"(?:name|headline)": ""/, head);
      assert.match(out, /"@type": "WebPage",\s*"name": "Example"/, head);
      assert.match(out, /<meta property="og:title" content="Example">/, head);
      assert.deepEqual(ldTypes($), ['WebPage'], head);
    }
  });
});
