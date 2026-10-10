// Removes what does not belong on the restored site: anything the Wayback Machine injected, and
// the previous owner's analytics and ad code (it would report the new owner's traffic to them).

import { Script } from 'node:vm';
import type { AnyNode } from 'domhandler';
import { removeNode, type Doc } from './html.ts';

export function stripWaybackMarkup(html: string): string {
  return html
    .replace(/<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/gi, '')
    .replace(/<!--\s*FILE ARCHIVED ON[\s\S]*?-->/gi, '')
    .replace(/<!--\s*playback timings[\s\S]*?-->/gi, '');
}

// Anchored on the host, so a site on jazzarchive.org keeps its own /static/ and /includes/ files.
const ARCHIVE_ASSET = /^(?:https?:)?\/\/(?:web-static\.archive\.org\/|(?:web\.)?archive\.org\/(?:_static|static|includes)\/)/i;
// Root-relative toolbar files, only on a page that shows other signs of Wayback playback.
const ARCHIVE_ASSET_RELATIVE = /^\/_static\/(?:js|css)\//i;
const ARCHIVE_INLINE = /(__wm\.(?:init|wombat|rw|bt)|wbhack|_wb_wombat|archive_analytics|WB_wombat_)/;

const TRACKER_SRC = new RegExp(
  [
    'google-analytics\\.com',
    'googletagmanager\\.com',
    'googlesyndication\\.com',
    'googleadservices\\.com',
    'doubleclick\\.net',
    'connect\\.facebook\\.net/[^"\']*/(?:fbevents|fbds)',
    'facebook\\.com/tr',
    'static\\.hotjar\\.com',
    'statcounter\\.com',
    'quantserve\\.com',
    'scorecardresearch\\.com',
    'histats\\.com',
    'mc\\.yandex\\.ru',
    'getclicky\\.com',
    'addthis\\.com',
    'stats\\.wp\\.com',
    'pixel\\.wp\\.com',
    'bat\\.bing\\.com',
    'snap\\.licdn\\.com',
    'analytics\\.twitter\\.com',
    'static\\.ads-twitter\\.com',
    'amazon-adsystem\\.com',
    'infolinks\\.com',
    'chitika\\.net',
    'contextual\\.media\\.net',
    'bidvertiser\\.com',
    'popads\\.net',
    'propellerads\\.com',
    'adsterra',
    'hm\\.baidu\\.com',
    'cnzz\\.com',
  ].join('|'),
  'i',
);

