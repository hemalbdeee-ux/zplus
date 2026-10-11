// Regression tests for the second pass over round five of the HTML layer: the form Blink closes
// after an inner form, nested forms that share an id, loaders that set what they were handed,
// the charset prescan in <noscript> and repeated attributes, robots directives and canonicals.

import assert from 'node:assert/strict';
import { runInNewContext, Script } from 'node:vm';
import { describe, it } from 'node:test';
import * as cheerio from 'cheerio';
import { detectCharset } from '../src/engine/charset.ts';
import { cleanDocument } from '../src/engine/clean.ts';
import { loadHtml } from '../src/engine/html.ts';
import { extractMeta } from '../src/engine/meta.ts';

/** Each control and the form a browser gives it in the written page, and the forms in order. */
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

const LOGIN = `<form action="/login.php" method="post"><table><tr><td><input name="user"><input type="submit" value="Login"></form></td></tr></table>`;
const forms = (body: string) => browserForms(loadHtml(`<html><head><title>x</title></head><body>${body}</body></html>`).html());

describe('the form a </form> in a cell left open ends after the inner form, as in Blink (finding 14)', () => {
  // Owners as Chromium gives them on each original page.
  it('leaves the controls after the inner form out of the outer one', () => {
    const page = forms(`<table><tr><td>${LOGIN}
<form action="/search.php"><input name="q"><input type="submit" value="Search"></form>
<p>Jump: <select name="jump" onchange="location=this.value"><option value="/">Home</option></select></p>
<p><input type="image" name="print" src="print.gif" onclick="window.print()"> <button onclick="alert(1)">Help</button></p>
</td><td>content</td></tr></table>`);
    assert.equal(page.nested, 0);
    assert.deepEqual(page.owners, ['user->/login.php', 'Login->/login.php', 'q->/search.php', 'Search->/search.php', 'jump->-', 'print->-', 'undefined->-']);
    assert.deepEqual(page.forms, ['/login.php', '/search.php']);
  });

  it('keeps a later form a form of its own, in order', () => {
    const page = forms(`${LOGIN}<form action="/search.php"><input name="q"></form><p>Notes <input name="loose"></p><form action="/nl.php" method="post"><input name="email"></form><p><button name="b">B</button></p>`);
    assert.deepEqual(page.owners, ['user->/login.php', 'Login->/login.php', 'q->/search.php', 'loose->-', 'email->/nl.php', 'b->-']);
    assert.deepEqual(page.forms, ['/login.php', '/search.php', '/nl.php']);
  });

  it('closes only the form the inner one was in: three levels', () => {
    const page = forms(`${LOGIN}<form action="/b.php"><table><tr><td><input name="bb"></form></td></tr></table><form action="/c.php"><input name="cc"></form><p>after <input name="tail"></p>`);
    assert.deepEqual(page.owners, ['user->/login.php', 'Login->/login.php', 'bb->/b.php', 'cc->/c.php', 'tail->/login.php']);
    assert.deepEqual(page.forms, ['/login.php', '/b.php', '/c.php']);
  });

  it('closes it through a <font> or <span>, and opens the <font> again after it', () => {
    const out = loadHtml(`<html><body>${LOGIN}<font color="red"><form action="/c.php"><input name="c"></form> mid <input name="m"></font><span><form action="/d.php"><input name="d"></form>s<input name="s"></span></body></html>`).html();
    assert.deepEqual(browserForms(out).owners, ['user->/login.php', 'Login->/login.php', 'c->/c.php', 'm->-', 'd->/d.php', 's->-']);
    assert.match(out, /<\/form><form action="\/c\.php" id="wbd-form-\d" style="display:none !important"><\/form><font color="red"> mid <input name="m"><\/font>/);
  });

  it('keeps the outer form open when a block was still open in the inner one or around it', () => {
    assert.deepEqual(forms(`${LOGIN}<div><form action="/c.php"><input name="c"></form> mid <input name="m"></div><input name="t">`).owners, [
      'user->/login.php',
      'Login->/login.php',
      'c->/c.php',
      'm->/login.php',
      't->/login.php',
    ]);
    assert.deepEqual(forms(`${LOGIN}<form action="/c.php"><div><input name="c"></form> mid <input name="m"></div><input name="t">`).owners, [
      'user->/login.php',
      'Login->/login.php',
      'c->/c.php',
      'm->/c.php',
      't->/login.php',
    ]);
  });

  it('does not close a form whose own </form> had already taken it off the open elements', () => {
    const page = forms(`<form action="/a.php"><span><input name="a"></form><form action="/c.php"><input name="c"></form>more <input name="m"></span><input name="z">`);
    assert.deepEqual(page.owners, ['a->/a.php', 'c->/c.php', 'm->/a.php', 'z->-']);
  });
});

