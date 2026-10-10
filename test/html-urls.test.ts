import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectUrls, cssUrls, loadHtml, rewriteCss, rewriteSrcset, visitUrls } from '../src/engine/html.ts';
import { makeRootRelative, unwrapWayback } from '../src/engine/url.ts';

describe('CSS url() scanning is linear (finding 16)', () => {
  it('returns at once on url( followed by a long run of spaces', () => {
    const t = Date.now();
    assert.deepEqual(cssUrls('a{background:url(' + ' '.repeat(100_000) + 'x}'), []);
    assert.deepEqual(collectUrls(loadHtml(`<p style="background:url(${' '.repeat(100_000)}x">x</p>`)), []);
    assert.deepEqual(cssUrls('url("' + 'a'.repeat(100_000) + ' url(' + 'b'.repeat(100_000)), []);
    assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
  });

  it('still finds every url() and @import', () => {
    const css = `a{background:url(a.png)} b{background:url( 'b c.png' )} c{background:URL("d)e.png")} @import "f.css"; @import url(g.css);
x{background:url()} y{src:url(data:font/woff2;base64,AAA) format("woff2")} z{background:url(  h.png  )}`;
    assert.deepEqual(cssUrls(css).sort(), ['a.png', 'b c.png', 'd)e.png', 'f.css', 'g.css', 'h.png']);
  });

  it('replaces the URL, not the first matching text in url(...)', () => {
    assert.equal(rewriteCss('a{background:url(u)} b{background:url( "u" )}', (u) => `/img/${u}`), 'a{background:url(/img/u)} b{background:url( "/img/u" )}');
  });
});

describe('srcset URLs may contain commas (finding 51)', () => {
  const srcset = 'https://example.com/cdn-cgi/image/width=400,quality=75/uploads/a.jpg 400w, https://example.com/cdn-cgi/image/width=800,quality=75/uploads/a.jpg 800w';
  const build = (v: string) => {
    const rel = makeRootRelative('example.com');
    const out = rel(unwrapWayback(v.trim()));
    return out !== v ? out : undefined;
  };

  it('rewrites each candidate whole', () => {
    assert.equal(rewriteSrcset(srcset, build), '/cdn-cgi/image/width=400,quality=75/uploads/a.jpg 400w, /cdn-cgi/image/width=800,quality=75/uploads/a.jpg 800w');
    assert.equal(rewriteSrcset('https://example.com/i/w=1,h=2/a.jpg', build), '/i/w=1,h=2/a.jpg');
    const $ = loadHtml(`<img src="/a.jpg" srcset="${srcset}">`);
    visitUrls($, build);
    assert.equal($('img').attr('srcset'), '/cdn-cgi/image/width=400,quality=75/uploads/a.jpg 400w, /cdn-cgi/image/width=800,quality=75/uploads/a.jpg 800w');
  });

  it('collects the real image URLs for the crawl', () => {
    assert.deepEqual(collectUrls(loadHtml(`<img srcset="${srcset}">`)), [
      'https://example.com/cdn-cgi/image/width=400,quality=75/uploads/a.jpg',
      'https://example.com/cdn-cgi/image/width=800,quality=75/uploads/a.jpg',
    ]);
  });

  it('keeps the usual shapes working', () => {
    const swap = (u: string) => (u.startsWith('http') ? u.replace('http://example.com', '') : undefined);
    assert.equal(rewriteSrcset('http://example.com/a.jpg 1x,http://example.com/b.jpg 2x', swap), '/a.jpg 1x, /b.jpg 2x');
    assert.equal(rewriteSrcset('http://example.com/a.jpg, /b.jpg 2x', swap), '/a.jpg, /b.jpg 2x');
    assert.equal(rewriteSrcset(' http://example.com/a.jpg  480w ,\n /b.jpg 800w ', swap), '/a.jpg  480w, /b.jpg 800w');
    assert.deepEqual(collectUrls(loadHtml('<img srcset="data:image/png;base64,AAA= 1x, /b.png 2x">')), ['/b.png']);
  });
});