const TRACKER_INLINE =
  /(GoogleAnalyticsObject|_gaq\.push|\bgtag\(|\bga\(\s*['"](?:create|send)|googletagmanager\.com|\bfbq\(|_fbq|hotjar|_hmt\.push|\bym\(\d+|yaCounter|sc_project|_qevents|adsbygoogle|clicky_site_ids|addthis_config|__gaTracker|urchinTracker|pageTracker\._track|_paq\.push)/;

// A tracker snippet is made of loaders (an IIFE or document.write that names a tracker), calls
// such as ga('send', 'pageview') and tracker variables such as var _gaq = _gaq || [].
const TRACKER_LOADER = new RegExp(`${TRACKER_SRC.source}|GoogleAnalyticsObject|_hjSettings|yandex_metrika_callbacks|Ya\\.Metrika|gtm\\.start|\\b(?:matomo|piwik)\\.(?:js|php)\\b`, 'i');
const IIFE = /^(?:[(!+~]|void\s)\s*(?:function\b|\(|async\b)/;
// What a loader's function does: declare and assign, find and insert the script tag, queue calls.
const LOADER_STEP = /^(?:(?:var|let|const)\s|(?:return|if|try)\b|[\w$.[\]'"]+\s*=(?!=)|[^;{}]*?\.(?:push|insertBefore|appendChild|write|writeln)\s*\()/;
const TRACKER_CALL = /^(?:window\.)?(?:ga|gtag|fbq|ym|hj|__gaTracker|urchinTracker|(?:_gaq|_paq|_hmt|_qevents|dataLayer|clicky_site_ids)\.push|pageTracker\.\w+|clicky\.init)\s*\(/;
const TRACKER_VAR =
  /^(?:window\.)?(?:_gaq|_gat|ga|gtag|dataLayer|fbq|_fbq|_paq|_hmt|_qevents|_qoptions|__gaTracker|pageTracker|_uacct|_udn|_uff|gaJsHost|scJsHost|sc_\w+|clicky_site_ids|clicky_custom|addthis_\w+|yaCounter\d+|_hjSettings|google_ad_\w+|google_analytics_\w+|_gaUserPrefs)(?:\.\w+)*$/;

interface Tok {
  v: string;
  start: number;
  end: number;
  /** A line break comes before this token. */
  nl: boolean;
  /** Word (identifier, keyword, number), punctuation, or a string, template or regex literal. */
  kind: 'w' | 'p' | 's';
}

const EXPR_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'var', 'let', 'const']);
const EOL = /[\n\r\u2028\u2029]/;
const isWordChar = (ch: string) => /[\w$]/.test(ch) || (ch > '\x7f' && !/\s/.test(ch));

/** A rough JavaScript tokenizer: enough to find statements; null when the code does not lex. */
function jsTokens(code: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  let nl = false;
  let lineStart = true;
  while (i < code.length) {
    const c = code[i];
    if (EOL.test(c)) {
      nl = lineStart = true;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Old scripts wrap themselves in <!-- ... //-->; browsers read both as line comments.
    if (code.startsWith('//', i) || code.startsWith('<!--', i) || (lineStart && code.startsWith('-->', i))) {
      while (i < code.length && !EOL.test(code[i])) i++;
      continue;
    }
    if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) return null;
      if (EOL.test(code.slice(i, end))) nl = lineStart = true;
      i = end + 2;
      continue;
    }
    const start = i;
    const prev = out[out.length - 1];
    let kind: Tok['kind'] = 'p';
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) {
        if (code[i] === '\\') i++;
        else if (c !== '`' && EOL.test(code[i])) return null;
      }
      if (i++ >= code.length) return null;
      kind = 's';
    } else if (c === '/' && (!prev || (prev.kind === 'w' ? EXPR_KEYWORDS.has(prev.v) : prev.kind === 'p' && !/[)\]}]/.test(prev.v)))) {
      let inClass = false;
      for (i++; i < code.length && (inClass || code[i] !== '/'); i++) {
        if (code[i] === '\\') i++;
        else if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (EOL.test(code[i])) return null;
      }
      if (i++ >= code.length) return null;
      while (i < code.length && /[\w$]/.test(code[i])) i++;
      kind = 's';
    } else if (isWordChar(c)) {
      while (i < code.length && isWordChar(code[i])) i++;
      kind = 'w';
    } else i++;
    out.push({ v: code.slice(start, i), start, end: i, nl, kind });
    nl = lineStart = false;
  }
  return out;
}

/** Does token t, at the top level, start a new statement after the tokens of the current one? */
function startsStatement(cur: Tok[], t: Tok): boolean {
  const last = cur[cur.length - 1];
  if (t.kind === 'p' && t.v !== '!' && t.v !== '~') return false; // ( [ . + = ... continue an expression
  if (t.kind === 'w' && /^(?:else|catch|finally|in|instanceof|of)$/.test(t.v)) return false;
  if (t.v === 'while' && cur[0].v === 'do') return false;
  const ends = last.kind === 's' || (last.kind === 'w' && !EXPR_KEYWORDS.has(last.v)) || /^[)\]}]$/.test(last.v);
  if (!ends || !(t.nl || last.v === '}')) return false;
  // if (x) / for (...) / while (x) followed by its body on the next line.
  if (last.v === ')' && /^(?:if|for|while|with)$/.test(cur[0].v)) {
    let depth = 0;
    for (let k = 1; k < cur.length; k++) {
      if (cur[k].v === '(') depth++;
      else if (cur[k].v === ')' && --depth === 0) return k !== cur.length - 1;
    }
  }
  return true;
}

/** The top-level statements of a script (each with its own tokens), or null when it cannot be split. */
function statements(code: string): Tok[][] | null {
  const toks = jsTokens(code);
  if (!toks) return null;
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (depth === 0 && cur.length && startsStatement(cur, t)) {
      out.push(cur);
      cur = [];
    }
    cur.push(t);
    if (t.kind !== 'p') continue;
    if ('([{'.includes(t.v)) depth++;
    else if (')]}'.includes(t.v) && --depth < 0) return null;
    else if (t.v === ';' && depth === 0) {
      out.push(cur);
      cur = [];
    }
  }
  if (depth !== 0) return null;
  if (cur.length) out.push(cur);
  return out;
}

const textOf = (code: string, st: Tok[]) => code.slice(st[0].start, st[st.length - 1].end).replace(/;$/, '').trim();

