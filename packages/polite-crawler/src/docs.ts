import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AiInput } from "./signals.ts";

/**
 * The reading index holds each document that the crawler extracts. A reader can search it with
 * SQLite FTS5 (BM25), read a range of characters, and find an exact quote. The index is a
 * projection: delete the file, and `reindex` builds it again from the capture log and the blobs.
 *
 * A document is what a reader cites, not what the crawler fetched. One search response of an API
 * can hold many papers, so one capture can give many documents. One paper from two sources is one
 * document with two captures. The ids are stable and easy to read (`doi:10.1/x`, `pmid:123`).
 */

export interface DocInput {
  readonly doc: string;
  readonly kind: string;
  readonly title: string;
  /** This text is the readable text. For a paper, it is the title and the abstract. */
  readonly text: string;
  readonly url: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
  /** These ids are the capture records that this document came from. */
  readonly captures: readonly string[];
  readonly ai_input?: AiInput | undefined;
}

export interface Doc extends DocInput {
  readonly ai_input: AiInput;
  readonly updated_at: string;
}

export interface Found {
  readonly doc: string;
  readonly kind: string;
  readonly title: string;
  readonly url: string | null;
  readonly snippet: string;
  readonly score: number;
  readonly ai_input: AiInput;
}

export interface Latest {
  readonly url: string;
  readonly capture: string;
  readonly blob: string | null;
  readonly etag: string | null;
  readonly last_modified: string | null;
  readonly content_type: string | null;
  readonly fetched_at: string;
  readonly status: number;
  /** This value is what the page said about AI input at the time of the fetch. */
  readonly ai_input: AiInput;
}

const DDL = `
CREATE TABLE IF NOT EXISTS docs (
  doc TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT,
  meta TEXT NOT NULL,
  captures TEXT NOT NULL,
  ai_input TEXT NOT NULL DEFAULT 'unset',
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, text, content='docs', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
  INSERT INTO docs_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
CREATE TABLE IF NOT EXISTS latest (
  url TEXT PRIMARY KEY,
  capture TEXT NOT NULL,
  blob TEXT,
  etag TEXT,
  last_modified TEXT,
  content_type TEXT,
  fetched_at TEXT NOT NULL,
  status INTEGER NOT NULL,
  ai_input TEXT NOT NULL DEFAULT 'unset'
);
`;

interface DocRow {
  doc: string;
  kind: string;
  title: string;
  text: string;
  url: string | null;
  meta: string;
  captures: string;
  ai_input: string;
  updated_at: string;
}

const toDoc = (row: DocRow): Doc => ({
  doc: row.doc,
  kind: row.kind,
  title: row.title,
  text: row.text,
  url: row.url,
  meta: JSON.parse(row.meta) as Record<string, unknown>,
  captures: JSON.parse(row.captures) as string[],
  ai_input: row.ai_input as AiInput,
  updated_at: row.updated_at,
});

/** This function changes a query into FTS5 terms. It quotes each term, so the text of a user cannot become syntax. */
export const ftsQuery = (q: string): string | undefined => {
  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
    .slice(0, 16);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term}"`).join(" OR ");
};

/** This function makes case, typographic quotes, dashes and spaces equal. A map gives the original positions. */
const fold = (text: string): { folded: string; at: number[] } => {
  const at: number[] = [];
  let folded = "";
  let lastSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    let char = text[index]!;
    if (/\s/.test(char)) {
      if (lastSpace || folded.length === 0) continue;
      char = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
      if (/[‘’‛′]/.test(char)) char = "'";
      else if (/[“”„″]/.test(char)) char = '"';
      else if (/[‐‑‒–—―]/.test(char)) char = "-";
      char = char.toLowerCase();
    }
    folded += char;
    at.push(index);
  }
  return { folded: folded.trimEnd(), at };
};

export interface Verified {
  readonly found: boolean;
  /** These values are the character positions in the text of the document, when the quote is there. */
  readonly start: number | null;
  readonly end: number | null;
  /** This text is the exact quote as stored, with some text before and after it. */
  readonly excerpt: string | null;
}

/** This function finds a quote in a text. It ignores case, spaces and typographic punctuation. */
export const locate = (text: string, quote: string): Verified => {
  const haystack = fold(text);
  const needle = fold(quote).folded;
  if (needle.length === 0) return { found: false, start: null, end: null, excerpt: null };
  const hit = haystack.folded.indexOf(needle);
  if (hit === -1) return { found: false, start: null, end: null, excerpt: null };
  const start = haystack.at[hit]!;
  const end = haystack.at[hit + needle.length - 1]! + 1;
  const from = Math.max(0, start - 80);
  const to = Math.min(text.length, end + 80);
  return {
    found: true,
    start,
    end,
    excerpt: `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`,
  };
};

