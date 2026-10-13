import { constants, inflateSync } from "node:zlib";
import { getDocumentProxy, getMeta } from "unpdf";

/**
 * The crawler reads the text of a PDF. Restaurant menus are often PDFs: 29 of 231 surveyed
 * restaurant sites link one. A menu that the crawler reads one time stays searchable. A paper in a
 * PDF reads the same way. A scanned PDF has no text, so the result is empty, not a guess.
 *
 * A small file can cost much work: a stream of 150 KB can inflate to 100 MB. Thus the reader:
 *
 * - Inflates the compressed streams first, with a limit, and refuses a file that inflates past it.
 * - Reads one page at a time, and lets other work run between the pages.
 * - Stops at a page limit, a text limit and a time limit, and says so (`truncated`). The time limit
 *   stops a page in the middle too, and the text limit cuts the text of a page.
 */
export interface PdfText {
  /** This is the title in the file, or null when the file names no real title ("Microsoft Word - menu.docx"). */
  readonly title: string | null;
  readonly text: string;
  readonly pages: number;
  /** This value is true when a limit stopped the reader before the last page. */
  readonly truncated: boolean;
  /** This note tells why the reader stopped or refused the file, or it is null. */
  readonly note: string | null;
}

/** These are the limits of one read. */
export interface PdfOptions {
  /** The reader reads no more pages than this. The default is 500. */
  readonly maxPages?: number | undefined;
  /** The reader stops when the text has this many characters, in the middle of a page too. The default is 200,000. */
  readonly maxChars?: number | undefined;
  /** The reader stops after this time in milliseconds, in the middle of a page too. The default is 20,000. */
  readonly timeBudgetMs?: number | undefined;
  /** The reader refuses a file whose streams inflate to more bytes than this. The default is 8 MB. */
  readonly maxInflatedBytes?: number | undefined;
}

const MAX_PAGES = 500;
const MAX_CHARS = 200_000;
const TIME_BUDGET_MS = 20_000;
/**
 * The text streams of 35 stored menus and papers inflate to 0.6 MB or less. The parser of pdf.js
 * reads a page with no pause. Thus a page of 8 MB of text operators stops the process for
 * approximately one second.
 */
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;

