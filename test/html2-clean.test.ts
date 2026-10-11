import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { describe, it } from 'node:test';
import { cleanDocument } from '../src/engine/clean.ts';
import { loadHtml } from '../src/engine/html.ts';

// analytics.js, without the ; after it.
const UA_LOADER = `(function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){(i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)})(window,document,'script','https://www.google-analytics.com/analytics.js','ga')`;
const UA = `${UA_LOADER};\nga('create', 'UA-1-1', 'auto');\nga('send', 'pageview');`;
const MM = `function MM_swapImgRestore() { var i,x,a=document.MM_sr; for(i=0;a&&i<a.length&&(x=a[i])&&x.oSrc;i++) x.src=x.oSrc; }
function MM_swapImage() { var i,j=0,x,a=MM_swapImage.arguments; document.MM_sr=new Array; for(i=0;i<(a.length-2);i+=3) if ((x=MM_findObj(a[i]))!=null){document.MM_sr[j++]=x; if(!x.oSrc) x.oSrc=x.src; x.src=a[i+2];} }`;
const TRACKER_HOST = /google-analytics\.com|googletagmanager\.com|mc\.yandex\.ru|connect\.facebook\.net|snap\.licdn\.com|bat\.bing\.com|statcounter\.com\/counter/;

const inlineScripts = ($: ReturnType<typeof loadHtml>) => $('script:not([src])').toArray().map((el) => $(el).html() ?? '');
const siteScripts = ($: ReturnType<typeof loadHtml>) => inlineScripts($).filter((s) => !s.includes('hitCallback'));

/** Cleans a page that holds the one script, and returns what is left of it ('' when it went whole). */
function clean(code: string, head = ''): { out: string; removed: number; stubbed: boolean } {
  const $ = loadHtml(`<html><head>${head}</head><body><script id="s">${code}</script></body></html>`);
  const removed = cleanDocument($, { stripTracking: true }).trackersRemoved;
  return { out: $('#s').html() ?? '', removed, stubbed: inlineScripts($).some((s) => s.includes('hitCallback')) };
}

function assertSiteKept(code: string, keep: RegExp[], head = ''): string {
  const { out, stubbed } = clean(code, head);
  for (const re of keep) assert.match(out, re, code);
  assert.doesNotMatch(out, TRACKER_HOST, code);
  assert.doesNotThrow(() => new Script(out), code);
  assert.ok(stubbed, code);
  return out;
}

