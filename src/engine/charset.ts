// Old sites come in every encoding (windows-1252, Shift_JIS, GB2312, ...). Pages are decoded with
// the charset the original server declared and written back as UTF-8.

function validLabel(label: string): string | null {
  try {
    return new TextDecoder(label.trim().toLowerCase()).encoding;
  } catch {
    return null;
  }
}

const SPACE = /[\t\n\f\r ]/;
// <noscript> is not one of them: the prescan runs with scripting off, so the tags in it count.
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes']);

type Attribute = { name: string; value: string; end: number };

/**
 * The next attribute of a tag from text[at], read as the prescan reads it ("get an attribute"):
 * names and values lowercased, quoted values may hold > and <. A number when there is none: where
 * the > that ends the tag is, or -1 when the text ends first.
 */
function nextAttribute(text: string, at: number): Attribute | number {
  let i = at;
  while (i < text.length && (SPACE.test(text[i]) || text[i] === '/')) i++;
  if (i >= text.length) return -1;
  if (text[i] === '>') return i;
  let name = text[i++];
  for (; i < text.length && text[i] !== '=' && !SPACE.test(text[i]) && text[i] !== '/' && text[i] !== '>'; i++) name += text[i];
  while (i < text.length && SPACE.test(text[i])) i++;
  if (text[i] !== '=') return { name: name.toLowerCase(), value: '', end: i };
  for (i++; i < text.length && SPACE.test(text[i]); i++);
  const quote = text[i] === '"' || text[i] === "'" ? text[i] : '';
  const from = quote ? i + 1 : i;
  if (quote) {
    i = text.indexOf(quote, from);
    if (i < 0) return -1;
  } else while (i < text.length && !SPACE.test(text[i]) && text[i] !== '>') i++;
  return { name: name.toLowerCase(), value: text.slice(from, i).toLowerCase(), end: quote ? i + 1 : i };
}

/** Reads the attributes of the tag from text[at] to its >; where that > is, or -1 when the text ends first. */
function readTag(text: string, at: number, each: (a: Attribute) => void): number {
  for (;;) {
    const a = nextAttribute(text, at);
    if (typeof a === 'number') return a;
    each(a);
    at = a.end;
  }
}

/** The charset named in a content="text/html; charset=..." value ("extracting a character encoding from a meta element"). */
function contentCharset(value: string): string | null {
  const re = /charset\s*(=?)\s*/g;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    if (!m[1]) continue;
    const rest = value.slice(m.index + m[0].length);
    if (rest[0] === '"' || rest[0] === "'") {
      const end = rest.indexOf(rest[0], 1);
      return end < 0 ? null : validLabel(rest.slice(1, end));
    }
    const label = /^[^\t\n\f\r ;]+/.exec(rest)?.[0];
    return label ? validLabel(label) : null;
  }
  return null;
}

/**
 * The encoding of the first <meta> that declares one, found the way browsers prescan a page:
 * tag by tag, past comments and attribute values, and a content="...charset=..." only with
 * http-equiv="Content-Type" (an old declaration left in a comment, or a keywords meta that says
 * "charset=", is not one). Each step moves forward, so the scan takes linear time.
 */
