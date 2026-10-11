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
// A string in a script that names where a tracker loads from: a URL or path on a tracker host.
const TRACKER_URL = (s: string) => (s.includes('/') && TRACKER_SRC.test(s)) || /\b(?:matomo|piwik)\.(?:js|php)\b/i.test(s);
const IIFE = /^(?:[(!+~]|void\s)\s*(?:function\b|\(|async\b)/;
// What a loader's function does: declare and assign, find and insert the script tag, queue calls.
// An if, try or loop in it is a step when what it holds is (isLoaderStep).
const LOADER_STEP = /^(?:(?:var|let|const)\s|[\w$.[\]'"]+\s*=(?!=)|[^;{}]*?\.(?:push|insertBefore|appendChild|write|writeln)\s*\()/;
const JUMP = /^(?:return|break|continue)\b[^;{}()]*$/;
// What a loader calls as it runs: make and insert the script tag, queue the first hits, read the
// date or the page's address. Calls in the functions it defines run later, from the tracker.
const LOADER_CALL =
  /^(?:createElement|getElementsByTagName|getElementById|querySelector|insertBefore|appendChild|setAttribute|addEventListener|attachEvent|write|writeln|push|Date|getTime|now|random|floor|round|escape|unescape|encodeURIComponent|encodeURI|indexOf|toString|String|Number|parseInt|replace|split|join|slice|substring|substr|toLowerCase|test|match|apply|call)$/;
const NOT_CALLEE = /^(?:if|for|while|switch|catch|with|function|return|typeof|void|delete|in|of|instanceof|new|await|yield|case|do|else|throw)$/;
// Yandex's watch.js runs its own insert function f now or on DOMContentLoaded: f(); d.addEventListener('...', f, false).
const LOCAL_CALL = /^(?:[\w$.]+\.(?:addEventListener|attachEvent)\(\s*(['"])\w+\1\s*,\s*([\w$]+)\s*(?:,\s*\w+\s*)?|([\w$]+)\(\s*)\)$/;
// A link to a tracker's site (a stats badge) loads nothing from it.
const HREF = /\bhref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;
const loadsFrom = (s: string) => TRACKER_URL(s.replace(HREF, ''));
// /* ... */ and // ... comments, but not the // of a URL in a string ('https://', '//host', src=//host).
const COMMENTS = /\/\*[\s\S]*?\*\/|(^|[^:'"\\=])\/\/.*$/gm;
// How deep the search for a loader goes into blocks: callbacks, if bodies, functions.
const MAX_DEPTH = 6;
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

/** Where the template literal that starts at i ends, past its ${...} parts and the templates in them; -1 if it does not. */
function templateEnd(code: string, i: number, depth = 0): number {
  if (depth > 20) return -1;
  for (i++; i < code.length; i++) {
    if (code[i] === '\\') i++;
    else if (code[i] === '`') return i + 1;
    else if (code[i] === '$' && code[i + 1] === '{') {
      let braces = 1;
      for (i += 2; i < code.length; i++) {
        const c = code[i];
        if (c === '{') braces++;
        else if (c === '}' && --braces === 0) break;
        else if (c === '`') {
          i = templateEnd(code, i, depth + 1) - 1;
          if (i < 0) return -1;
        } else if (c === '"' || c === "'") {
          for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
        }
      }
    }
  }
  return -1;
}

/** Is toks[k] one of these keywords, and not a property such as Symbol.for or promise.catch? */
const isKeyword = (toks: Tok[], k: number, words: RegExp) => toks[k].kind === 'w' && words.test(toks[k].v) && toks[k - 1]?.v !== '.';
const endsExpression = (t: Tok) => t.kind === 's' || (t.kind === 'w' && !EXPR_KEYWORDS.has(t.v)) || /^[)\]}]$/.test(t.v);

/** Do the tokens end with ++ or --? A / after n++ divides; it does not start a regex. */
function postfix(out: Tok[]): boolean {
  const a = out[out.length - 2];
  const b = out[out.length - 1];
  return !!a && (b.v === '+' || b.v === '-') && a.v === b.v && a.end === b.start;
}

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
    if (c === '`') {
      i = templateEnd(code, i);
      if (i < 0) return null;
      kind = 's';
    } else if (c === '"' || c === "'") {
      for (i++; i < code.length && code[i] !== c; i++) {
        if (code[i] === '\\') i++;
        else if (EOL.test(code[i])) return null;
      }
      if (i++ >= code.length) return null;
      kind = 's';
    } else if (c === '/' && (!prev || (prev.kind === 'w' ? EXPR_KEYWORDS.has(prev.v) : prev.kind === 'p' && !/[)\]}]/.test(prev.v) && !postfix(out)))) {
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

/** Index of the bracket that closes the one at toks[k], or -1. */
function closing(toks: Tok[], k: number): number {
  for (let depth = 0; k < toks.length; k++) {
    if (toks[k].kind !== 'p') continue;
    if ('([{'.includes(toks[k].v)) depth++;
    else if (')]}'.includes(toks[k].v) && --depth === 0) return k;
  }
  return -1;
}

/** Index of the bracket that opens the one that closes at toks[k], or -1. */
function opening(toks: Tok[], k: number): number {
  for (let depth = 0; k >= 0; k--) {
    if (toks[k].kind !== 'p') continue;
    if (')]}'.includes(toks[k].v)) depth++;
    else if ('([{'.includes(toks[k].v) && --depth === 0) return k;
  }
  return -1;
}

type BodyEnd = '' | 'statement' | 'do' | 'arrow';

/**
 * What the { at cur[open] opens: the body of a statement (a block, if, loop, try, switch, or a
 * function or class declaration), the body of a do-while or of an arrow function, or an
 * expression (an object literal, a function expression's body).
 */
function bodyKind(cur: Tok[], open: number): BodyEnd {
  if (open === 0) return 'statement';
  const prev = cur[open - 1];
  if (prev.kind === 'w') {
    if (prev.v === 'do') return 'do';
    if (/^(?:else|try|finally|catch)$/.test(prev.v)) return 'statement';
    return cur[0].v === 'class' && cur.findIndex((t) => t.v === '{') === open ? 'statement' : '';
  }
  if (prev.v === '>' && cur[open - 2]?.v === '=' && cur[open - 2].end === prev.start) return 'arrow';
  if (open === 2 && prev.v === ':' && cur[0].kind === 'w') return 'statement'; // label: { ... }
  if (prev.v !== ')') return '';
  const p = opening(cur, open - 1);
  if (p > 0 && isKeyword(cur, p - 1, /^(?:if|for|while|with|switch|catch)$/)) return 'statement';
  // function name(...) { at the start of the statement declares the function.
  let k = cur[0].v === 'async' ? 1 : 0;
  if (cur[k]?.v !== 'function') return '';
  if (cur[++k]?.v === '*') k++;
  return cur[k]?.kind === 'w' && k + 1 === p ? 'statement' : '';
}

/** Does token t, at the top level, start a new statement after the tokens of the current one? */
function startsStatement(cur: Tok[], t: Tok, bodyEnd: BodyEnd, next: Tok | undefined): boolean {
  const last = cur[cur.length - 1];
  if (t.v === ';') return false;
  if (t.kind === 'w' && /^(?:else|catch|finally|in|instanceof|of)$/.test(t.v)) return false;
  if (t.v === 'while' && (bodyEnd === 'do' || cur[0].v === 'do')) return false;
  // A function declaration or a block statement ends at its closing }, so even a ( or [ after it
  // starts the next statement. Nothing can call an arrow function's body either, though a comma
  // or the : of a ?: can follow it.
  if (bodyEnd === 'statement' || bodyEnd === 'do' || (bodyEnd === 'arrow' && t.nl && t.v !== ',' && t.v !== ':')) return true;
  // The ) of if (x), for (...) or while (x) comes before its body, maybe on the next line; the ) of
  // do { ... } while (x) ends the statement.
  const head = last.v === ')' ? opening(cur, cur.length - 1) : -1;
  if (head > 0 && cur[head - 1].v === 'while' && (cur[head - 2]?.v === '}' ? cur[opening(cur, head - 2) - 1]?.v === 'do' : cur[0].v === 'do')) return true;
  if (head > 0 && isKeyword(cur, head - 1, /^(?:if|for|while|with)$/)) return false;
  // return, break and continue end at a line break; so does the expression before a ++ or -- there.
  if (t.nl && last.kind === 'w' && /^(?:return|break|continue)$/.test(last.v)) return true;
  const ends = endsExpression(last) || (postfix(cur) && !!cur[cur.length - 3] && endsExpression(cur[cur.length - 3]));
  if (ends && t.nl && (t.v === '+' || t.v === '-') && next?.v === t.v && next.start === t.end) return true;
  if (t.kind === 'p' && t.v !== '!' && t.v !== '~') return false; // ( [ . + = ... continue an expression
  return ends && (t.nl || (last.v === '}' && t.v !== 'from')); // import { a } from 'b'
}

/** The top-level statements of a script (each with its own tokens), or null when it cannot be split. */
function statements(code: string): Tok[][] | null {
  const toks = jsTokens(code);
  if (!toks) return null;
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  const opens: number[] = []; // where in cur each open bracket is
  let bodyEnd: BodyEnd = '';
  for (const [i, t] of toks.entries()) {
    if (!opens.length) {
      // if (a) x(); else y(); and do x(); while (y); are one statement each.
      if (!cur.length && out.length && (t.v === 'else' || (t.v === 'while' && out[out.length - 1][0].v === 'do' && !out[out.length - 1].some((x) => x.v === 'while')))) cur = out.pop()!;
      else if (cur.length && startsStatement(cur, t, bodyEnd, toks[i + 1])) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(t);
    bodyEnd = '';
    if (t.kind !== 'p') continue;
    if ('([{'.includes(t.v)) opens.push(cur.length - 1);
    else if (')]}'.includes(t.v)) {
      const open = opens.pop();
      if (open === undefined) return null;
      if (t.v === '}' && !opens.length) bodyEnd = bodyKind(cur, open);
    } else if (t.v === ';' && !opens.length) {
      if (cur.length > 1) out.push(cur); // a lone ; is an empty statement
      cur = [];
    }
  }
  if (opens.length) return null;
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

/** The source of a for or while loop's body, braces left off. */
function loopBody(code: string, st: Tok[]): string | null {
  if (st[1]?.v !== '(') return null;
  let k = 1;
  for (let depth = 0; k < st.length; k++) {
    if ('([{'.includes(st[k].v)) depth++;
    else if (')]}'.includes(st[k].v) && --depth === 0) break;
  }
  const body = st.slice(k + 1, st[st.length - 1].v === ';' ? -1 : undefined);
  if (!body.length) return null;
  const braced = body[0].v === '{' && body[body.length - 1].v === '}';
  return braced ? code.slice(body[0].end, body[body.length - 1].start) : code.slice(body[0].start, body[body.length - 1].end);
}

type Part = { body: string; start: number; braced: boolean };

/** The branches of an if statement (if, else if, else) and where each starts; null when it cannot tell. */
function ifBranches(code: string, st: Tok[]): Part[] | null {
  const out: Part[] = [];
  const end = st.length > 1 && st[st.length - 1].v === ';' ? st.length - 1 : st.length;
  // The branch that starts at st[k], a block or one statement up to its else; its last token.
  const branch = (k: number): number => {
    // A nested if or loop without braces leaves open whose else comes next.
    if (k >= end || /^(?:if|for|while|do|with|try|switch)$/.test(st[k].v)) return -1;
    let stop = k;
    if (st[k].v === '{') stop = closing(st, k);
    else {
      for (let depth = 0; stop < end - 1; stop++) {
        const v = st[stop].kind === 'p' ? st[stop].v : '';
        if (v && '([{'.includes(v)) depth++;
        else if (v && ')]}'.includes(v)) depth--;
        if (depth === 0 && st[stop + 1].v === 'else') break;
      }
    }
    if (stop < 0 || stop >= end) return -1;
    const braced = st[k].v === '{';
    out.push(braced ? { body: code.slice(st[k].end, st[stop].start), start: st[k].end, braced } : { body: code.slice(st[k].start, st[stop].end), start: st[k].start, braced });
    return stop;
  };
  for (let k = 0; ; ) {
    if (st[k]?.v !== 'if' || st[k + 1]?.v !== '(') return null;
    const stop = branch(closing(st, k + 1) + 1);
    if (stop < 0) return null;
    k = stop + 1;
    if (k >= end) return out;
    if (st[k].v !== 'else') return null;
    if (st[++k]?.v !== 'if') return branch(k) === end - 1 ? out : null;
  }
}

/** Does every statement in each part pass the test? */
function everyStatement(parts: Array<{ body: string }>, ok: (code: string, st: Tok[]) => boolean): boolean {
  return parts.every((p) => {
    const list = statements(p.body);
    return !!list && list.every((st) => ok(p.body, st));
  });
}

/** return, break or continue, or an if that does nothing else. */
function isJump(code: string, st: Tok[], depth = 0): boolean {
  if (st[0].v !== 'if') return JUMP.test(textOf(code, st));
  const branches = depth < 3 ? ifBranches(code, st) : null;
  return !!branches && everyStatement(branches, (c, s) => isJump(c, s, depth + 1));
}

/** Names that the statements declare with var, let, const or function, each with the source of its initial value ('' for none). */
function declarations(code: string, list: Tok[][]): Map<string, string> {
  const names = new Map<string, string>();
  for (const st of list) {
    if (st[0].v === 'function' && st[1]?.kind === 'w') names.set(st[1].v, '');
    if (!/^(?:var|let|const)$/.test(st[0].v)) continue;
    let depth = 0;
    let name = '';
    let from = -1;
    const end = (k: number) => {
      if (name) names.set(name, from < 0 || from >= k ? '' : code.slice(st[from].start, st[k - 1].end));
      name = '';
      from = -1;
    };
    for (let k = 1; k < st.length; k++) {
      const t = st[k];
      if (depth === 0 && t.v === ',') end(k);
      else if (depth === 0 && t.v === ';' && k === st.length - 1) break;
      else if (t.kind === 'w' && depth === 0 && (k === 1 || st[k - 1].v === ',')) name = t.v;
      else if (depth === 0 && t.v === '=' && from < 0 && st[k - 1].kind === 'w') from = k + 1;
      if (t.kind !== 'p') continue;
      if ('([{'.includes(t.v)) depth++;
      else if (')]}'.includes(t.v)) depth--;
    }
    end(st[st.length - 1].v === ';' ? st.length - 1 : st.length);
  }
  return names;
}

// The global object and the document, by name. A loader may set tracker globals on them, nothing else.
const GLOBAL_OBJECT = /^(?:window|document|self|top|parent|globalThis|this)$/;
// What a page element or the global object comes from; createElement makes the loader's own script tag.
const PAGE_VALUE = /^(?:window|document|self|top|parent|globalThis|this)\s*(?:$|[.[])|\b(?:getElementById|getElementsBy\w+|querySelector(?:All)?)\s*\(/;
// Globals the snippets set on window besides TRACKER_VAR: hj, lintrk, i['GoogleAnalyticsObject'] ...
const TRACKER_SLOT = /^(?:hj|lintrk|_linkedin_\w+|ym|uetq|twq|GoogleAnalyticsObject|yandex_metrika_callbacks)$/;

/**
 * What a loader's function works with: its parameters and the names it declares (locals); those
 * of them that hold the window, the document or one of the page's elements (page); and its
 * parameters, which in a snippet carry the names of the globals it sets: i[r] = ..., w[l] = ...
 */
interface Scope {
  locals: Set<string>;
  page: Set<string>;
  params: Set<string>;
}

function iifeScope(code: string, st: Tok[], body: string, inner: Tok[][]): Scope {
  const params = new Set<string>();
  const page = new Set<string>();
  const open = st.findIndex((t) => t.v === '{');
  const arrow = st[open - 1]?.v === '>' && st[open - 2]?.v === '=';
  const head = arrow ? open - 3 : open - 1;
  const p = st[head]?.v === ')' ? opening(st, head) : -1;
  const names = p < 0 ? [] : st.slice(p + 1, head).filter((t, k, a) => t.kind === 'w' && (k === 0 || a[k - 1].v === ','));
  // The arguments it is called with: })(window, document, 'script', ...) or }(window, ...)
  let k = closing(st, open) + 1;
  if (st[k]?.v === ')') k++;
  const args: string[] = [];
  const close = st[k]?.v === '(' ? closing(st, k) : -1;
  for (let from = k + 1, j = k + 1, depth = 0; close > 0 && j <= close; j++) {
    if (depth === 0 && (st[j].v === ',' || j === close)) {
      args.push(j > from ? code.slice(st[from].start, st[j - 1].end) : '');
      from = j + 1;
    } else if (st[j].kind === 'p' && '([{'.includes(st[j].v)) depth++;
    else if (st[j].kind === 'p' && ')]}'.includes(st[j].v)) depth--;
  }
  names.forEach((t, i) => {
    params.add(t.v);
    if (GLOBAL_OBJECT.test(args[i] ?? '') || /^(?:window|self|top)\.document$/.test(args[i] ?? '')) page.add(t.v);
  });
  const locals = new Set(params);
  for (const [name, init] of declarations(body, inner)) {
    locals.add(name);
    page.delete(name);
    const root = /^[\w$]+/.exec(init)?.[0];
    if (!/\bcreateElement\s*\(/.test(init) && (PAGE_VALUE.test(init) || (!!root && page.has(root) && /^[\w$]+\s*(?:$|[.[])/.test(init)))) page.add(name);
  }
  return { locals, page, params };
}

/** Does the = at st[k] assign (=, +=, ||= ...), as opposed to compare (==, !=, <=) or start an arrow (=>)? Where its target ends, or -1. */
function assignmentTarget(st: Tok[], k: number): number {
  const adjacent = (a: Tok | undefined, b: Tok | undefined) => !!a && !!b && a.end === b.start;
  if (adjacent(st[k], st[k + 1]) && (st[k + 1].v === '=' || st[k + 1].v === '>')) return -1;
  let j = k - 1;
  if (adjacent(st[j], st[k]) && st[j].kind === 'p') {
    if (st[j].v === '=' || st[j].v === '!') return -1;
    if ((st[j].v === '<' || st[j].v === '>') && !(adjacent(st[j - 1], st[j]) && st[j - 1].v === st[j].v)) return -1;
    while (st[j]?.kind === 'p' && /^[-+*/%&|^<>?]$/.test(st[j].v) && adjacent(st[j], st[j + 1])) j--;
  }
  return j;
}

/**
 * May a loader make this assignment? It may set its own variables and what they hold (the script
 * tag it made, its queue function), and tracker globals on the window; not a handler, a function
 * or settings of the site's own on the window or on an element of the page.
 */
function loaderMayAssign(st: Tok[], end: number, scope: Scope): boolean {
  // The target is a name followed by .name and [key] parts: find its root and the part after it.
  let j = end;
  let first: { key: Tok[]; bracket: boolean } | undefined;
  while (st[j]?.v === ']' || (st[j]?.kind === 'w' && st[j - 1]?.v === '.')) {
    if (st[j].v === ']') {
      const o = opening(st, j);
      if (o < 1) return false;
      first = { key: st.slice(o + 1, j), bracket: true };
      j = o - 1;
    } else {
      first = { key: [st[j]], bracket: false };
      j -= 2;
    }
  }
  // Anything but a name is the result of a call: document.getElementById('menu').onclick = ...
  if (st[j]?.kind !== 'w') return false;
  const root = st[j].v;
  const trackerName = (name: string) => TRACKER_VAR.test(name) || TRACKER_SLOT.test(name);
  if (!first) return scope.locals.has(root) || trackerName(root);
  if (scope.page.has(root) || (GLOBAL_OBJECT.test(root) && !scope.locals.has(root))) {
    // On the window or the document only a tracker global: w.fbq, i['GoogleAnalyticsObject'], or
    // w[l] with the name l passed in as the snippet's argument.
    const [t, more] = first.key;
    if (!t || more) return false;
    if (first.bracket && t.kind === 'w') return scope.params.has(t.v);
    return trackerName(t.kind === 's' ? t.v.slice(1, -1) : t.v);
  }
  return scope.locals.has(root) || trackerName(root);
}

/** Is st a statement of a loader's function? */
function isLoaderStep(code: string, st: Tok[], scope: Scope, depth = 0): boolean {
  const head = st[0].v;
  // A loop only checks whether the page has the tracker already (Yandex):
  // for (...) { if (document.scripts[j].src === r) { return; } }
  if (head === 'for' || head === 'while') {
    const body = depth < 2 ? loopBody(code, st) : null; // no snippet nests loops deeper
    return body !== null && everyStatement([{ body }], isJump);
  }
  // The branches of an if and the blocks of a try hold steps too, not the site's own code:
  // if (!f._fbq) f._fbq = n; but not if (nav) { initDropdowns(nav); }
  if (head === 'if' || head === 'try') {
    const parts = depth < 3 ? (head === 'if' ? ifBranches(code, st) : blocks(code, st)) : null;
    return !!parts && parts.length > 0 && everyStatement(parts, (c, s) => isLoaderStep(c, s, scope, depth + 1));
  }
  const text = textOf(code, st);
  const call = LOCAL_CALL.exec(text);
  const step = JUMP.test(text) || LOADER_STEP.test(text) || (!!call && scope.locals.has(call[2] ?? call[3]));
  return step && loaderCallsOnly(st, scope);
}

/**
 * Does the statement call only what a loader calls (LOADER_CALL) and the loader's own functions,
 * and assign only what a loader may (loaderMayAssign)?
 */
function loaderCallsOnly(st: Tok[], scope: Scope): boolean {
  for (let k = 0; k < st.length; k++) {
    const t = st[k];
    // The body of a function it defines: function (...) { ... } and () => { ... }
    if (t.v === 'function' && t.kind === 'w') {
      let j = k + 1;
      if (st[j]?.v === '*') j++;
      if (st[j]?.kind === 'w') j++;
      if (st[j]?.v !== '(') return false;
      j = closing(st, j) + 1;
      if (st[j]?.v !== '{') return false;
      k = closing(st, j);
      if (k < 0) return false;
    } else if (t.v === '>' && st[k - 1]?.v === '=' && st[k - 1].end === t.start && st[k + 1]?.v === '{') {
      k = closing(st, k + 1);
      if (k < 0) return false;
    } else if (t.v === '(' && t.kind === 'p' && k > 0) {
      const callee = st[k - 1];
      if (callee.kind === 'w' ? !NOT_CALLEE.test(callee.v) && !LOADER_CALL.test(callee.v) && !scope.locals.has(callee.v) : /^[)\]]$|^[`'"]/.test(callee.v)) return false;
    } else if (t.v === '=' && t.kind === 'p') {
      const end = assignmentTarget(st, k);
      if (end >= 0 && !loaderMayAssign(st, end, scope)) return false;
    }
  }
  return true;
}

/** What a document.write call writes, as far as its strings say: '<sc' + 'ript', %3C and \x3C put back. */
function written(st: Tok[]): string {
  return st
    .filter((t) => t.kind === 's' && t.v[0] !== '/')
    .map((t) => t.v.slice(1, -1))
    .join('')
    .replace(/\\x([0-9a-f]{2})|%([0-9a-f]{2})/gi, (_, x?: string, pct?: string) => String.fromCharCode(parseInt(x ?? pct ?? '', 16)))
    .replace(/\\(.)/g, '$1');
}

function isLoader(code: string, st: Tok[], inTry = false): boolean {
  const text = textOf(code, st);
  if (/^document\.write(?:ln)?\s*\(/.test(text)) return TRACKER_LOADER.test(written(st).replace(HREF, '')) && !/\bfunction\b/.test(text);
  if (IIFE.test(text)) {
    if (!TRACKER_LOADER.test(text)) return false;
    // A loader's function only sets up its queue and inserts the script tag. One that does more is
    // the site's own code wrapped around a snippet.
    const fn = iifeBody(code, st);
    const inner = fn && statements(fn.body);
    if (!fn || !inner) return false;
    const scope = iifeScope(code, st, fn.body, inner);
    return inner.every((s) => isLoaderStep(fn.body, s, scope));
  }
  // try { var pageTracker = _gat._getTracker("UA-1"); pageTracker._trackPageview(); } catch (err) {}
  const m = /^try\s*\{([\s\S]*)\}\s*catch\s*\(\s*\w+\s*\)\s*\{\s*\}$/.exec(text);
  return !!m && !inTry && trackerOnly(m[1], true);
}

/** x.src = '//www.google-analytics.com/ga.js': the step that makes a loader load anything. */
function setsTrackerSrc(code: string, st: Tok[]): boolean {
  const text = textOf(code, st);
  return (
    /^(?:new\s+)?[\w$.[\]'"()]+\.(?:src\s*=(?!=)|setAttribute\(\s*['"]src['"])/.test(text) &&
    st.some((t) => t.kind === 's' && TRACKER_URL(t.v))
  );
}

function isTrackerStatement(code: string, st: Tok[], inTry = false): boolean {
  if (isLoader(code, st, inTry)) return true;
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
function trackerOnly(code: string, inTry = false): boolean {
  const list = statements(code);
  return !!list && list.length > 0 && list.every((st) => isTrackerStatement(code, st, inTry));
}

function compiles(code: string): boolean {
  try {
    new Script(code); // compiled only, never run
    return true;
  } catch {
    return false;
  }
}

/** The source inside each outermost { } of a statement: function bodies, if and else blocks, callbacks. */
function blocks(code: string, st: Tok[]): Array<{ body: string; start: number }> {
  const out: Array<{ body: string; start: number }> = [];
  let depth = 0;
  let open = 0;
  for (const t of st) {
    if (t.kind !== 'p') continue;
    if (t.v === '{' && depth++ === 0) open = t.end;
    else if (t.v === '}' && --depth === 0) out.push({ body: code.slice(open, t.start), start: open });
  }
  return out;
}

/**
 * Where the tracker loaders are in a script: whole loader snippets and the statements that point a
 * script tag at a tracker, also inside the site's own functions, callbacks and if blocks (a
 * consent check, a delayed loadGTM(), MonsterInsights' if (mi_track_user) { ... }).
 */
function loaderRanges(code: string, base = 0, depth = 0): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const st of statements(code) ?? []) {
    if (isLoader(code, st) || setsTrackerSrc(code, st)) out.push([base + st[0].start, base + st[st.length - 1].end]);
    else if (depth < MAX_DEPTH) {
      const parts: Part[] = (st[0].v === 'if' && ifBranches(code, st)) || blocks(code, st).map((b) => ({ ...b, braced: true }));
      for (const b of parts) out.push(...loaderRanges(b.body, base + b.start, depth + 1));
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
  // An empty statement takes the loader's place. It ends the statement before, which may have no
  // ; of its own (var a = 'x' then !function(){...}(); then (function(){...})() would otherwise
  // read as 'x'(...)), and keeps an unbraced branch: if (ok) ; else ...
  for (const [start, end] of cuts) {
    out += code.slice(at, start) + ';';
    at = end;
  }
  out += code.slice(at);
  return compiles(out) || !compiles(code) ? out : code;
}

/**
 * The script with each string that is the address of a tracker (handed to $.getScript, a site's
 * own loadScript() or a consent handler) turned into an empty data: URL, so nothing loads from it
 * and the code around it still runs; null when there is none or the result does not compile.
 */
function defused(code: string, tokens: Tok[]): string | null {
  let out = '';
  let at = 0;
  for (const t of tokens) {
    // A regex literal is no address; nor is markup (a stats badge written into the page).
    if (t.kind !== 's' || t.v[0] === '/' || /[\s<>]/.test(t.v) || !loadsFrom(t.v)) continue;
    out += code.slice(at, t.start) + t.v[0] + 'data:,' + t.v[0];
    at = t.end;
  }
  if (!at) return null;
  out += code.slice(at);
  return compiles(out) ? out : null;
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
    if (/json/i.test($el.attr('type') ?? '')) return;
    const calls = TRACKER_INLINE.test(code);
    if (!calls && !TRACKER_LOADER.test(code)) return;
    if (trackerOnly(code)) {
      removeNode($, el);
      stats.trackersRemoved++;
      stubs = true;
      return;
    }
    let kept = withoutLoaders(code);
    let tokens = jsTokens(kept);
    // When the script does not lex, comments are cut roughly so that a URL in one does not count.
    const pointsAt = () => (tokens ? tokens.some((t) => t.kind === 's' && loadsFrom(t.v)) : loadsFrom(kept.replace(COMMENTS, '$1')));
    let pointsAtTracker = pointsAt();
    // A tracker address handed to a loader that is not cut out (jQuery's $.getScript, the site's
    // own loadScript) goes on its own, the site code around it stays.
    const safe = calls && pointsAtTracker && tokens ? defused(kept, tokens) : null;
    if (safe) {
      kept = safe;
      tokens = jsTokens(kept);
      pointsAtTracker = pointsAt();
    }
    // Last resort, as before: a script that calls a tracker and still names where one loads from
    // (in markup it writes, or a loader that could not be cut out cleanly) goes whole rather than load it.
    if (calls && pointsAtTracker) {
      removeNode($, el);
      stats.trackersRemoved++;
    } else if (kept !== code) {
      $el.text(kept);
      stats.trackersRemoved++;
    } else if (!calls) return;
    stubs = true;
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
