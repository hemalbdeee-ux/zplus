// Old sites come in every encoding (windows-1252, Shift_JIS, GB2312, ...). Pages are decoded with
// the charset the original server declared and written back as UTF-8.

function validLabel(label: string): string | null {
  try {
    return new TextDecoder(label.trim().toLowerCase()).encoding;
  } catch {
    return null;
  }
}

export function detectCharset(body: Buffer, contentType: string): string {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';

  const fromHeader = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1];
  const head = body.subarray(0, 4096).toString('latin1');
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_:.-]+)/i.exec(head)?.[1];

  const declared = (fromHeader && validLabel(fromHeader)) || (fromMeta && validLabel(fromMeta)) || null;
  if (declared && declared !== 'utf-8') return declared;
  if (isValidUtf8(body)) return 'utf-8';
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

export function decodeText(body: Buffer, contentType: string): { text: string; charset: string } {
  const charset = detectCharset(body, contentType);
  const text = new TextDecoder(charset).decode(body);
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, charset };
}
