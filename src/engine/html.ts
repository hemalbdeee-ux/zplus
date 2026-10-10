// Finding (and, where needed, changing) every URL inside HTML and CSS.

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

export type Doc = CheerioAPI;

/** Removes an element; in <head> also the line break before it, so no blank lines pile up. */
export function removeNode($: Doc, el: AnyNode): void {
  const prev = el.prev;
  const parent = el.parent;
  if (prev && prev.type === 'text' && parent && 'name' in parent && parent.name === 'head' && /^\s*$/.test((prev as unknown as { data: string }).data)) {
    $(prev).remove();
  }
  $(el).remove();
}

export function loadHtml(html: string): Doc {
  return cheerio.load(html);
}

const URL_ATTRS: Array<[string, string]> = [
  ['a', 'href'],
  ['area', 'href'],
  ['link', 'href'],
  ['base', 'href'],
  ['script', 'src'],
  ['img', 'src'],
  ['img', 'data-src'],
  ['img', 'data-lazy-src'],
  ['img', 'data-original'],
  ['iframe', 'src'],
  ['frame', 'src'],
  ['embed', 'src'],
  ['source', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['track', 'src'],
  ['input', 'src'],
  ['object', 'data'],
  ['form', 'action'],
  ['body', 'background'],
  ['table', 'background'],
  ['td', 'background'],
  ['th', 'background'],
  ['blockquote', 'cite'],
  ['q', 'cite'],
];

const SRCSET_ATTRS: Array<[string, string]> = [
  ['img', 'srcset'],
  ['img', 'data-srcset'],
  ['source', 'srcset'],
];

const META_URL_NAMES = /^(og:image|og:image:url|og:image:secure_url|og:url|og:video|og:audio|twitter:image|twitter:image:src|msapplication-tileimage|thumbnail)$/i;

/** Called for each URL; return a new value to replace it, or undefined to keep it. */
export type UrlVisitor = (url: string) => string | undefined;

function splitSrcset(value: string): Array<{ url: string; descriptor: string }> {
  return value
    .split(/,(?=\s*[^\s,]+(?:\s+[\d.]+[wx])?\s*(?:,|$))/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(\S+)(\s+.*)?$/.exec(part);
      return { url: m?.[1] ?? part, descriptor: m?.[2] ?? '' };
    });
}

export function rewriteSrcset(value: string, visit: UrlVisitor): string {
  let changed = false;
  const parts = splitSrcset(value).map(({ url, descriptor }) => {
    const next = visit(url);
    if (next !== undefined && next !== url) changed = true;
    return (next ?? url) + descriptor;
  });
  return changed ? parts.join(', ') : value;
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;

export function rewriteCss(css: string, visit: UrlVisitor): string {
  const replace = (whole: string, quote: string, url: string) => {
    if (/^data:/i.test(url)) return whole;
    const next = visit(url);
    return next === undefined || next === url ? whole : whole.replace(url, () => next);
  };
  return css.replace(CSS_URL, replace).replace(CSS_IMPORT, replace);
}

export function cssUrls(css: string): string[] {
  const out: string[] = [];
  rewriteCss(css, (u) => {
    out.push(u);
    return undefined;
  });
  return out;
}

/** Visits every URL in the document: attributes, srcset, inline styles, <style>, meta images and meta refresh. */
export function visitUrls($: Doc, visit: UrlVisitor): void {
  const skip = (v: string) => /^(#|mailto:|tel:|javascript:|data:|about:|sms:|callto:|skype:)/i.test(v.trim()) || v.trim() === '';
  const guarded: UrlVisitor = (u) => (skip(u) ? undefined : visit(u));

  for (const [tag, attr] of URL_ATTRS) {
    $(`${tag}[${attr}]`).each((_, el) => {
      const v = $(el).attr(attr);
      if (v === undefined) return;
      const next = guarded(v);
      if (next !== undefined && next !== v) $(el).attr(attr, next);
    });
  }
  for (const [tag, attr] of SRCSET_ATTRS) {
    $(`${tag}[${attr}]`).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      const next = rewriteSrcset(v, guarded);
      if (next !== v) $(el).attr(attr, next);
    });
  }
  $('meta[content]').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('property') ?? $el.attr('name') ?? $el.attr('itemprop') ?? '';
    const content = $el.attr('content') ?? '';
    if (META_URL_NAMES.test(name)) {
      const next = guarded(content);
      if (next !== undefined && next !== content) $el.attr('content', next);
    } else if (($el.attr('http-equiv') ?? '').toLowerCase() === 'refresh') {
      const m = /^(\s*\d*\s*;\s*url\s*=\s*)(['"]?)(.+?)\2\s*$/i.exec(content);
      if (m) {
        const next = guarded(m[3]);
        if (next !== undefined && next !== m[3]) $el.attr('content', m[1] + next);
      }
    }
  });
  $('[style]').each((_, el) => {
    const v = $(el).attr('style') ?? '';
    if (!/url\(/i.test(v)) return;
    const next = rewriteCss(v, guarded);
    if (next !== v) $(el).attr('style', next);
  });
  $('style').each((_, el) => {
    const css = $(el).html() ?? '';
    if (!/url\(|@import/i.test(css)) return;
    const next = rewriteCss(css, guarded);
    if (next !== css) $(el).text(next);
  });
}

export function collectUrls($: Doc): string[] {
  const out: string[] = [];
  visitUrls($, (u) => {
    out.push(u);
    return undefined;
  });
  return out;
}

const HIDDEN = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'object']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul', 'option',
]);

/** Text a visitor would read, with block elements separated so words do not run together. */
export function visibleText($: Doc): string {
  const parts: string[] = [];
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text') parts.push((n as unknown as { data: string }).data);
      else if ((n.type === 'tag' || n.type === 'script' || n.type === 'style') && 'name' in n) {
        if (HIDDEN.has(n.name)) continue;
        const block = BLOCK.has(n.name);
        if (block) parts.push(' ');
        walk((n as unknown as { children: AnyNode[] }).children);
        if (block) parts.push(' ');
      }
    }
  };
  const body = $('body').get(0);
  walk(body ? [body] : ($.root().get(0) as unknown as { children: AnyNode[] }).children);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function countWords(text: string): number {
  const latin = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  // CJK scripts have no spaces; count every two characters as a word.
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return latin.length + Math.round(cjk / 2);
}