export class DocIndex {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(DDL);
  }

  get(doc: string): Doc | undefined {
    const row = this.db.prepare("SELECT * FROM docs WHERE doc = ?").get(doc) as DocRow | undefined;
    return row === undefined ? undefined : toDoc(row);
  }

  /**
   * This method adds a document, or it merges a new copy into the stored document:
   *
   * - The captures of the two copies stay together.
   * - The longer text stays, so a source with the abstract replaces a source without it.
   * - The older metadata keeps its values and gets the new keys.
   * - A "no" for AI input from one source stays.
   */
  upsert(input: DocInput, now: string): Doc {
    const existing = this.get(input.doc);
    const merged: Doc =
      existing === undefined
        ? { ...input, ai_input: input.ai_input ?? "unset", updated_at: now }
        : {
            doc: input.doc,
            kind: existing.kind,
            title: existing.title.length >= input.title.length ? existing.title : input.title,
            text: existing.text.length >= input.text.length ? existing.text : input.text,
            url: existing.url ?? input.url,
            // the metadata follows the richer text: a rendered page's links
            // and structured data replace what the empty shell had
            meta:
              input.text.length > existing.text.length
                ? { ...existing.meta, ...input.meta }
                : { ...input.meta, ...existing.meta },
            captures: [...new Set([...existing.captures, ...input.captures])],
            ai_input:
              existing.ai_input === "no" || input.ai_input === "no"
                ? "no"
                : (input.ai_input ?? existing.ai_input),
            updated_at: now,
          };
    this.db
      .prepare(
        `INSERT INTO docs (doc, kind, title, text, url, meta, captures, ai_input, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(doc) DO UPDATE SET kind = excluded.kind, title = excluded.title,
           text = excluded.text, url = excluded.url, meta = excluded.meta,
           captures = excluded.captures, ai_input = excluded.ai_input, updated_at = excluded.updated_at`,
      )
      .run(
        merged.doc,
        merged.kind,
        merged.title,
        merged.text,
        merged.url,
        JSON.stringify(merged.meta),
        JSON.stringify(merged.captures),
        merged.ai_input,
        merged.updated_at,
      );
    return merged;
  }

  find(q: string, options: { readonly limit: number; readonly kind?: string | null }): Found[] {
    const match = ftsQuery(q);
    if (match === undefined) return [];
    const kindClause = options.kind === undefined || options.kind === null ? "" : "AND d.kind = ?";
    const params: Array<string | number> = [match];
    if (kindClause.length > 0) params.push(options.kind as string);
    params.push(options.limit);
    const rows = this.db
      .prepare(
        `SELECT d.doc AS doc, d.kind AS kind, d.title AS title, d.url AS url, d.ai_input AS ai_input,
                snippet(docs_fts, 1, '[', ']', '…', 24) AS snippet,
                bm25(docs_fts, 3.0, 1.0) AS rank
           FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
          WHERE docs_fts MATCH ? ${kindClause}
          ORDER BY rank LIMIT ?`,
      )
      .all(...params) as Array<{
      doc: string;
      kind: string;
      title: string;
      url: string | null;
      ai_input: string;
      snippet: string;
      rank: number;
    }>;
    return rows.map((row) => ({
      doc: row.doc,
      kind: row.kind,
      title: row.title,
      url: row.url,
      snippet: row.ai_input === "no" ? "" : row.snippet,
      // bm25() is lower-is-better; flip it so a bigger score is a better match
      score: Math.round(-row.rank * 1000) / 1000,
      ai_input: row.ai_input as AiInput,
    }));
  }

  /**
   * This method scores a set of documents against a query, with the best first. It leaves out a
   * document that matches no term. It ranks the results of a source again, because the order of the
   * source is only as good as its search engine.
   */
  rankWithin(
    q: string,
    docs: readonly string[],
  ): Array<{ readonly doc: string; readonly score: number }> {
    const match = ftsQuery(q);
    if (match === undefined || docs.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT d.doc AS doc, bm25(docs_fts, 3.0, 1.0) AS rank
           FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
          WHERE docs_fts MATCH ? AND d.doc IN (${docs.map(() => "?").join(", ")})
          ORDER BY rank`,
      )
      .all(match, ...docs) as Array<{ doc: string; rank: number }>;
    return rows.map((row) => ({ doc: row.doc, score: Math.round(-row.rank * 1000) / 1000 }));
  }

  latest(url: string): Latest | undefined {
    return this.db.prepare("SELECT * FROM latest WHERE url = ?").get(url) as Latest | undefined;
  }

  setLatest(latest: Latest): void {
    this.db
      .prepare(
        `INSERT INTO latest (url, capture, blob, etag, last_modified, content_type, fetched_at, status, ai_input)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET capture = excluded.capture, blob = excluded.blob,
           etag = excluded.etag, last_modified = excluded.last_modified,
           content_type = excluded.content_type, fetched_at = excluded.fetched_at,
           status = excluded.status, ai_input = excluded.ai_input`,
      )
      .run(
        latest.url,
        latest.capture,
        latest.blob,
        latest.etag,
        latest.last_modified,
        latest.content_type,
        latest.fetched_at,
        latest.status,
        latest.ai_input,
      );
  }

  counts(): { docs: number; urls: number } {
    const docs = (this.db.prepare("SELECT count(*) AS n FROM docs").get() as { n: number }).n;
    const urls = (this.db.prepare("SELECT count(*) AS n FROM latest").get() as { n: number }).n;
    return { docs, urls };
  }

  /** This method empties the projection before a rebuild. */
  reset(): void {
    this.db.exec(
      "DELETE FROM docs; DELETE FROM latest; INSERT INTO docs_fts(docs_fts) VALUES ('rebuild');",
    );
  }

  close(): void {
    this.db.close();
  }
}