/** The source between the braces of the function that an IIFE statement calls. */
function iifeBody(code: string, st: Tok[]): { body: string; start: number } | null {
  const open = st.findIndex((t) => t.v === '{');
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < st.length; k++) {
    if (st[k].kind !== 'p') continue;
    if ('([{'.includes(st[k].v)) depth++;
    else if (')]}'.includes(st[k].v) && --depth === 0) return { body: code.slice(st[open].end, st[k].start), start: st[open].end };
  }
  return null;
}

function isLoader(code: string, st: Tok[]): boolean {
  const text = textOf(code, st);
  if (/^document\.write(?:ln)?\s*\(/.test(text)) return TRACKER_LOADER.test(text) && !/\bfunction\b/.test(text);
  if (IIFE.test(text)) {
    if (!TRACKER_LOADER.test(text)) return false;
    // A loader's function only sets up its queue and inserts the script tag. One that does more is
    // the site's own code wrapped around a snippet.
    const fn = iifeBody(code, st);
    const inner = fn && statements(fn.body);
    return !!fn && !!inner && inner.every((s) => LOADER_STEP.test(textOf(fn.body, s)));
  }
  // try { var pageTracker = _gat._getTracker("UA-1"); pageTracker._trackPageview(); } catch (err) {}
  const m = /^try\s*\{([\s\S]*)\}\s*catch\s*\(\s*\w+\s*\)\s*\{\s*\}$/.exec(text);
  return !!m && trackerOnly(m[1]);
}

function isTrackerStatement(code: string, st: Tok[]): boolean {
  if (isLoader(code, st)) return true;
  const text = textOf(code, st);
  if (/^\(\s*(?:window\.)?adsbygoogle\s*=\s*window\.adsbygoogle\s*\|\|\s*\[\s*\]\s*\)\s*\.push\(\s*\{[^{}]*\}\s*\)$/.test(text)) return true;
  if (TRACKER_CALL.test(text)) {
    // One call and nothing after it. A call that hands over a function (hitCallback, a ready
    // callback) is site logic as well.
    if (/\bfunction\b|=>|hitCallback|event_callback|eventCallback/.test(text)) return false;
    const toks = st[st.length - 1].v === ';' ? st.slice(0, -1) : st;
    let depth = 0;
    for (let k = toks.findIndex((t) => t.v === '('); k < toks.length; k++) {
      if ('([{'.includes(toks[k].v)) depth++;
      else if (')]}'.includes(toks[k].v) && --depth === 0) return k === toks.length - 1;
    }
    return false;
  }
  if (/^function\s+(?:gtag|ga)\s*\(/.test(text)) return true;
  if (/^(?:var|let|const)\s/.test(text)) {
    // Every declared name must be a tracker's: var sc_project=1, sc_invisible=1;
    let depth = 0;
    for (let k = 1; k < st.length; k++) {
      const t = st[k];
      if (k === 1 || (depth === 0 && st[k - 1].v === ',')) {
        if (t.kind !== 'w' || !TRACKER_VAR.test(t.v)) return false;
      }
      if ('([{'.includes(t.v)) depth++;
      else if (')]}'.includes(t.v)) depth--;
    }
    return true;
  }
  const assign = /^((?:[\w$]+\.)*[\w$]+)\s*=(?!=)/.exec(text);
  return !!assign && TRACKER_VAR.test(assign[1]);
}

/** True when the script is nothing but tracker statements. */
function trackerOnly(code: string): boolean {
  const list = statements(code);
  return !!list && list.length > 0 && list.every((st) => isTrackerStatement(code, st));
}

function compiles(code: string): boolean {
  try {
    new Script(code); // compiled only, never run
    return true;
  } catch {
    return false;
  }
}

/** Where the tracker loaders are in a script, also inside an IIFE that wraps the site's code. */
function loaderRanges(code: string, base = 0): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const st of statements(code) ?? []) {
    if (isLoader(code, st)) out.push([base + st[0].start, base + st[st.length - 1].end]);
    else if (IIFE.test(textOf(code, st))) {
      const fn = iifeBody(code, st);
      if (fn) out.push(...loaderRanges(fn.body, base + fn.start));
    }
  }
  return out;
}

/** The script without its tracker loaders, or the script unchanged when that is not certain to be safe. */
function withoutLoaders(code: string): string {
  const cuts = loaderRanges(code);
  if (!cuts.length) return code;
  let out = '';
  let at = 0;
  for (const [start, end] of cuts) {
    out += code.slice(at, start);
    at = end;
  }
  out += code.slice(at);
  return compiles(out) || !compiles(code) ? out : code;
}

