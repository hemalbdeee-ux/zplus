import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { describe, it } from 'node:test';
import { cleanDocument } from '../src/engine/clean.ts';
import { loadHtml } from '../src/engine/html.ts';

const GA_LOADER = `(function() {
  var ga = document.createElement('script'); ga.async = true;
  ga.src = ('https:' == document.location.protocol ? 'https://ssl' : 'http://www') + '.google-analytics.com/ga.js';
  var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(ga, s);
})();`;

const inlineScripts = ($: ReturnType<typeof loadHtml>) => $('script:not([src])').toArray().map((el) => $(el).html() ?? '');
const stubbed = ($: ReturnType<typeof loadHtml>) => inlineScripts($).some((s) => s.includes('hitCallback'));

describe('tracker stripping keeps the site scripts (finding 10)', () => {
  it('keeps a site script that only calls a tracker, and stubs the tracker', () => {
    const $ = loadHtml(`<html><head></head><body><div class="slider"></div><script>
jQuery(function($){
  $('.slider').slick();
  $('#menu-toggle').on('click', function(){ $('nav').toggleClass('open'); });
  $('a.download').on('click', function(){ ga('send','event','Downloads'); });
});
</script><script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></body></html>`);
    const stats = cleanDocument($, { stripTracking: true });
    assert.equal(stats.trackersRemoved, 1);
    assert.ok(inlineScripts($).some((s) => s.includes(".slick()") && s.includes('#menu-toggle')));
    assert.ok(stubbed($), 'ga() calls must not throw once the loader is gone');
    assert.equal($('head script').first().html()?.includes('hitCallback'), true, 'stubs come before every other script');
  });

  it('cuts only the loader out of a block that mixes site code with the snippet', () => {
    const code = `function MM_swapImgRestore() { //v3.0
  var i,x,a=document.MM_sr; for(i=0;a&&i<a.length&&(x=a[i])&&x.oSrc;i++) x.src=x.oSrc;
}
var _gaq = _gaq || [];
_gaq.push(['_setAccount', 'UA-1-1']);
_gaq.push(['_trackPageview']);
${GA_LOADER}
function MM_swapImage() { document.MM_sr = []; }`;
    const $ = loadHtml(`<html><head><script>${code}</script></head><body><a onmouseover="MM_swapImage()" onclick="_gaq.push(['_trackEvent','x'])">x</a></body></html>`);
    const stats = cleanDocument($, { stripTracking: true });
    assert.equal(stats.trackersRemoved, 1);
    const site = inlineScripts($).find((s) => s.includes('MM_swapImgRestore'));
    assert.ok(site);
    assert.match(site, /function MM_swapImage\(\)/);
    assert.doesNotMatch(site, /google-analytics\.com/);
    assert.doesNotThrow(() => new Script(site));
    assert.ok(stubbed($));
  });

  it('keeps a site IIFE that wraps a snippet, without the snippet loader', () => {
    const $ = loadHtml(`<html><head><script>(function($){
  $('.slider').slick();
  (function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){(i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)})(window,document,'script','//www.google-analytics.com/analytics.js','ga');
  ga('create', 'UA-1-1', 'auto'); ga('send', 'pageview');
})(jQuery);</script></head><body></body></html>`);
    cleanDocument($, { stripTracking: true });
    const site = inlineScripts($).find((s) => s.includes('.slick()'));
    assert.ok(site);
    assert.doesNotMatch(site, /analytics\.js/);
    assert.doesNotThrow(() => new Script(site));
  });

  it('keeps a tracker call that carries site logic in a callback', () => {
    const $ = loadHtml(`<html><head><script>ga('send', 'pageview', { hitCallback: function() { initSite(); } });</script></head><body></body></html>`);
    cleanDocument($, { stripTracking: true });
    assert.ok(inlineScripts($).some((s) => s.includes('initSite')));
  });

  it('still removes whole tracker snippets', () => {
    const snippets = [
      `(function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;i[r]=i[r]||function(){
(i[r].q=i[r].q||[]).push(arguments)},i[r].l=1*new Date();a=s.createElement(o),
m=s.getElementsByTagName(o)[0];a.async=1;a.src=g;m.parentNode.insertBefore(a,m)
})(window,document,'script','https://www.google-analytics.com/analytics.js','ga');
ga('create', 'UA-1-1', 'auto');
ga('send', 'pageview');`,
      `<!--\nvar _gaq = _gaq || [];\n_gaq.push(['_setAccount', 'UA-1-1']);\n_gaq.push(['_trackPageview']);\n${GA_LOADER}\n//-->`,
      `try {\nvar pageTracker = _gat._getTracker("UA-1-1");\npageTracker._trackPageview();\n} catch(err) {}`,
      `window.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}\ngtag('js', new Date());\ngtag('config', 'G-1');`,
      `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1');
fbq('track', 'PageView');`,
      `(adsbygoogle = window.adsbygoogle || []).push({});`,
    ];
    for (const s of snippets) {
      const $ = loadHtml(`<html><head><script>${s}</script></head><body><p>x</p></body></html>`);
      assert.equal(cleanDocument($, { stripTracking: true }).trackersRemoved, 1, s);
      assert.deepEqual(
        inlineScripts($).filter((c) => !c.includes('hitCallback')),
        [],
        s,
      );
    }
  });

  it('adds nothing when there is no tracker', () => {
    const $ = loadHtml(`<html><head><script>var a = 1;</script></head><body></body></html>`);
    cleanDocument($, { stripTracking: true });
    assert.deepEqual(inlineScripts($), ['var a = 1;']);
  });
});

describe('Wayback artefacts are matched on the archive host only (finding 52)', () => {
  it('keeps the own files of a site on a *archive.org domain or under /_static/', () => {
    const $ = loadHtml(`<html><head>
<link rel="stylesheet" href="http://www.jazzarchive.org/static/css/main.css">
<script src="https://jazzarchive.org/includes/menu.js"></script>
<link rel="stylesheet" href="/_static/css/site.css"><script src="/_static/js/app.js"></script>
</head><body><div id="donato"><p>Donato's menu</p></div></body></html>`);
    const stats = cleanDocument($, { stripTracking: false });
    assert.equal(stats.waybackRemoved, 0);
    assert.equal($('link, script').length, 4);
    assert.equal($('#donato').length, 1);
  });

  it('still removes the toolbar on a page played back through the Wayback Machine', () => {
    const $ = loadHtml(`<html><head>
<script src="//archive.org/includes/analytics.js?v=1"></script>
<script src="https://web-static.archive.org/_static/js/bundle-playback.js"></script>
<link rel="stylesheet" href="/_static/css/banner-styles.css">
<script>__wm.init("https://web.archive.org/web");</script>
<link rel="stylesheet" href="/css/site.css">
</head><body><div id="donato"></div><p>x</p></body></html>`);
    const stats = cleanDocument($, { stripTracking: false });
    assert.equal(stats.waybackRemoved, 5);
    assert.deepEqual($('link').toArray().map((el) => $(el).attr('href')), ['/css/site.css']);
  });
});