describe('a nested form that shares its id with another element still comes out (finding 14)', () => {
  it('gives one that is not the first with the id an id of its own; the block keeps the old one', () => {
    const out = loadHtml(`<html><body><form id="searchform" action="/s1"><input name="s"></form>
<div>${LOGIN}<div><form id="searchform" class="box" action="/s2" method="post"><input name="s2"><input type="submit" value="S2"></form></div></div></body></html>`).html();
    const page = browserForms(out);
    assert.equal(page.nested, 0);
    assert.deepEqual(page.owners, ['s->/s1', 'user->/login.php', 'Login->/login.php', 's2->/s2', 'S2->/s2']);
    assert.deepEqual(page.forms, ['/s1', '/login.php', '/s2']);
    assert.match(out, /<div class="box" id="searchform"><input name="s2" form="wbd-form-\d">/);
    assert.equal(cheerio.load(out)('#searchform').first().attr('action'), '/s1', 'getElementById still finds the first');
  });

  it('keeps the id on the moved form when it is the first, and nothing with the id comes before it then', () => {
    const page = forms(`<div>${LOGIN}<div><form id="searchform" action="/s2"><input name="s2"></form></div></div><form id="searchform" action="/s1"><input name="s"></form>`);
    assert.equal(page.nested, 0);
    assert.deepEqual(page.owners, ['user->/login.php', 'Login->/login.php', 's2->/s2', 's->/s1']);
  });

  it('moves both of two nested forms with one id', () => {
    const page = forms(`${LOGIN}<div><form id="s" action="/c1"><input name="c1"></form><form id="s" action="/c2"><input name="c2"></form></div><input name="z">`);
    assert.equal(page.nested, 0);
    assert.deepEqual(page.owners, ['user->/login.php', 'Login->/login.php', 'c1->/c1', 'c2->/c2', 'z->/login.php']);
  });

  it('keeps the class and style of the form on the block in its place', () => {
    const out = loadHtml(`${LOGIN}<div><form action="/in.php" class="searchbox" style="display:inline" onsubmit="return check()"><input name="q"></form></div>`).html();
    assert.match(out, /<div class="searchbox" style="display:inline"><input name="q" form="wbd-form-\d"><\/div>/);
  });
});

const GA = `var ga = document.createElement('script'); ga.async = true;
  ga.src = 'https://ssl.google-analytics.com/ga.js';
  var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(ga, s);`;

/** Runs the script before and after cleaning; what the site set up both times, and whether it was cut. */
function runCleaned(code: string) {
  const html = `<html><head></head><body><nav id="nav"></nav><script id="s">${code}</script></body></html>`;
  const run = (page: string) => {
    const $ = loadHtml(page);
    const nav: Record<string, unknown> = {};
    const el = () => ({ parentNode: { insertBefore() {} }, appendChild() {}, setAttribute() {} });
    const listeners: Array<() => void> = [];
    const document = { getElementById: () => nav, createElement: el, getElementsByTagName: () => [el()], head: el(), body: el(), addEventListener: (_: string, f: () => void) => listeners.push(f) };
    const jQuery = { fn: {} as Record<string, unknown> };
    const window: Record<string, unknown> = { document, jQuery, addEventListener: (_: string, f: () => void) => listeners.push(f) };
    window.window = window;
    for (const s of $('script').toArray()) runInNewContext($(s).html() ?? '', window);
    for (const f of listeners) f();
    const site = window.Site as Record<string, unknown> | undefined;
    return [typeof nav.onclick, typeof jQuery.fn.toggleNav, typeof site?.toggle, typeof window.toggleNav].join(',');
  };
  const $ = loadHtml(html);
  cleanDocument($, { stripTracking: true });
  const out = $('#s').html() ?? '';
  return { before: run(html), after: run($.html()), out };
}