describe('a tracker snippet right after a function or block keeps the site code (finding 10, round 2)', () => {
  it('keeps the Dreamweaver rollovers written straight before the analytics.js snippet', () => {
    const out = assertSiteKept(`${MM}\n${UA}`, [/function MM_swapImage\b/, /function MM_swapImgRestore\b/]);
    assert.match(out, /ga\('send', 'pageview'\)/, 'the calls stay; the stubs absorb them');
  });

  it('keeps a German GA opt-out function written before the snippet', () => {
    assertSiteKept(
      `var gaProperty = 'UA-1-1';
var disableStr = 'ga-disable-' + gaProperty;
if (document.cookie.indexOf(disableStr + '=true') > -1) { window[disableStr] = true; }
function gaOptout() { document.cookie = disableStr + '=true; path=/'; window[disableStr] = true; alert('Tracking deaktiviert'); }
${UA}`,
      [/function gaOptout\b/],
    );
  });

  it('keeps the site code between a gtag declaration and its config calls', () => {
    const code = `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
(function($){ $('.slider').slick(); $('#menu-toggle').on('click', function(){ $('nav').toggleClass('open'); }); })(jQuery);
gtag('js', new Date());
gtag('config', 'G-ABC123');`;
    const { out, removed, stubbed } = clean(code, '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>');
    assert.equal(out, code);
    assert.equal(removed, 1, 'only the gtag.js script tag');
    assert.ok(stubbed);
  });

  it('ends a statement at the } of any block statement or declaration', () => {
    const before = [
      `if (window.x) { siteInit(); }`,
      `if (a) { siteA(); } else { siteInit(); }`,
      `for (var i = 0; i < 3; i++) { siteInit(i); }`,
      `while (queue.length) { siteInit(queue.shift()); }`,
      `do { siteInit(); } while (more())`,
      `try { siteInit(); } catch (e) {}`,
      `try { siteInit(); } finally { done(); }`,
      `switch (location.hash) { case '#a': siteInit(); break; }`,
      `{ siteInit(); }`,
      `outer: { siteInit(); break outer; }`,
      `class Menu { open() { siteInit(); } }`,
      `async function load() { await siteInit(); }`,
      `function* steps() { yield siteInit(); }`,
      `const go = () => { siteInit(); }`,
      `function siteInit() { document.body.className += ' js'; }\n['nav', 'footer'].forEach(function (id) { siteInit(id); });`,
    ];
    for (const site of before) {
      assertSiteKept(`${site}\n${UA}`, [/siteInit/]);
      // On one line too, except after an arrow function, which JavaScript then cannot parse.
      if (!site.includes('=>')) assertSiteKept(`${site} ${UA_LOADER}\nsiteInit();`, [/siteInit/]);
    }
  });

  it('keeps an if and its else together when the branches have no braces', () => {
    assertSiteKept(`if (a) siteA(); else siteB();\n${UA}`, [/if \(a\) siteA\(\); else siteB\(\);/]);
    // The loader is the branch: an empty statement takes its place, so the else still has its if.
    const out = assertSiteKept(`if (location.hostname == 'example.com') ${UA_LOADER}; else console.log('dev');\n${MM}`, [
      /function MM_swapImage\b/,
      /else console\.log\('dev'\)/,
    ]);
    assert.match(out, /^if \(location\.hostname == 'example\.com'\) ; else/);
  });
});