function metaEncoding(text: string): string | null {
  for (let i = text.indexOf('<'); i >= 0 && i < text.length; i = text.indexOf('<', i)) {
    if (text.startsWith('<!--', i)) {
      // A comment ends at --> (<!--> and <!---> are empty ones) or at --!>, as the tokenizer reads it.
      const end = text.indexOf('-->', i + 2);
      const bang = text.indexOf('--!>', i + 4);
      if (end < 0 && bang < 0) return null;
      i = bang >= 0 && (end < 0 || bang < end) ? bang + 4 : end + 3;
    } else if (/^<meta[\t\n\f\r /]/i.test(text.slice(i, i + 6))) {
      // Every attribute counts, a repeated one too, the last one winning, as in Chromium; a charset
      // attribute wins over content= whatever their order.
      let pragma = false;
      let need: boolean | null = null;
      let charset: string | null = null;
      const end = readTag(text, i + 5, (a) => {
        if (a.name === 'http-equiv') pragma ||= a.value === 'content-type';
        else if (a.name === 'charset') [charset, need] = [validLabel(a.value), false];
        else if (a.name === 'content' && need !== false) {
          const found = contentCharset(a.value);
          if (found) [charset, need] = [found, true];
        }
      });
      if (end < 0) return null;
      if (charset && need !== null && (pragma || !need)) return charset;
      i = end + 1;
    } else if (/^<\/?[a-z]/i.test(text.slice(i, i + 3))) {
      let at = i + 2;
      while (at < text.length && !SPACE.test(text[at]) && text[at] !== '>' && text[at] !== '/') at++;
      const name = text.slice(i + 1, at).toLowerCase();
      const end = readTag(text, at, () => {});
      if (end < 0) return null;
      i = end + 1;
      // A script or style holds text, not tags, as the tokenizer browsers prescan with knows.
      if (RAW_TEXT.has(name)) {
        const close = text.slice(i).search(new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'i'));
        if (close < 0) return null;
        i += close;
      }
    } else if (/^<[!/?]/.test(text.slice(i, i + 2))) {
      const end = text.indexOf('>', i + 2);
      if (end < 0) return null;
      i = end + 1;
    } else i++;
  }
  return null;
}

/** The encoding a browser takes from a <meta> or <?xml?> declaration, or null when there is none. */
function declaredInMarkup(body: Buffer): string | null {
  const head = body.subarray(0, 4096).toString('latin1');
  const xml = /^\s*<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_:.-]+)/i.exec(head)?.[1];
  let enc = metaEncoding(head) ?? (xml ? validLabel(xml) : null);
  if (!enc && body.length > 4096) {
    // Browsers still switch when the parser reaches a later <meta> (after a long script or keyword
    // list). Only the head is searched, so "charset=" in page text or code samples is not taken.
    const more = body.subarray(0, 65536).toString('latin1');
    const end = more.search(/<\/head[\s>]|<body[\s>]/i);
    enc = metaEncoding(end < 0 ? more : more.slice(0, end));
  }
  // The tag itself was read as ASCII, so a UTF-16 label in it cannot be true; browsers use UTF-8
  // (Word and FrontPage wrote charset=unicode on plain pages). Same rule for x-user-defined.
  if (enc === 'utf-16le' || enc === 'utf-16be') return 'utf-8';
  if (enc === 'x-user-defined') return 'windows-1252';
  return enc;
}

export function detectCharset(body: Buffer, contentType: string): string {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';

  const fromHeader = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1];
  const declared = (fromHeader && validLabel(fromHeader)) || declaredInMarkup(body);
  if (declared && declared !== 'utf-8') return declared;
  if (mostlyUtf8(body)) return 'utf-8';
  // Declared UTF-8 (or nothing) but the bytes are not: almost always windows-1252 in practice.
  return 'windows-1252';
}

export function isValidUtf8(body: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * A UTF-8 page with a stray windows-1252 byte (a © pasted from Word, a capture cut off mid-character)
 * is still UTF-8: a browser shows one U+FFFD and the rest intact. Only bytes that are mostly not
 * UTF-8 (a windows-1252 page labelled UTF-8) are better read as windows-1252.
 */
function mostlyUtf8(body: Buffer): boolean {
  if (isValidUtf8(body)) return true;
  let valid = 0;
  let invalid = 0;
  for (let i = 0; i < body.length; ) {
    const b = body[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    const len = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let k = 1;
    while (k < len && i + k < body.length) {
      const c = body[i + k];
      const lo = k === 1 && b === 0xe0 ? 0xa0 : k === 1 && b === 0xf0 ? 0x90 : 0x80;
      const hi = k === 1 && b === 0xed ? 0x9f : k === 1 && b === 0xf4 ? 0x8f : 0xbf;
      if (c < lo || c > hi) break;
      k++;
    }
    if (len && k === len) valid++;
    else if (len && i + k === body.length) break; // cut off at the end of the capture
    else invalid++;
    i += k;
  }
  // Each choice garbles the other's characters; pick the one that garbles fewer.
  return valid >= invalid;
}

export function decodeText(body: Buffer, contentType: string): { text: string; charset: string } {
  const charset = detectCharset(body, contentType);
  const text = new TextDecoder(charset).decode(body);
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, charset };
}