describe('a loader only sets what it made itself (finding 16)', () => {
  it('keeps site code that sets a handler or plugin on what it looked up or was handed', () => {
    const cases: Record<string, string> = {
      lateAssign: `(function(){\n  var nav;\n  nav = document.getElementById('nav');\n  nav.onclick = function(){ nav.className = 'open'; };\n  ${GA}\n})();`,
      lateAssignIf: `(function(){\n  var nav = null;\n  if (document.getElementById) nav = document.getElementById('nav');\n  if (nav) nav.onclick = function(){ nav.className = 'open'; };\n  ${GA}\n})();`,
      elemParam: `(function(nav){\n  nav.onclick = function(){ nav.className = 'open'; };\n  ${GA}\n})(document.getElementById('nav'));`,
      jqParam: `(function($){\n  $.fn.toggleNav = function(){ return this; };\n  ${GA}\n})(jQuery);`,
      nsParam: `(function(ns){\n  ns.toggle = function(){};\n  ${GA}\n})(window.Site = window.Site || {});`,
      localFnCalled: `(function(){\n  var setup = function(){ window.toggleNav = function(){}; };\n  setup();\n  ${GA}\n})();`,
      localFnReady: `(function(){\n  var setup = function(){ window.toggleNav = function(){}; };\n  document.addEventListener('DOMContentLoaded', setup, false);\n  ${GA}\n})();`,
      madeElement: `(function(){\n  var b = document.createElement('a'); b.className = 'top'; b.onclick = function(){ scrollTo(0, 0); }; document.body.appendChild(b);\n  ${GA}\n})();`,
    };
    for (const [name, code] of Object.entries(cases)) {
      const { before, after, out } = runCleaned(code);
      assert.notEqual(out, '', `${name}: the script stays`);
      assert.doesNotMatch(out, /google-analytics/, name);
      assert.doesNotThrow(() => new Script(out), name);
      assert.equal(after, before, `${name}: the site sets up the same`);
    }
  });

  it('still removes real snippets whole, Yandex calling its own insert function too', () => {
    for (const code of [
      `(function (d, w, c) {
    (w[c] = w[c] || []).push(function() { try { w.yaCounter123 = new Ya.Metrika({id:123}); } catch(e) { } });
    var n = d.getElementsByTagName("script")[0], s = d.createElement("script"), f = function () { n.parentNode.insertBefore(s, n); };
    s.type = "text/javascript"; s.async = true; s.src = "https://mc.yandex.ru/metrika/watch.js";
    if (w.opera == "[object Opera]") { d.addEventListener("DOMContentLoaded", f, false); } else { f(); }
})(document, window, "yandex_metrika_callbacks");`,
      `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');`,
      `(function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){(i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)})(window,document,'script','https://www.google-analytics.com/analytics.js','ga');`,
      `(function(w,d,t,r,u){var f,n,i;w[u]=w[u]||[],f=function(){var o={ti:"123"};o.q=w[u],w[u]=new UET(o),w[u].push("pageLoad")},n=d.createElement(t),n.src=r,n.async=1,n.onload=n.onreadystatechange=function(){var s=this.readyState;s&&s!=="loaded"&&s!=="complete"||(f(),n.onload=n.onreadystatechange=null)},i=d.getElementsByTagName(t)[0],i.parentNode.insertBefore(n,i)})(window,document,"script","//bat.bing.com/bat.js","uetq");`,
      `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-XXXX');`,
    ]) {
      assert.equal(runCleaned(code).out, '', code);
    }
  });
});

