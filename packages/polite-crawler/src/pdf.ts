import { extractText, getDocumentProxy, getMeta } from "unpdf";

/**
 * The crawler reads the text of a PDF. Restaurant menus are often PDFs: 29 of 231 surveyed
 * restaurant sites link one. A menu that the crawler reads one time stays searchable. A paper in a
 * PDF reads the same way. A scanned PDF has no text, so the result is empty, not a guess.
 */
export interface PdfText {
  readonly title: string | null;
  readonly text: string;
  readonly pages: number;
}

/** This function finds a PDF from its first bytes or its content type. */
export const isPdf = (body: Uint8Array, contentType: string | null): boolean =>
  /\bpdf\b/i.test(contentType ?? "") ||
  (body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46); // %PDF

/** This function gives one line of text for each line of the PDF. It removes the empty lines. */
const tidy = (page: string): string =>
  page
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

export const readPdf = async (bytes: Uint8Array): Promise<PdfText> => {
  // pdf.js may take over the buffer it is handed, and this one is the caller's
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const info = (await getMeta(pdf).catch(() => undefined))?.info;
    const named: unknown = info?.["Title"];
    return {
      title: typeof named === "string" && named.trim().length > 0 ? named.trim() : null,
      text: text
        .map(tidy)
        .filter((page) => page.length > 0)
        .join("\n\n"),
      pages: totalPages,
    };
  } finally {
    // the loading task owns the document and its worker
    await pdf.loadingTask.destroy();
  }
};
