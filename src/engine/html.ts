// Finding (and, where needed, changing) every URL inside HTML and CSS.

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, ChildNode, Element, ParentNode } from 'domhandler';

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
  const forms = /<form[\s/>]/i.test(html);
  const $ = forms ? cheerio.load(html, { sourceCodeLocationInfo: true }) : cheerio.load(html);
  capDepth($.root().get(0)!);
  if (forms) keepFormOwners($, html);
  return $;
}

// Blink and WebKit stop nesting at 512 levels: an element deeper than that goes in beside the
// open one instead of inside it. A guestbook or link list that leaves a <div> or <font> open per
// entry nests thousands deep here, deep enough to overflow the stack of everything that walks the
// tree (text(), html(), the selector engine). Flattened the same way, it stays as browsers show it.
const MAX_TREE_DEPTH = 512;
const hasNodes = (n: AnyNode): n is ParentNode => 'children' in n;
/** The document fragment that holds a <template>'s content, a tree of its own. */
const templateContent = (n: AnyNode): ParentNode | undefined =>
  isElement(n) && n.name === 'template' && isHtml(n) && n.children[0] && hasNodes(n.children[0]) ? n.children[0] : undefined;

function capDepth(root: ParentNode): void {
  const todo: Array<[ParentNode, number]> = [[root, 0]];
  while (todo.length) {
    const [node, depth] = todo.pop()!;
    for (const child of node.children) {
      const content = templateContent(child);
      if (content) todo.push([content, 0]);
      else if (hasNodes(child)) {
        if (depth + 1 < MAX_TREE_DEPTH) todo.push([child, depth + 1]);
        else flatten(child, todo);
      }
    }
  }
}

/**
 * Puts every element under `box` straight in it, in document order, as Blink does past the limit:
 * the elements go in beside each other, while text stays in the element that was open for it.
 */
function flatten(box: ParentNode, todo: Array<[ParentNode, number]>): void {
  const out: ChildNode[] = [];
  const next = [...box.children].reverse();
  while (next.length) {
    const n = next.pop()!;
    out.push(n);
    const content = templateContent(n);
    if (content) todo.push([content, 0]);
    else if (hasNodes(n) && n.children.some(hasNodes)) {
      for (let i = n.children.length - 1; i >= 0; i--) if (hasNodes(n.children[i])) next.push(n.children[i]);
      relink(n, n.children.filter((c) => !hasNodes(c)));
    }
  }
  relink(box, out);
}

function relink(parent: ParentNode, children: ChildNode[]): void {
  parent.children = children;
  children.forEach((n, i) => {
    n.parent = parent;
    n.prev = children[i - 1] ?? null;
    n.next = children[i + 1] ?? null;
  });
}