describe("Twitter's pixel no longer loads (finding 16)", () => {
  it('turns the uwt.js address into an empty data: URL', () => {
    const { out } = runCleaned(`!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments);
},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',
a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');
twq('config','abc');`);
    assert.doesNotMatch(out, /ads-twitter\.com/);
    assert.match(out, /u\.src='data:,'/);
  });
});

describe('the charset prescan follows Chromium on <noscript> and repeated attributes (finding 15)', () => {
  const latin = (s: string) => Buffer.from(s, 'latin1');

  it('reads a declaration inside <noscript>', () => {
    const page = latin('<html><head><noscript><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"></noscript></head><body>\xcf\xf0\xe8\xe2\xe5\xf2</body></html>');
    assert.equal(detectCharset(page, 'text/html'), 'windows-1251');
  });

  it('takes the last of a repeated attribute, and a charset attribute over content=', () => {
    assert.equal(detectCharset(latin('<meta charset="windows-1250" charset="koi8-r"><p>\xe1</p>'), ''), 'koi8-r');
    assert.equal(detectCharset(latin('<meta http-equiv="refresh" http-equiv="content-type" content="text/html; charset=koi8-r"><meta charset="windows-1250"><p>\xe1</p>'), ''), 'koi8-r');
    assert.equal(detectCharset(latin('<meta content="text/html; charset=koi8-r" charset="windows-1250"><p>\xe1</p>'), ''), 'windows-1250');
  });

  it('reads <script/> as a script and ends a comment at --!>', () => {
    assert.equal(detectCharset(latin(`<script/>var a = '<meta charset="koi8-r">';</script><meta charset="windows-1250"><p>\xe1</p>`), ''), 'windows-1250');
    assert.equal(detectCharset(latin('<!-- x --!><meta charset="koi8-r"><!-- y --><meta charset="windows-1250"><p>\xe1</p>'), ''), 'koi8-r');
  });
});

const page = (head: string) => `<html><head><title>x</title>${head}</head><body><p>x</p></body></html>`;

describe('robots: "none" counts only as a directive of its own (finding 24)', () => {
  it('leaves a page with max-image-preview:none indexable', () => {
    for (const head of [
      '<meta name="robots" content="index, follow, max-image-preview:none">',
      '<meta name="robots" content="max-image-preview: none">',
      '<meta name="googlebot" content="max-image-preview:none">',
      '<meta name="robots" content="index"><template><meta name="robots" content="noindex"></template>',
    ]) {
      assert.equal(extractMeta(loadHtml(page(head)), new URL('http://example.com/a.html'), 'example.com').noindex, false, head);
    }
    for (const head of ['<meta name="robots" content="noarchive, none">', '<meta name="robots" content="noindex nofollow">']) {
      assert.equal(extractMeta(loadHtml(page(head)), new URL('http://example.com/a.html'), 'example.com').noindex, true, head);
    }
  });
});

describe('a canonical needs its exact address served (finding 23)', () => {
  it('does not take a bare path that only a query variant of it was captured as', () => {
    const $ = () => loadHtml(page('<link rel="canonical" href="http://example.com/item.php">'));
    const url = new URL('http://example.com/item.php?id=5&sid=8f2a');
    const hasPath = (p: string) => p === '/item.php' || p === '/item.php?id=5&sid=8f2a';
    assert.equal(extractMeta($(), url, 'example.com', { hasPath, isServed: (p) => p === '/item.php?id=5&sid=8f2a' }).canonicalPath, undefined);
    assert.equal(extractMeta($(), url, 'example.com', { hasPath, isServed: (p) => p === '/item.php' }).canonicalPath, '/item.php');
    assert.equal(extractMeta($(), url, 'example.com', { hasPath }).canonicalPath, '/item.php');
  });
});