describe('a loader is only what loads the tracker (finding 10, round 2)', () => {
  it('keeps a site function whose if, for, while or try blocks run site code', () => {
    const loader = `var ga = document.createElement('script'); ga.async = true; ga.src = 'https://www.google-analytics.com/ga.js';
  var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(ga, s);`;
    const cases: Array<[string, RegExp]> = [
      [`var nav = document.getElementById('nav');\n  if (nav) { nav.className += ' js'; initDropdowns(nav); }`, /initDropdowns\(nav\)/],
      [`var items = document.querySelectorAll('.item');\n  for (var i = 0; i < items.length; i++) { items[i].onclick = openItem; }`, /items\[i\]\.onclick = openItem/],
      [`var el = document.getElementById('news'), n = 0;\n  while (n < 3) { el.children[n].className = 'show'; n++; }`, /className = 'show'/],
      [`try { initSlider(); } catch (e) {}`, /initSlider\(\)/],
      [`var menu = initMenu();`, /initMenu\(\)/],
    ];
    for (const [site, keep] of cases) {
      const out = assertSiteKept(`(function(){\n  ${site}\n  ${loader}\n})();\n_gaq.push(['_trackPageview']);`, [keep]);
      assert.match(out, /^\(function\(\)\{/, site);
    }
  });

  it('keeps a cookie banner that loads gtag.js once the visitor agrees', () => {
    assertSiteKept(
      `(function(){
  var consent = localStorage.getItem('consent');
  if (consent === null) { document.getElementById('cookie-banner').style.display = 'block'; }
  if (consent === 'yes') { var s = document.createElement('script'); s.src = 'https://www.googletagmanager.com/gtag/js?id=G-1'; document.head.appendChild(s); }
})();
document.getElementById('accept').onclick = function(){ localStorage.setItem('consent','yes'); gtag('consent', 'update', {}); };`,
      [/cookie-banner/, /getElementById\('accept'\)/],
    );
  });

  it('still removes whole snippets that check for themselves first', () => {
    const snippets = [
      `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');\nfbq('init', '1');`,
      `(function (d, w, c) {
  (w[c] = w[c] || []).push(function() { try { w.yaCounter123 = new Ya.Metrika({id:123}); } catch(e) { } });
  var n = d.getElementsByTagName("script")[0], s = d.createElement("script"), f = function () { n.parentNode.insertBefore(s, n); };
  s.type = "text/javascript"; s.async = true; s.src = "https://mc.yandex.ru/metrika/watch.js";
  if (w.opera == "[object Opera]") { d.addEventListener("DOMContentLoaded", f, false); } else { f(); }
})(document, window, "yandex_metrika_callbacks");`,
      `(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();
for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");\nym(1, "init", {});`,
      `(function(w,d,t,r,u){var f,n,i;w[u]=w[u]||[],f=function(){var o={ti:"1"};o.q=w[u],w[u]=new UET(o),w[u].push("pageLoad")},n=d.createElement(t),n.src=r,n.async=1,n.onload=n.onreadystatechange=function(){var s=this.readyState;s&&s!=="loaded"&&s!=="complete"||(f(),n.onload=n.onreadystatechange=null)},i=d.getElementsByTagName(t)[0],i.parentNode.insertBefore(n,i)})(window,document,"script","//bat.bing.com/bat.js","uetq");`,
    ];
    for (const s of snippets) {
      const { out, removed } = clean(s);
      assert.equal(out, '', s);
      assert.equal(removed, 1, s);
      // Behind the site's own code, only the snippet goes.
      assertSiteKept(`${MM}\n${s}`, [/function MM_swapImage\b/]);
    }
    assertSiteKept(
      `${MM}\n(function(l) { if (!l){window.lintrk = function(a,b){window.lintrk.q.push([a,b])}; window.lintrk.q=[]} var s = document.getElementsByTagName("script")[0]; var b = document.createElement("script"); b.async = true; b.src = "https://snap.licdn.com/li.lms-analytics/insight.min.js"; s.parentNode.insertBefore(b, s);})(window.lintrk);\nwindow.lintrk('track');`,
      [/function MM_swapImage\b/],
    );
  });

  it('keeps a document.write that only links to a tracker site', () => {
    for (const code of [
      `document.write('<p class="foot"><a href="/about.html">About</a> | <a href="https://statcounter.com/" target="_blank">stats</a></p>');`,
      `document.writeln("<a href=\\"https://statcounter.com/p1/\\">stats</a> <a href=\\"/contact.html\\">Contact</a>");\nvar sc_project = 1; var sc_invisible = 1;`,
    ]) {
      const { out, removed } = clean(code);
      assert.equal(out, code);
      assert.equal(removed, 0);
    }
  });

  it('still cuts a document.write that loads a counter script or image', () => {
    for (const write of [
      `document.write(unescape("%3Cscript src='" + gaJsHost + "google-analytics.com/ga.js' type='text/javascript'%3E%3C/script%3E"));`,
      `document.write("<sc"+"ript type='text/javascript' src='" + scJsHost + "statcounter.com/counter/counter.js'></"+"script>");`,
      `document.write('<a href="https://statcounter.com/"><img src="https://c.statcounter.com/1/0/abc/1/" alt="stats"></a>');`,
    ]) {
      const out = assertSiteKept(`${MM}\n${write}`, [/function MM_swapImage\b/]);
      assert.doesNotMatch(out, /document\.write/, write);
    }
  });
});

describe('reading the script (finding 10, round 2)', () => {
  it('reads n++ / 2 as a division', () => {
    assertSiteKept(`var n = 3; var half = n++ / 2;\nfunction openMenu(){ document.body.classList.add('menu'); }\n${UA}`, [/function openMenu\b/, /n\+\+ \/ 2/]);
  });

  it('does not count a tracker URL in a comment when the script does not lex', () => {
    // The tokenizer takes /'/ after if (x) for a division, then a string that never ends.
    const code = `/* GA comes from https://www.google-analytics.com/analytics.js */\nif (x) /'/.test(s) && go();\nfunction track(e){ ga('send', 'event', e); }\nfunction openMenu(){ document.body.classList.add('menu'); }`;
    const { out, stubbed } = clean(code);
    assert.equal(out, code);
    assert.ok(stubbed);
  });
});
