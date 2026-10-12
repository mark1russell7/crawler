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
