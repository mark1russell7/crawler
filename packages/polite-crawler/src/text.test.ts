import { describe, expect, it } from "vitest";
import { bodyEncoding, decodeBody } from "./text.ts";

const bytes = (...parts: Array<string | Iterable<number>>): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const char of part) out.push(char.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
};

// "Café", "Mon–Fri 11am–9pm" in windows-1252: é is 0xE9, the en dash 0x96
const LEGACY = bytes(
  "<html><head><title>Caf",
  [0xe9],
  "</title></head><body><p>Mon",
  [0x96],
  "Fri 11am",
  [0x96],
  "9pm</p></body></html>",
);

describe("decoding a body in the encoding the page declares", () => {
  it("honours the charset of the Content-Type header", () => {
    const text = decodeBody(LEGACY, "text/html; charset=windows-1252");
    expect(text).toContain("<title>Café</title>");
    expect(text).toContain("Mon–Fri 11am–9pm");
    expect(decodeBody(LEGACY, 'text/html; charset="ISO-8859-1"')).toContain("Café");
  });

  it("reads a <meta charset> or an http-equiv declaration when the header says nothing", () => {
    const meta = bytes('<meta charset="windows-1252">', LEGACY);
    expect(decodeBody(meta, "text/html")).toContain("Mon–Fri 11am–9pm");
    const equiv = bytes(
      '<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><p>',
      [0x93, 0xfa, 0x96, 0x7b],
      "</p>",
    );
    expect(decodeBody(equiv, "text/html")).toContain("<p>日本</p>");
    // a declaration inside a comment declares nothing
    const commented = bytes('<!-- <meta charset="shift_jis"> --><p>caf', [0xc3, 0xa9], "</p>");
    expect(decodeBody(commented, "text/html")).toContain("café");
  });

  it("lets a byte order mark win, as a browser does", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from("<p>Hi</p>").flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(decodeBody(utf16, "text/html; charset=iso-8859-1")).toBe("<p>Hi</p>");
    expect(bodyEncoding(utf16, null)).toBe("utf-16le");
    expect(decodeBody(bytes([0xef, 0xbb, 0xbf], "<p>caf", [0xc3, 0xa9]), "text/html")).toBe("<p>café");
  });

  it("reads a page that a browser rendered as UTF-8, though the page still declares its old encoding", () => {
    const rendered = new TextEncoder().encode('<meta charset="windows-1252"><title>Café</title>');
    expect(decodeBody(rendered, "text/html")).toContain("Café");
  });

  it("falls back to UTF-8, and to windows-1252 for bytes that are not UTF-8", () => {
    expect(decodeBody(new TextEncoder().encode("<p>Mon–Fri</p>"), "text/html")).toBe("<p>Mon–Fri</p>");
    expect(decodeBody(LEGACY, "text/html")).toContain("Mon–Fri 11am–9pm");
    expect(decodeBody(LEGACY, null)).toContain("Café");
    // a body cut at its size limit inside a character is still UTF-8
    const cut = new TextEncoder().encode("<p>Mon–Fri 9–5 café").slice(0, -1);
    expect(bodyEncoding(cut, "text/html")).toBe("utf-8");
  });

  it("never throws on an unknown label, and keeps JSON in UTF-8", () => {
    expect(decodeBody(bytes("<p>ok</p>"), "text/html; charset=no-such-thing")).toBe("<p>ok</p>");
    expect(bodyEncoding(LEGACY, "application/json")).toBe("utf-8");
    expect(decodeBody(new Uint8Array(0), null)).toBe("");
  });
});