// Calls to removed trackers, left in the site's own scripts and onclick attributes, go to no-ops
// instead of throwing; callbacks that wait for a hit to be sent (hitCallback, event_callback) run.
const TRACKER_STUBS =
  '(function(w){var t,f=function(){for(var i=0;i<arguments.length;i++){var a=arguments[i],c=a&&(a.hitCallback||a.event_callback||a.eventCallback);' +
  "if(typeof c=='function')setTimeout(c,0)}return t};t=typeof Proxy=='function'?new Proxy(f,{get:function(o,k){return k in o||typeof k!='string'||k=='then'?o[k]:f}}):f;" +
  "['ga','gtag','fbq','_fbq','ym','hj','__gaTracker','urchinTracker','_gat','pageTracker','clicky'].forEach(function(n){w[n]=w[n]||t});" +
  "['_gaq','_paq','_hmt','_qevents','dataLayer','clicky_site_ids'].forEach(function(n){if(!w[n]){var q=[];q.push=function(){f.apply(null,arguments);return Array.prototype.push.apply(q,arguments)};w[n]=q}})})(window);";

export interface CleanStats {
  waybackRemoved: number;
  trackersRemoved: number;
}

export function cleanDocument($: Doc, opts: { stripTracking: boolean }): CleanStats {
  const stats: CleanStats = { waybackRemoved: 0, trackersRemoved: 0 };

  const assetUrl = (el: AnyNode) => $(el).attr('src') ?? $(el).attr('href') ?? '';
  // /_static/js/ and #donato are common names; they are Wayback's only on a page with other playback traces.
  const playback =
    $('#wm-ipp-base, #wm-ipp').length > 0 ||
    $('script[src], link[href]').toArray().some((el) => ARCHIVE_ASSET.test(assetUrl(el))) ||
    $('script:not([src])').toArray().some((el) => ARCHIVE_INLINE.test($(el).html() ?? ''));

  $('script[src], link[href]').each((_, el) => {
    const v = assetUrl(el);
    if (ARCHIVE_ASSET.test(v) || (playback && ARCHIVE_ASSET_RELATIVE.test(v))) {
      removeNode($, el);
      stats.waybackRemoved++;
    }
  });
  $('script:not([src])').each((_, el) => {
    if (ARCHIVE_INLINE.test($(el).html() ?? '')) {
      removeNode($, el);
      stats.waybackRemoved++;
    }
  });
  $(playback ? '#wm-ipp-base, #wm-ipp, #donato, #wm-ipp-print' : '#wm-ipp-base, #wm-ipp, #wm-ipp-print').each((_, el) => {
    removeNode($, el);
    stats.waybackRemoved++;
  });

  if (!opts.stripTracking) return stats;

  // An inline script goes only when it is nothing but a tracker snippet. The site's own code that
  // merely calls ga('send', 'event', ...) or sits in one block with the snippet stays; only the
  // loader that would report to the old owner is cut from it, and the stubs absorb the calls.
  let stubs = false;
  $('script').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') ?? '';
    if (src) {
      if (TRACKER_SRC.test(src)) {
        removeNode($, el);
        stats.trackersRemoved++;
        stubs = true;
      }
      return;
    }
    const code = $el.html() ?? '';
    if (/json/i.test($el.attr('type') ?? '') || !TRACKER_INLINE.test(code)) return;
    stubs = true;
    if (trackerOnly(code)) {
      removeNode($, el);
      stats.trackersRemoved++;
      return;
    }
    const kept = withoutLoaders(code);
    if (kept !== code) {
      $el.text(kept);
      stats.trackersRemoved++;
    }
  });
  $('noscript').each((_, el) => {
    const inner = $(el).html() ?? '';
    if (TRACKER_SRC.test(inner)) {
      removeNode($, el);
      stats.trackersRemoved++;
    }
  });
  $('ins.adsbygoogle, iframe[src*="googlesyndication"], iframe[src*="doubleclick"]').each((_, el) => {
    removeNode($, el);
    stats.trackersRemoved++;
  });
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    if (TRACKER_SRC.test(src)) {
      removeNode($, el);
      stats.trackersRemoved++;
    }
  });
  if (stubs) $('head').prepend(`<script>${TRACKER_STUBS}</script>\n`);
  return stats;
}
