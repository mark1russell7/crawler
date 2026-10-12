/**
 * The body decoder changes the bytes of a response into text. It finds the encoding in this order,
 * as the WHATWG encoding rules and the browsers do:
 *
 * 1. A byte order mark.
 * 2. The `charset` of the `Content-Type` header.
 * 3. A `<meta charset>` or `http-equiv` declaration in the first 2,048 bytes of an HTML page, or the
 *    encoding of an XML declaration.
 * 4. UTF-8 when the bytes are UTF-8, and windows-1252 when they are not.
 *
 * It uses only `TextDecoder`, so it operates in a browser too. A byte that the encoding does not
 * know becomes U+FFFD. The decoder does not throw.
 */

const PRESCAN_BYTES = 2048;

/** This function gives the WHATWG name of an encoding label, or undefined when the runtime does not know the label. */
const encodingOf = (label: string): string | undefined => {
  try {
    return new TextDecoder(label.trim().toLowerCase()).encoding;
  } catch {
    return undefined;
  }
};

const bomOf = (bytes: Uint8Array): string | undefined => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return undefined;
};

/** This function gives the `charset` parameter of a media type, or undefined. */
const charsetOf = (contentType: string | null): string | undefined => {
  if (contentType === null) return undefined;
  const match = /;\s*charset\s*=\s*(?:"([^"]*)"|([^\s;"]+))/i.exec(contentType.slice(0, 512));
  return match?.[1] ?? match?.[2] ?? undefined;
};

/** This function reads the encoding that the start of an HTML or XML document declares. */
const declaredCharset = (bytes: Uint8Array): string | undefined => {
  let head = "";
  const end = Math.min(bytes.length, PRESCAN_BYTES);
  for (let index = 0; index < end; index += 1) head += String.fromCharCode(bytes[index]!);
  const xml = /^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (xml !== null) return xml[1];
  // a declaration inside a comment declares nothing
  const markup = head.replace(/<!--[\s\S]*?-->/g, "");
  // `<meta charset=x>`, and `<meta http-equiv="Content-Type" content="text/html; charset=x">`
  const meta = /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([A-Za-z0-9_:.+-]+)/i.exec(markup);
  return meta?.[1];
};

/**
 * This function counts the UTF-8 sequences of more than one byte, and the bytes that no UTF-8
 * sequence explains. An incomplete sequence at the end is no error: a body cut at its size limit
 * ends so.
 */
const utf8Evidence = (bytes: Uint8Array): { readonly multibyte: number; readonly invalid: number } => {
  let multibyte = 0;
  let invalid = 0;
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index]!;
    if (lead < 0x80) {
      index += 1;
      continue;
    }
    const need =
      lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0;
    if (need === 0) {
      invalid += 1;
      index += 1;
      continue;
    }
    // the second byte has a narrower range after E0, ED, F0 and F4
    const low = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
    const high = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
    let ok = true;
    let at = 1;
    while (at <= need && index + at < bytes.length) {
      const next = bytes[index + at]!;
      if (at === 1 ? next < low || next > high : next < 0x80 || next > 0xbf) {
        ok = false;
        break;
      }
      at += 1;
    }
    // the body ends inside the sequence
    if (ok && at <= need) break;
    if (ok) {
      multibyte += 1;
      index += need + 1;
    } else {
      invalid += 1;
      index += 1;
    }
  }
  return { multibyte, invalid };
};

/**
 * This function gives the WHATWG name of the encoding of a body, for example `utf-8` or
 * `windows-1252`. The function `decodeBody` uses it.
 */
export const bodyEncoding = (bytes: Uint8Array, contentType: string | null): string => {
  const bom = bomOf(bytes);
  if (bom !== undefined) return bom;
  const header = charsetOf(contentType);
  const fromHeader = header === undefined ? undefined : encodingOf(header);
  if (fromHeader !== undefined) return fromHeader;
  if (contentType === null || /html|xml/i.test(contentType)) {
    const label = declaredCharset(bytes);
    let declared = label === undefined ? undefined : encodingOf(label);
    // the HTML standard reads a UTF-16 declaration in ASCII-compatible bytes as UTF-8
    if (declared?.startsWith("utf-16") === true) declared = "utf-8";
    if (declared === "x-user-defined") declared = "windows-1252";
    if (declared === "utf-8") return declared;
    if (declared !== undefined) {
      // A browser serialises the page it rendered as UTF-8, and the old declaration stays. UTF-8
      // with no error is almost never a legacy encoding by chance.
      const evidence = utf8Evidence(bytes);
      return evidence.invalid === 0 && evidence.multibyte > 0 ? "utf-8" : declared;
    }
  }
  if (/json/i.test(contentType ?? "")) return "utf-8";
  const evidence = utf8Evidence(bytes);
  return evidence.invalid > 0 && evidence.invalid >= evidence.multibyte ? "windows-1252" : "utf-8";
};

/**
 * This function decodes the body of a response. It reads the encoding from the byte order mark,
 * the `Content-Type` header and the document, with `bodyEncoding`. It does not throw.
 */
export const decodeBody = (bytes: Uint8Array, contentType: string | null): string => {
  const encoding = bodyEncoding(bytes, contentType);
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    // a runtime with a small ICU knows only a few encodings
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
};
