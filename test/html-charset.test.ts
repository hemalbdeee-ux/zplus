import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeText, detectCharset } from '../src/engine/charset.ts';
import { collectUrls, loadHtml } from '../src/engine/html.ts';

describe('a UTF-8 page with a few bad bytes stays UTF-8 (finding 11)', () => {
  const page = (tail: Buffer) =>
    Buffer.concat([Buffer.from('<html><head><meta charset="utf-8"><title>Главная</title></head><body><p>It’s 日本語 crème</p><a href="/новости/">н</a><footer>', 'utf8'), tail, Buffer.from(' 2009</footer></body></html>')]);

  it('decodes the page as UTF-8 when one windows-1252 byte slipped in', () => {
    const body = page(Buffer.from([0xa9]));
    assert.equal(detectCharset(body, 'text/html; charset=UTF-8'), 'utf-8');
    assert.equal(detectCharset(body, 'text/html'), 'utf-8');
    const { text } = decodeText(body, 'text/html; charset=UTF-8');
    assert.match(text, /<title>Главная<\/title>/);
    assert.match(text, /It’s 日本語 crème/);
    assert.ok(collectUrls(loadHtml(text)).includes('/новости/'));
  });

  it('decodes a capture cut off in the middle of a character as UTF-8', () => {
    const full = Buffer.from('<html><head><title>日本語のページです</title></head><body><p>テスト</p></body></html>', 'utf8');
    const cut = full.subarray(0, full.indexOf(Buffer.from('ト', 'utf8')) + 2);
    assert.equal(detectCharset(cut, ''), 'utf-8');
    assert.match(decodeText(cut, '').text, /<title>日本語のページです<\/title>/);
  });

  it('still reads a windows-1252 page that claims UTF-8 as windows-1252', () => {
    const body = Buffer.from('<meta charset="utf-8"><p>Caf\xe9 cr\xe8me br\xfbl\xe9e \xa9 2004</p>', 'latin1');
    assert.equal(detectCharset(body, 'text/html; charset=utf-8'), 'windows-1252');
    assert.match(decodeText(body, '').text, /Café crème brûlée © 2004/);
  });
});

describe('charset declarations are read the way browsers read them (finding 49)', () => {
  it('treats a UTF-16 or "unicode" label in a meta tag as UTF-8', () => {
    for (const label of ['utf-16', 'unicode', 'utf-16le', 'UTF-16BE']) {
      const body = Buffer.from(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=${label}"></head><body><h1>Hello world</h1></body></html>`);
      assert.equal(detectCharset(body, 'text/html'), 'utf-8', label);
      assert.match(decodeText(body, 'text/html').text, /<h1>Hello world<\/h1>/, label);
    }
    const latin = Buffer.from('<meta charset="utf-16"><h1>Caf\xe9</h1>', 'latin1');
    assert.match(decodeText(latin, '').text, /Café/);
  });

  it('keeps a UTF-16 charset sent in the HTTP header', () => {
    assert.equal(detectCharset(Buffer.from('<p>x</p>'), 'text/html; charset=utf-16'), 'utf-16le');
  });

  it('finds a meta charset that comes after the first 4 KB of the head', () => {
    const cyr = Buffer.from([0xc3, 0xeb, 0xe0, 0xe2, 0xed, 0xe0, 0xff]); // "Главная" in windows-1251
    const body = Buffer.concat([
      Buffer.from(`<html><head><script>${'var x = 1;\n'.repeat(420)}</script><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"></head><body><h1>`),
      cyr,
      Buffer.from('</h1></body></html>'),
    ]);
    assert.ok(body.indexOf('charset=') > 4096);
    assert.equal(detectCharset(body, 'text/html'), 'windows-1251');
    assert.match(decodeText(body, 'text/html').text, /<h1>Главная<\/h1>/);
  });

  it('does not take a charset= from the page body', () => {
    const body = Buffer.from(`<html><head><title>x</title></head><body><pre>${'a'.repeat(5000)} &lt;meta charset=shift_jis&gt; <meta charset="shift_jis"></pre><p>caf\xe9</p></body></html>`, 'latin1');
    assert.equal(detectCharset(body, ''), 'windows-1252');
  });
});