/** This function finds a PDF from its first bytes or its content type. Some servers put bytes before `%PDF-`. */
export const isPdf = (body: Uint8Array, contentType: string | null): boolean => {
  if (/\bpdf\b/i.test(contentType ?? "")) return true;
  const end = Math.min(body.length - 4, 1024);
  for (let index = 0; index < end; index += 1) {
    if (
      body[index] === 0x25 &&
      body[index + 1] === 0x50 &&
      body[index + 2] === 0x44 &&
      body[index + 3] === 0x46 &&
      body[index + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
};

/** This function gives one line of text for each line of the PDF. It removes the empty lines. */
const tidy = (page: string): string =>
  page
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

/** A word processor writes the name of its file as the title ("Microsoft Word - menu-final-v3.docx"). */
const JUNK_TITLE =
  /^(?:microsoft (?:word|powerpoint|excel) - |untitled\b|document\d*$|presentation\d*$)|\.(?:docx?|pdf|pptx?|xlsx?|indd|ai|psd|rtf|odt|pages|txt)$/i;

const latin1 = (bytes: Uint8Array, start: number, end: number): string => {
  let out = "";
  for (let index = Math.max(0, start); index < end && index < bytes.length; index += 1) {
    out += String.fromCharCode(bytes[index]!);
  }
  return out;
};

const indexOf = (bytes: Uint8Array, needle: string, from: number): number => {
  const first = needle.charCodeAt(0);
  for (
    let index = bytes.indexOf(first, from);
    index !== -1;
    index = bytes.indexOf(first, index + 1)
  ) {
    let match = true;
    for (let at = 1; at < needle.length; at += 1) {
      if (bytes[index + at] !== needle.charCodeAt(at)) {
        match = false;
        break;
      }
    }
    if (match) return index;
  }
  return -1;
};

/**
 * This function adds up the bytes that the compressed streams of a file inflate to, and stops at
 * the limit. It tries each stream: a stream in another format fails at its first bytes. An image
 * stream does not count, because the text reader does not decode it. The function gives true when
 * the file stays inside the limit.
 */
const inflatesWithin = (bytes: Uint8Array, limit: number): boolean => {
  let total = 0;
  let from = 0;
  for (;;) {
    const keyword = indexOf(bytes, "stream", from);
    if (keyword === -1) return true;
    from = keyword + 6;
    // "endstream" holds "stream" too
    if (latin1(bytes, keyword - 3, keyword) === "end") continue;
    const next = bytes[keyword + 6];
    if (next !== 0x0a && next !== 0x0d) continue;
    const dictionary = latin1(bytes, keyword - 1024, keyword);
    const head = dictionary.slice(Math.max(0, dictionary.lastIndexOf("<<")));
    if (/\/Subtype\s*\/Image\b/.test(head)) continue;
    let start = keyword + 7;
    if (next === 0x0d && bytes[start] === 0x0a) start += 1;
    const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(head);
    const stop = indexOf(bytes, "endstream", start);
    const end =
      declared !== null && start + Number(declared[1]) <= bytes.length
        ? start + Number(declared[1])
        : stop === -1
          ? bytes.length
          : stop;
    try {
      total += inflateSync(bytes.subarray(start, end), {
        maxOutputLength: Math.max(1, limit - total + 1),
        finishFlush: constants.Z_SYNC_FLUSH,
      }).length;
    } catch (error) {
      // a stream past the limit, or damaged data that pdf.js reads as far as it can
      if (error instanceof RangeError) return false;
    }
    if (total > limit) return false;
    from = Math.max(from, end);
  }
};

/** A page of pdf.js gives its text as items. A line ends where an item says so. */
interface TextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

/** This function lets the other work of the process run, for example another request. */
const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** This function gives the value of a promise, or undefined when the time ends first. */
const within = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
};

/** This function keeps the first characters of a text, and does not cut a surrogate pair. */
const cutText = (text: string, length: number): string => {
  let end = Math.max(0, length);
  const code = text.charCodeAt(end);
  if (end > 0 && end < text.length && code >= 0xdc00 && code <= 0xdfff) end -= 1;
  return text.slice(0, end).trimEnd();
};

export const readPdf = async (bytes: Uint8Array, options: PdfOptions = {}): Promise<PdfText> => {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const maxChars = options.maxChars ?? MAX_CHARS;
  const budgetMs = options.timeBudgetMs ?? TIME_BUDGET_MS;
  const maxInflated = options.maxInflatedBytes ?? MAX_INFLATED_BYTES;
  if (!inflatesWithin(bytes, maxInflated)) {
    return {
      title: null,
      text: "",
      pages: 0,
      truncated: true,
      note: `the streams of the file inflate past ${String(Math.round(maxInflated / 1024 / 1024))} MB`,
    };
  }
  // pdf.js may take over the buffer it is handed, and this one is the caller's
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const started = Date.now();
    const texts: string[] = [];
    let chars = 0;
    let note: string | null = null;
    const last = Math.min(pdf.numPages, maxPages);
    if (pdf.numPages > maxPages) note = `the reader stops after ${String(maxPages)} pages`;
    const late = (number: number): string =>
      `the reader stops after ${String(Math.round(budgetMs / 1000))} seconds, at page ${String(number - 1)}`;
    for (let number = 1; number <= last; number += 1) {
      if (number > 1) {
        await pause();
        if (Date.now() - started > budgetMs) {
          note = late(number);
          break;
        }
      }
      const page = await pdf.getPage(number);
      // pdf.js reads a content stream with no pause, so this limit stops only a page that waits (for
      // a font, for example). The limit of the inflated bytes keeps one page near one second
      const content = await within(page.getTextContent(), budgetMs - (Date.now() - started));
      if (content === undefined) {
        note = `the reader stops after ${String(Math.round(budgetMs / 1000))} seconds, in page ${String(number)}`;
        break;
      }
      const text = tidy(
        (content.items as readonly TextItem[])
          .filter((item) => item.str !== undefined)
          .map((item) => `${item.str ?? ""}${item.hasEOL === true ? "\n" : ""}`)
          .join(""),
      );
      page.cleanup();
      if (text.length > 0) {
        // the text and the blank lines between the pages so far, and the room that is left
        if (text.length > maxChars - chars) {
          texts.push(cutText(text, maxChars - chars));
          note = `the reader stops at ${String(maxChars)} characters, at page ${String(number)}`;
          break;
        }
        texts.push(text);
        chars += text.length + 2;
      }
      if (chars >= maxChars && number < pdf.numPages) {
        note = `the reader stops at ${String(maxChars)} characters, at page ${String(number)}`;
        break;
      }
    }
    const info = (await getMeta(pdf).catch(() => undefined))?.info;
    const named: unknown = info?.["Title"];
    const title = typeof named === "string" ? named.replace(/\s+/g, " ").trim() : "";
    return {
      title: title.length > 0 && !JUNK_TITLE.test(title) ? title : null,
      text: texts.join("\n\n"),
      pages: pdf.numPages,
      truncated: note !== null,
      note,
    };
  } finally {
    // the loading task owns the document and its worker
    await pdf.loadingTask.destroy();
  }
};
