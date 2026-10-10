// Old sites come in every encoding (windows-1252, Shift_JIS, GB2312, ...). Pages are decoded with
// the charset the original server declared and written back as UTF-8.

function validLabel(label: string): string | null {
  try {
    return new TextDecoder(label.trim().toLowerCase()).encoding;
  } catch {
    return null;
  }
}

/** The encoding of the first <meta> with a usable charset. Scans tag by tag, so a long or unclosed tag costs linear time. */
function metaEncoding(text: string): string | null {
  const re = /<meta[\s/]/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = text.indexOf('>', m.index);
    const label = /charset\s*=\s*(?:["']\s*)?([a-z0-9_:.-]+)/i.exec(text.slice(m.index, end < 0 ? undefined : end))?.[1];
    const enc = label ? validLabel(label) : null;
    if (enc) return enc;
    if (end < 0) break;
    re.lastIndex = end;
  }
  return null;
}

/** The encoding a browser takes from a <meta> or <?xml?> declaration, or null when there is none. */
function declaredInMarkup(body: Buffer): string | null {
  const head = body.subarray(0, 4096).toString('latin1');
  const xml = /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_:.-]+)/i.exec(head)?.[1];
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
