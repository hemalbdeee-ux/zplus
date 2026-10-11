// Page-level health signals: phrases that real small sites share with parking pages, script
// redirects, and stub homepages that lead to the real one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzePage, scoreSignals } from '../src/engine/health.ts';

const HOME = 'http://example.com/';
const DOMAIN = 'example.com';
const nav = ['/', '/about.html', '/menu.html', '/contact.html', '/gallery.html', '/blog/'].map((h) => `<a href="${h}">${h}</a>`).join(' ');
const text = (n: number) => Array.from({ length: n }, (_, i) => `bread${i % 40}`).join(' ');
const page = (title: string, body: string) => `<html lang="en"><head><title>${title}</title></head><body><nav>${nav}</nav>${body}</body></html>`;

describe('health: parked and dead phrases on real pages', () => {
  const cases: Array<[string, string]> = [
    ['dealer', page('Smith Motors - Used Cars', `<h1>Quality used cars</h1><p>${text(250)} Make an offer today!</p>`)],
    ['restaurant', page("Luigi's Trattoria", `<h1>Welcome</h1><p>${text(150)} Online ordering coming soon!</p>`)],
    ['hobby site', page("Bob's Model Trains", `<h1>Model trains</h1><p>${text(170)}</p><h2>Related links</h2><p>Train clubs</p>`)],
    ['hosting reseller', page('AcmeHost', `<h1>Web hosting</h1><p>${text(200)} Log in to renew your domain.</p>`)],
    ['bakery', page("Rosa's Bakery", `<h1>Fresh bread</h1><p>${text(200)} Our gallery is under construction.</p>`)],
  ];
  for (const [name, html] of cases) {
    it(`does not call a ${name} homepage with one such phrase parked or dead`, () => {
      const s = analyzePage(html, HOME, DOMAIN);
      assert.equal(s.fatal, null);
      assert.match(s.hint ?? '', /^mentions "/);
      assert.equal(scoreSignals(s, {}).verdict, 'good');
    });
  }

  it('still recognizes landers built from the same phrases', () => {
    const offer = analyzePage('<html><head><title>example.com</title></head><body><h1>Make an offer</h1><p>Contact the owner.</p></body></html>', HOME, DOMAIN);
    assert.match(offer.fatal ?? '', /parked domain page \("make an offer"\)/);
    const soon = analyzePage('<html><body><p>Our website is coming soon.</p><a href="https://twitter.com/x">Twitter</a></body></html>', HOME, DOMAIN);
    assert.match(soon.fatal ?? '', /hosting or error/);
    const ppc = analyzePage(`<html><body><p>example.com</p><p>Related searches</p>${['a', 'b', 'c', 'd'].map((q) => `<a href="/?q=${q}">${q}</a>`).join('')}</body></html>`, HOME, DOMAIN);
    assert.match(ppc.fatal ?? '', /ad links/);
    const works = analyzePage('<html><body><h1>It works!</h1></body></html>', HOME, DOMAIN);
    assert.match(works.fatal ?? '', /hosting or error/);
  });
});

describe('health: script redirects', () => {
  it('ignores an onclick button to social media on a short page with navigation', () => {
    const html = page('Smith Photography', `<p>${text(40)}</p><button onclick="window.location='https://www.instagram.com/smithphoto'">Instagram</button>`);
    const s = analyzePage(html, HOME, DOMAIN);
    assert.equal(s.fatal, null);
    assert.notEqual(scoreSignals(s, {}).verdict, 'bad');
  });

  it('ignores a click handler in a script on a page with navigation', () => {
    const html = page('Smith Photography', `<p>${text(40)}</p><script>function ig(){ location.href = 'https://www.instagram.com/smithphoto'; }</script>`);
    assert.equal(analyzePage(html, HOME, DOMAIN).fatal, null);
  });

  it('still flags a page whose script sends visitors elsewhere', () => {
    const s = analyzePage(`<html><head><script>window.location = 'https://spam.example/landing';</script></head><body></body></html>`, HOME, DOMAIN);
    assert.equal(s.fatal, 'sends visitors to spam.example');
    const r = analyzePage(`<html><body><script>location.replace("https://other.example/")</script></body></html>`, HOME, DOMAIN);
    assert.equal(r.fatal, 'sends visitors to other.example');
  });
});

describe('health: stub homepages', () => {
  it('follows an internal meta refresh', () => {
    const s = analyzePage('<html><head><meta http-equiv="refresh" content="0; url=/home.html"></head><body></body></html>', HOME, DOMAIN);
    assert.equal(s.fatal, null);
    assert.equal(s.follow, 'http://example.com/home.html');
  });

  it('follows the main frame of a frameset and counts frames as links', () => {
    const html =
      '<html><head><title>Old Bakery</title></head><frameset cols="200,*"><frame name="contents" src="/toc.html"><frame name="main" src="/home.html">' +
      '<noframes><body>This site uses frames. <a href="/home.html">Enter</a></body></noframes></frameset></html>';
    const s = analyzePage(html, HOME, DOMAIN);
    assert.equal(s.follow, 'http://example.com/home.html');
    assert.equal(s.internalLinks, 2);
  });

  it('follows the only way into a splash page', () => {
    const s = analyzePage('<html><head><title>Old Bakery</title></head><body><a href="/home.html"><img src="/logo.gif" alt=""></a> <a href="/home.html">ENTER</a></body></html>', HOME, DOMAIN);
    assert.equal(s.follow, 'http://example.com/home.html');
  });

  it('follows an internal script redirect', () => {
    const s = analyzePage('<html><body><script>window.location.href = "/en/index.html";</script></body></html>', HOME, DOMAIN);
    assert.equal(s.fatal, null);
    assert.equal(s.follow, 'http://example.com/en/index.html');
  });

  it('does not follow anything from a real page', () => {
    const s = analyzePage(page('Bakery', `<p>${text(300)}</p>`), HOME, DOMAIN);
    assert.equal(s.follow, undefined);
  });
});