// Old table layouts put forms where the parser cannot nest them: <table><form><tr><td><input>, or
// a form closed by </td> with its submit button in the next cell. Browsers still tie those controls
// to the form through the parser's form pointer, which lasts until the next </form> tag. The DOM
// keeps no trace of that, so once the page is written back out the controls belong to no form and
// the submit button does nothing. Such controls get form="<id of the form>", which says the same.
const LISTED = new Set(['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
// What the adoption agency copies when it untangles misnested tags such as <b><div></b></div>.
const FORMATTING = new Set(['a', 'b', 'big', 'code', 'em', 'font', 'i', 'nobr', 's', 'small', 'strike', 'strong', 'tt', 'u']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';

interface SourceLoc {
  startOffset: number;
  endOffset: number;
  startTag?: { startOffset: number; endOffset: number };
  endTag?: { startOffset: number; endOffset: number };
}
const locOf = (n: AnyNode) => (n as { sourceCodeLocation?: SourceLoc | null }).sourceCodeLocation ?? undefined;
const isElement = (n: AnyNode): n is Element => n.type === 'tag' || n.type === 'script' || n.type === 'style';
// A <form>, <script> or <template> inside <svg> or <math> is just a foreign element of that name.
const isHtml = (el: Element) => (el.namespace ?? HTML_NS) === HTML_NS;
/** A copy the adoption agency made: a formatting element with no place in the source. */
const isCopy = (n: AnyNode | undefined): n is Element => !!n && isElement(n) && !locOf(n) && isHtml(n) && FORMATTING.has(n.name);

/** The ranges sorted, with overlapping ones merged. */
function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of ranges) {
    const prev = out[out.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Offsets where `re` matches outside the merged ranges, i.e. real tags rather than text. */
function tagsOutside(html: string, re: RegExp, ranges: Array<[number, number]>): number[] {
  const out: number[] = [];
  let k = 0;
  for (const m of html.matchAll(re)) {
    while (k < ranges.length && ranges[k][1] <= m.index) k++;
    if (!(k < ranges.length && ranges[k][0] <= m.index)) out.push(m.index);
  }
  return out;
}

function keepFormOwners($: Doc, html: string): void {
  // Source ranges that cannot hold a </form> tag: start tags, other end tags, comments, the doctype
  // and raw-text content. Plain text nodes are left out because the parser merges text across a
  // stray </form>.
  const opaque: Array<[number, number]> = [];
  const endTags: Array<[number, number]> = [];
  const forms: Element[] = [];
  const controls: Element[] = [];
  // The elements with each id, in document order: form="x" and getElementById find the first.
  const ids = new Map<string, Element[]>();
  // For each control under copies the adoption agency made: each copy and the child of it the control is in.
  const copies = new Map<Element, Array<{ copy: Element; child: Element }>>();
  const trail: Array<{ copy: Element; child: Element }> = [];
  const walk = (nodes: AnyNode[], copy: Element | undefined) => {
    for (const n of nodes) {
      const loc = locOf(n);
      if (!isElement(n)) {
        if (loc && n.type !== 'text') opaque.push([loc.startOffset, loc.endOffset]);
        continue;
      }
      // Template content is a separate tree: its forms never set the pointer, its </form> never clears it.
      if (n.name === 'template' && isHtml(n)) {
        if (loc) opaque.push([loc.startOffset, loc.endOffset]);
        continue;
      }
      if (copy) trail.push({ copy, child: n });
      if (n.attribs.id) {
        if (!ids.has(n.attribs.id)) ids.set(n.attribs.id, []);
        ids.get(n.attribs.id)!.push(n);
      }
      if (loc?.startTag) {
        opaque.push([loc.startTag.startOffset, loc.startTag.endOffset]);
        if (loc.endTag && n.name !== 'form') endTags.push([loc.endTag.startOffset, loc.endTag.endOffset]);
        if (isHtml(n)) {
          if (RAW_TEXT.has(n.name)) opaque.push([loc.startTag.endOffset, loc.endTag?.startOffset ?? loc.endOffset]);
          if (n.name === 'form') forms.push(n);
          else if (LISTED.has(n.name) && n.attribs.form === undefined) {
            controls.push(n);
            if (trail.length) copies.set(n, trail.slice());
          }
        }
      }
      walk(n.children, isCopy(n) ? n : undefined);
      if (copy) trail.pop();
    }
  };
  walk($.root().get(0)?.children ?? [], undefined);
  let made = 0;
  const newId = (form: Element) => {
    let id: string;
    do id = `wbd-form-${++made}`;
    while (ids.has(id));
    ids.set(id, [form]);
    return (form.attribs.id = id);
  };
  if (controls.length && forms.length) tieOrphans($, html, forms, controls, ids, newId, opaque, endTags, copies);
  if (forms.length > 1) {
    closeLikeBlink(forms.sort((a, b) => locOf(a)!.startOffset - locOf(b)!.startOffset));
    unnestForms($, ids, newId);
  }
}

function tieOrphans(
  $: Doc,
  html: string,
  forms: Element[],
  controls: Element[],
  ids: Map<string, Element[]>,
  newId: (form: Element) => string,
  opaque: Array<[number, number]>,
  endTags: Array<[number, number]>,
  copies: Map<Element, Array<{ copy: Element; child: Element }>>,
): void {
  const formEnds = tagsOutside(html, /<\/form[\s/>]/gi, merge([...opaque, ...endTags]));
  const moved = copies.size || controls.some((el) => isCopy(el.children[0])) ? movedControls($, html, merge(opaque), copies) : () => false;

  // Each form's span runs from its start tag to the next </form>; the spans do not overlap, so
  // one sweep over forms, end tags and controls in source order finds every control in each.
  const at = (el: Element) => locOf(el)!.startOffset;
  forms.sort((a, b) => at(a) - at(b));
  controls.sort((a, b) => at(a) - at(b));
  let e = 0;
  let c = 0;
  for (const form of forms) {
    const from = locOf(form)!.startTag!.endOffset;
    while (e < formEnds.length && formEnds[e] < from) e++;
    const to = e < formEnds.length ? formEnds[e] : Infinity;
    while (c < controls.length && at(controls[c]) < from) c++;
    const orphans: Element[] = [];
    for (let j = c; j < controls.length && at(controls[j]) < to; j++) {
      if (!inside(controls[j], form) && !moved(controls[j], form)) orphans.push(controls[j]);
    }
    if (!orphans.length) continue;
    const id = form.attribs.id || newId(form);
    if (ids.get(id)![0] !== form) continue; // form="..." would find another element first
    for (const el of orphans) el.attribs.form = id;
  }
}

const TABLE_PARTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr']);
// What makes a form a form, as opposed to what styles it: left off the block that takes its place.
const FORM_ONLY = /^(?:id|name|action|method|enctype|encoding|target|accept-charset|autocomplete|novalidate|rel|onsubmit|onreset|onformdata)$/i;
// The parser's "special" elements: an end tag that matches no open element stops at them.
const SPECIAL = new Set(
  'address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp'.split(' '),
);

/** Puts the nodes in just after `ref`, beside it. */
function insertAfter(ref: ChildNode, nodes: ChildNode[]): void {
  const parent = ref.parent!;
  const at = parent.children.indexOf(ref);
  relink(parent, [...parent.children.slice(0, at + 1), ...nodes, ...parent.children.slice(at + 1)]);
}

/**
 * Blink and WebKit follow the </form> that closes a form with the generic end-tag step, which also
 * closes the element then open when it is a form, or an inline element (<font>, <span>, <b>) inside
 * one. So the form that a </form> in a cell left open ends right after the inner form that closes
 * cleanly in it, and what follows goes beside it, with a <font> or <b> it was in opened again
 * around it. The parser here, like Firefox, keeps that form open to the end of its parent, so the
 * controls after the inner form would post with it. What follows moves out after it, in each form
 * in document order (`forms`), before the nested forms are taken apart.
 */
function closeLikeBlink(forms: Element[]): void {
  for (const form of forms) {
    const end = locOf(form)?.endTag?.startOffset;
    if (end === undefined || !isHtml(form)) continue;
    // The form must have been the open element once the end tag's implied end tags closed (no
    // <div> left open in it), and the elements around it up to the outer form still open.
    const last = form.children.findLast(isElement);
    if (last && !((locOf(last)?.endOffset ?? Infinity) <= end)) continue;
    const chain: Element[] = [];
    let outer = form.parent;
    while (outer && isElement(outer) && isHtml(outer) && outer.name !== 'form' && !SPECIAL.has(outer.name)) {
      chain.push(outer);
      outer = outer.parent;
    }
    if (!outer || !isElement(outer) || !isHtml(outer) || outer.name !== 'form') continue;
    if ([...chain, outer].some((el) => (locOf(el)?.endOffset ?? Infinity) <= end)) continue;
    let from: ChildNode = form;
    let carry: ChildNode[] = [];
    for (const el of [...chain, outer]) {
      const at = el.children.indexOf(from);
      const after = el.children.slice(at + 1);
      if (after.length) relink(el, el.children.slice(0, at + 1));
      carry = [...carry, ...after];
      // A formatting element the generic step closed is made again for what came after it.
      if (el !== outer && carry.length && FORMATTING.has(el.name)) {
        const again = el.cloneNode(false);
        relink(again, carry);
        carry = [again];
      }
      from = el;
    }
    if (carry.length) insertAfter(outer, carry);
  }
}

/**
 * A form the parser left open (its </form> in a later cell, or met while a <font> or <div> in it
 * was still open) holds every form after it. Browsers made those inner forms anyway, as the form
 * pointer was clear, and gave them their controls; in the written page an inner <form> tag comes
 * while the outer form is open, so it is dropped and its controls go to the outer form. Each inner
 * form moves out to just after the outermost form around it, emptied and hidden, and its controls
 * get form="<its id>"; what it held stays in place, in a <div> (a form is a block) with the
 * form's class and style, unless it sat straight in a table. The forms keep their order, so
 * document.forms[1] is still the same form.
 */
function unnestForms($: Doc, ids: Map<string, Element[]>, newId: (form: Element) => string): void {
  // One walk, in document order, finds the outermost form around each nested form and the form
  // around each control.
  const tops = new Map<Element, Element>();
  const owned: Array<[Element, Element]> = [];
  const todo: Array<[AnyNode, Element | undefined, Element | undefined]> = [];
  const visit = (node: ParentNode, near?: Element, top?: Element) => {
    for (let i = node.children.length - 1; i >= 0; i--) todo.push([node.children[i], near, top]);
  };
  visit($.root().get(0)!);
  while (todo.length) {
    const [n, near, top] = todo.pop()!;
    if (!isElement(n) || (n.name === 'template' && isHtml(n))) continue; // template content is a tree of its own
    if (n.name === 'form' && isHtml(n)) {
      if (top) tops.set(n, top);
      visit(n, n, top ?? n);
      continue;
    }
    if (near && LISTED.has(n.name) && isHtml(n) && n.attribs.form === undefined && tops.has(near)) owned.push([n, near]);
    visit(n, near, top);
  }
  if (!tops.size) return;

  // form="..." finds the first element with an id. A nested form that is the first of several with
  // its id keeps it on its copy after `top`, so it stays where it is when another element that
  // keeps the id would come first then (the nested forms among them get ids of their own).
  const holdersOf = (form: Element) => (form.attribs.id ? ids.get(form.attribs.id)! : []);
  const plan = [...tops].filter(([form, top]) => {
    const holders = holdersOf(form);
    return holders[0] !== form || !holders.some((el) => el !== form && !tops.has(el) && inside(el, top));
  });
  const planned = new Set(plan.map(([form]) => form));
  const moved = new Map<Element, Record<string, string>>(); // moved form -> what the block in its place keeps
  const after = new Map<Element, Element[]>(); // outer form -> the forms moved out after it, in order
  const parents = new Set<ParentNode>();
  for (const [form, top] of plan) {
    // The block keeps what styles the form (class, style, align ...), not what makes it a form.
    const keep = Object.fromEntries(Object.entries(form.attribs).filter(([name]) => !FORM_ONLY.test(name)));
    const holders = holdersOf(form);
    if (holders.length && holders[0] !== form) {
      // Not the first: the copy gets an id of its own, and the block keeps the old one for the CSS
      // that styles it, unless that would put it before the first one's copy.
      const first = holders[0];
      if (!planned.has(first) || !inside(form, tops.get(first)!)) keep.id = form.attribs.id;
      newId(form);
    } else if (!holders.length) newId(form);
    const copy = form.cloneNode(false);
    copy.attribs.style = 'display:none !important';
    if (!after.has(top)) after.set(top, []);
    after.get(top)!.push(copy);
    moved.set(form, keep);
    parents.add(form.parent!).add(top.parent!);
  }
  // Each parent's children are rebuilt once, the deepest first, so a moved form that held another
  // has its new children by the time its own parent takes them.
  const depth = new Map<ParentNode, number>();
  for (const p of parents) {
    let d = 0;
    for (let q = p.parent; q; q = q.parent) d++;
    depth.set(p, d);
  }
  const block = $('<div></div>').get(0) as Element;
  for (const parent of [...parents].sort((x, y) => depth.get(y)! - depth.get(x)!)) {
    const kids: ChildNode[] = [];
    for (const c of parent.children) {
      const keep = isElement(c) ? moved.get(c) : undefined;
      if (isElement(c) && keep) {
        if (c.children.length && !(isElement(parent) && TABLE_PARTS.has(parent.name))) {
          const div = block.cloneNode(false);
          div.attribs = { ...keep };
          relink(div, c.children);
          kids.push(div);
        } else for (const k of c.children) kids.push(k);
      } else kids.push(c);
      if (isElement(c)) for (const copy of after.get(c) ?? []) kids.push(copy);
    }
    relink(parent, kids);
  }
  // Its controls: the ones the browser gave it by the pointer, or as the form around them.
  for (const [control, form] of owned) if (moved.has(form)) control.attribs.form = form.attribs.id;
}

function inside(x: AnyNode, y: AnyNode): boolean {
  let p: AnyNode | null = x;
  while (p && p !== y) p = p.parent;
  return !!p;
}

/**
 * When the adoption agency untangles <form><font><div><input></form></font></div>, it moves the
 * open block (the div) and hands what it held to a copy of the formatting element. A browser
 * gives a control it moves the form around it, as the written page does, unless the control's
 * form moved along with it; only the controls it never moved keep the form from the pointer.
 * This tells which (control, form) pairs it moved apart. `opaque` is where no tag can start.
 */
function movedControls(
  $: Doc,
  html: string,
  opaque: Array<[number, number]>,
  copies: Map<Element, Array<{ copy: Element; child: Element }>>,
): (control: Element, form: Element) => boolean {
  // The tags that can make the adoption agency move things: formatting end tags, here with the
  // elements they closed, and <a> and <nobr> start tags.
  const claims = new Map<number, Element[]>();
  const starts = new Map<number, string>();
  for (const el of $([...FORMATTING].join(',')).toArray()) {
    const loc = locOf(el);
    if (!isElement(el) || !loc?.startTag || !isHtml(el)) continue;
    if (loc.endTag) {
      if (!claims.has(loc.endTag.startOffset)) claims.set(loc.endTag.startOffset, []);
      claims.get(loc.endTag.startOffset)!.push(el);
    }
    if (el.name === 'a' || el.name === 'nobr') starts.set(loc.startOffset, el.name);
  }
  // By tag name, and all of them under ''.
  const triggers = new Map<string, number[]>([['', []]]);
  const add = (name: string, at: number) => {
    for (const key of ['', name]) {
      if (!triggers.has(key)) triggers.set(key, []);
      triggers.get(key)!.push(at);
    }
  };
  for (const at of tagsOutside(html, new RegExp(`</(?:${[...FORMATTING].join('|')})[\\s/>]`, 'gi'), opaque)) {
    add(/^<\/([a-z]+)/i.exec(html.slice(at, at + 9))![1].toLowerCase(), at);
  }
  for (const [at, name] of starts) add(name, at);
  for (const list of triggers.values()) list.sort((x, y) => x - y);

  // The tag that made a copy is the first tag after its block opened that could have: not an end
  // tag that closed an element inside the copy. One found too early only leaves a moved control
  // its form="".
  const madeAt = new Map<Element, number>();
  const made = (copy: Element): number => {
    let found = madeAt.get(copy);
    if (found !== undefined) return found;
    let block = copy.parent;
    while (block && !locOf(block)) block = block.parent;
    const from = (block && locOf(block)?.startTag?.endOffset) ?? 0;
    // The copy that took over what the block held comes first in it and is made by its own tag;
    // the copies of the elements in between are made by the outer element's tag.
    const list = triggers.get(copy.parent === block && block?.children[0] === copy ? copy.name : '') ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    while (lo < list.length && !starts.has(list[lo]) && claims.get(list[lo])?.some((el) => inside(el, copy))) lo++;
    found = lo < list.length ? list[lo] : Infinity;
    madeAt.set(copy, found);
    return found;
  };
  return (control, form) =>
    // A control that was the open block itself holds a copy as its first child.
    isCopy(control.children[0]) ||
    (copies.get(control) ?? []).some(({ copy, child }) => locOf(control)!.startOffset < made(copy) && !inside(form, child));
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

/**
 * Splits a srcset the way browsers do: a URL is a run of non-whitespace (so commas inside it, as in
 * /cdn-cgi/image/width=400,quality=75/a.jpg or a data: URL, stay), and its descriptor runs to the
 * next comma outside parentheses. The descriptor keeps its leading whitespace.
 */
function splitSrcset(value: string): Array<{ url: string; descriptor: string }> {
  const out: Array<{ url: string; descriptor: string }> = [];
  const ws = /[\t\n\f\r ]/;
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (ws.test(value[i]) || value[i] === ',')) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !ws.test(value[i])) i++;
    const url = value.slice(start, i);
    if (url.endsWith(',')) {
      // Trimmed by hand: /,+$/ retries from every comma of a long run, which is quadratic.
      let end = url.length;
      while (end > 0 && url[end - 1] === ',') end--;
      out.push({ url: url.slice(0, end), descriptor: '' });
      continue;
    }
    const from = i;
    let depth = 0;
    for (; i < value.length; i++) {
      const c = value[i];
      if (c === '(') depth++;
      else if (c === ')' && depth > 0) depth--;
      else if (c === ',' && depth === 0) break;
    }
    out.push({ url, descriptor: value.slice(from, i).trimEnd() });
    i++;
  }
  return out;
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

// Whitespace is captured inside a lookahead and then matched by backreference, so each run of it
// can be matched only one way: no backtracking blow-up on url( followed by thousands of spaces.
const CSS_URL = /url\((?=(\s*))\1(?:"([^"]*)"|'([^']*)'|([^'"()\s]*))(?=(\s*))\5\)/gi;
const CSS_IMPORT = /@import\s+(['"])([^'"]+)\1/gi;

export function rewriteCss(css: string, visit: UrlVisitor): string {
  const swap = (whole: string, url: string) => {
    if (!url || /^data:/i.test(url)) return whole;
    const next = visit(url);
    if (next === undefined || next === url) return whole;
    // The URL is the last thing in the match apart from its closing quote, spaces and paren.
    const at = whole.lastIndexOf(url);
    return whole.slice(0, at) + next + whole.slice(at + url.length);
  };
  return css
    .replace(CSS_URL, (whole: string, _ws: string, dq?: string, sq?: string, bare?: string) => swap(whole, dq ?? sq ?? bare ?? ''))
    .replace(CSS_IMPORT, (whole: string, _q: string, url: string) => swap(whole, url));
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
      // Trimmed first and with no two whitespace runs side by side, so the match stays linear.
      const m = /^((?:\d+\s*)?;\s*url\s*=\s*)(['"]?)(.+?)\2$/i.exec(content.trim());
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

const HIDDEN = new Set(['script', 'style', 'noscript', 'noembed', 'template', 'svg', 'head', 'iframe', 'object']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul', 'option',
]);

/** Text a visitor would read, with block elements separated so words do not run together. */
export function visibleText($: Doc): string {
  const parts: string[] = [];
  const body = $('body').get(0);
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text') parts.push((n as unknown as { data: string }).data);
      else if ((n.type === 'tag' || n.type === 'script' || n.type === 'style') && 'name' in n) {
        if (HIDDEN.has(n.name)) continue;
        if (n.name === 'noframes') {
          // Raw markup to the parser, and never shown by a browser with frames. A frameset page (no
          // <body>) has nothing else to read, so that markup is read as a page of its own.
          if (!body) parts.push(' ', visibleText(loadHtml($(n).text())), ' ');
          continue;
        }
        const block = BLOCK.has(n.name);
        if (block) parts.push(' ');
        walk((n as unknown as { children: AnyNode[] }).children);
        if (block) parts.push(' ');
      }
    }
  };
  walk(body ? [body] : ($.root().get(0) as unknown as { children: AnyNode[] }).children);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function countWords(text: string): number {
  const latin = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  // CJK scripts have no spaces; count every two characters as a word.
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return latin.length + Math.round(cjk / 2);
}
