import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isPdf, readPdf } from "./pdf.ts";
import { pageExtractor } from "./runtime.ts";

/** a one-page PDF drawn with Helvetica, its cross-reference table computed */
const minimalPdf = (title: string, lines: readonly string[]): Uint8Array => {
  const stream = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    ...lines.flatMap((line, index) => [...(index === 0 ? [] : ["0 -16 Td"]), `(${line}) Tj`]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    `<< /Title (${title}) >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(out);
};

const MENU = minimalPdf("Dinner Menu", [
  "Margherita pizza, San Marzano tomato",
  "Eggplant parmigiana, vegetarian",
  "Open Tuesday to Sunday 5pm to 10pm",
]);

describe("reading a PDF", () => {
  it("reads its title and its text, a line to a line", async () => {
    const read = await readPdf(MENU);
    expect(read.title).toBe("Dinner Menu");
    expect(read.pages).toBe(1);
    expect(read.text.split("\n")).toEqual([
      "Margherita pizza, San Marzano tomato",
      "Eggplant parmigiana, vegetarian",
      "Open Tuesday to Sunday 5pm to 10pm",
    ]);
  });

  it("knows a PDF by its first bytes when the server calls it something else", async () => {
    expect(isPdf(MENU, "application/octet-stream")).toBe(true);
    expect(isPdf(new TextEncoder().encode("<html></html>"), "text/html")).toBe(false);
    const [doc] = await pageExtractor(MENU, {
      url: "https://venue.example/files/Dinner%20Menu.pdf",
      contentType: "application/octet-stream",
    });
    expect(doc).toMatchObject({
      doc: "url:https://venue.example/files/Dinner%20Menu.pdf",
      kind: "pdf",
      title: "Dinner Menu",
      meta: { format: "pdf", pages: 1 },
    });
    expect(doc!.text).toContain("Eggplant parmigiana, vegetarian");
  });

  it("makes no document of a broken file, and does not throw", async () => {
    const broken = new TextEncoder().encode("%PDF-1.4\nthis is not really a pdf");
    expect(
      await pageExtractor(broken, {
        url: "https://venue.example/x.pdf",
        contentType: "application/pdf",
      }),
    ).toEqual([]);
  });
});

/** a PDF of several pages, each a content stream, compressed or not */
const pagesPdf = (
  contents: readonly string[],
  options: { readonly flate?: boolean; readonly title?: string; readonly prefix?: string } = {},
): Uint8Array => {
  const parts: Buffer[] = [];
  let length = 0;
  const push = (chunk: string | Buffer): void => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    parts.push(buffer);
    length += buffer.length;
  };
  const offsets: number[] = [];
  const object = (number: number, body: ReadonlyArray<string | Buffer>): void => {
    offsets[number] = length;
    push(`${String(number)} 0 obj\n`);
    for (const part of body) push(part);
    push("\nendobj\n");
  };
  push(`${options.prefix ?? ""}%PDF-1.4\n`);
  const kids = contents.map((_, index) => `${String(5 + index * 2)} 0 R`).join(" ");
  object(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  object(2, [`<< /Type /Pages /Kids [${kids}] /Count ${String(contents.length)} >>`]);
  object(3, ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);
  object(4, [`<< /Title (${options.title ?? ""}) >>`]);
  contents.forEach((content, index) => {
    const number = 5 + index * 2;
    object(number, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(number + 1)} 0 R >>`,
    ]);
    const data = options.flate === true ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
    object(number + 1, [
      `<< /Length ${String(data.length)}${options.flate === true ? " /Filter /FlateDecode" : ""} >>\nstream\n`,
      data,
      "\nendstream",
    ]);
  });
  const total = 4 + contents.length * 2;
  const xref = length;
  push(`xref\n0 ${String(total + 1)}\n0000000000 65535 f \n`);
  for (let number = 1; number <= total; number += 1) {
    push(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${String(total + 1)} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(parts));
};

const textPage = (line: string): string => `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;

describe("PDFs that cost more than their size", () => {
  it("stops at its page and character limits, and says so", async () => {
    const pdf = pagesPdf(["One", "Two", "Three"].map((word) => textPage(`Page ${word}`)), { flate: true });
    const pages = await readPdf(pdf, { maxPages: 2 });
    expect(pages).toMatchObject({ text: "Page One\n\nPage Two", pages: 3, truncated: true });
    expect(pages.note).toBe("the reader stops after 2 pages");
    const chars = await readPdf(pdf, { maxChars: 5 });
    expect(chars).toMatchObject({ text: "Page One", truncated: true });
  });

  it("refuses a file whose streams inflate past the limit, and reads no page of it", async () => {
    const bomb = pagesPdf([`BT /F1 12 Tf 72 720 Td ${"(A) Tj ".repeat(300_000)} ET`], { flate: true });
    expect(bomb.length).toBeLessThan(50_000);
    const read = await readPdf(bomb, { maxInflatedBytes: 1_000_000 });
    expect(read).toMatchObject({ text: "", pages: 0, truncated: true });
    expect(read.note).toMatch(/inflate past/);
  });
});

describe("a PDF with little to read", () => {
  it("makes a document of a scan's title, and says that it needs OCR", async () => {
    const scan = pagesPdf(["0 0 m 100 100 l S"], { title: "Scanned Menu" });
    const [doc] = await pageExtractor(scan, {
      url: "https://venue.example/menu.pdf",
      contentType: "application/pdf",
    });
    expect(doc).toMatchObject({
      kind: "pdf",
      title: "Scanned Menu",
      text: "Scanned Menu",
      meta: { format: "pdf", pages: 1, ocr_needed: true },
    });
  });

  it("names a file by its file name when its title is the word processor's", async () => {
    const pdf = pagesPdf([textPage("Dinner")], { title: "Microsoft Word - menu-final-v3.docx", prefix: "\r\n\r\n" });
    expect(isPdf(pdf, "application/octet-stream")).toBe(true);
    const [doc] = await pageExtractor(pdf, {
      url: "https://venue.example/files/Dinner%20Menu.pdf",
      contentType: "application/octet-stream",
    });
    expect(doc).toMatchObject({ title: "Dinner Menu.pdf", text: "Dinner" });
  });
});
