import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";

/**
 * The vector store keeps the vectors of hybrid search in `vectors.sqlite`, beside the index. It is
 * a projection, as the index is. Delete the file, and the next hybrid search or `embed` makes the
 * vectors again from the stored texts.
 *
 * - A row is one chunk of one text for one embedder. Its key is the SHA-256 of the text, the
 *   number of the chunk and the id of the embedder. Thus a reindex keeps each vector, and the same
 *   text gets its vectors one time for each model, also when two documents hold it.
 * - A text is complete when the table `texts` has it, with the plan of its chunks. A text with a
 *   different plan gets new chunks.
 * - The table `docs` points each document at the text that has its vectors. A search uses only
 *   the texts that a document points at, and the caller checks each document against the index.
 * - A search compares the vector of the question with each stored vector (a brute-force cosine).
 *   The store keeps the vectors of each embedder in memory after the first search. It reads them
 *   again when a different process writes the file.
 *
 * Each connection waits for the lock of a different process (`busy_timeout`), and each write is
 * one transaction (`BEGIN IMMEDIATE`). The file has a schema version (`VECTORS_SCHEMA`). A file of
 * a different version opens empty.
 */

/**
 * This value is the version of the schema of the vector file.
 *
 * @beta
 */
export const VECTORS_SCHEMA = 1;

/**
 * This is one chunk of a text with its vector, as the store keeps it.
 *
 * @beta
 */
export interface StoredChunk {
  readonly chunk: number;
  /** These values are the positions of the chunk in the text, in UTF-16 units. */
  readonly start: number;
  readonly end: number;
  /** This vector has a length of 1, or it is zeros. */
  readonly vector: Float32Array;
}

/**
 * This is the best chunk of one text for a question.
 *
 * @beta
 */
export interface VectorHit {
  /** This value is the SHA-256 of the text, in hex. */
  readonly sha: string;
  readonly chunk: number;
  readonly start: number;
  readonly end: number;
  /** This value is the cosine of the chunk and the question, from -1 to 1. */
  readonly similarity: number;
  /** These documents point at the text. The caller checks each one against the index. */
  readonly docs: readonly string[];
}

/**
 * These are the counts of the store, for one embedder or for each embedder.
 *
 * @beta
 */
export interface VectorCounts {
  readonly texts: number;
  readonly chunks: number;
  readonly docs: number;
  /** This value is the size of the vectors in bytes, with no overhead of SQLite. */
  readonly bytes: number;
}

/**
 * These options open a vector store.
 *
 * @beta
 */
export interface VectorStoreOptions {
  /** This value is the time in milliseconds that a write waits for the lock of a different process. The default is 10 seconds. */
  readonly busyTimeoutMs?: number | undefined;
}

/**
 * These are the parts of one text in a write of the store.
 *
 * @beta
 */
export interface VectorWrite {
  readonly embedder: string;
  readonly dimensions: number;
  /** This value is the SHA-256 of the text, in hex. */
  readonly sha: string;
  /** This text names the rule of the chunks. A text with a different plan gets new chunks. */
  readonly plan: string;
  /** This value is the length of the text. */
  readonly chars: number;
  readonly chunks: ReadonlyArray<Omit<StoredChunk, "chunk">>;
  /** These documents hold the text as their current text. The store points each one at it. */
  readonly docs: readonly string[];
  /** This time (ISO 8601) is the time of the write. */
  readonly at: string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS vectors_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embedders (
  id TEXT PRIMARY KEY,
  dimensions INTEGER NOT NULL,
  first_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS texts (
  sha TEXT NOT NULL,
  embedder TEXT NOT NULL,
  plan TEXT NOT NULL,
  chunks INTEGER NOT NULL,
  chars INTEGER NOT NULL,
  embedded_at TEXT NOT NULL,
  PRIMARY KEY (sha, embedder)
);
CREATE TABLE IF NOT EXISTS chunks (
  sha TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  embedder TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (sha, chunk, embedder)
);
CREATE INDEX IF NOT EXISTS chunks_embedder ON chunks (embedder, sha, chunk);
CREATE TABLE IF NOT EXISTS docs (
  doc TEXT NOT NULL,
  embedder TEXT NOT NULL,
  sha TEXT NOT NULL,
  pointed_at TEXT NOT NULL,
  PRIMARY KEY (doc, embedder)
);
CREATE INDEX IF NOT EXISTS docs_sha ON docs (embedder, sha);
`;

/** The vectors of one embedder in memory: the rows of the chunks, and the texts and documents that they belong to. */
interface Matrix {
  readonly dimensions: number;
  rows: number;
  data: Float32Array;
  chunk: Int32Array;
  start: Int32Array;
  end: Int32Array;
  /** These are the rows of each text: from the first row to the row after the last row. */
  readonly texts: Map<string, { readonly from: number; readonly to: number }>;
  readonly docsOf: Map<string, Set<string>>;
  readonly shaOf: Map<string, string>;
  /** This value is the `data_version` of the file when the store read it. */
  readonly version: number;
}

/** This function gives the bytes of a vector for a BLOB. The bytes are in the order of the platform (little-endian on each common platform). */
const bytesOf = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

/** This function gives the vector of the bytes of a BLOB. It copies the bytes, so an odd offset of the BLOB is not a problem. */
const vectorOf = (bytes: Uint8Array): Float32Array => {
  const out = new Float32Array(Math.floor(bytes.byteLength / 4));
  new Uint8Array(out.buffer).set(bytes.subarray(0, out.length * 4));
  return out;
};

const dot = (data: Float32Array, row: number, query: Float32Array, dims: number): number => {
  let sum = 0;
  const base = row * dims;
  for (let at = 0; at < dims; at += 1) sum += data[base + at]! * query[at]!;
  return sum;
};

/** @beta */
export class VectorStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly matrices = new Map<string, Matrix>();
  private closed = false;

  constructor(
    readonly path: string,
    options: VectorStoreOptions = {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const wait = Math.max(0, Math.floor(options.busyTimeoutMs ?? 10_000));
    this.db.exec(`PRAGMA busy_timeout = ${String(wait)};`);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    // the store is a projection, so a power cut can cost its last transactions and nothing else
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.write(() => {
      const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      if (version !== VECTORS_SCHEMA) {
        // a store of a different schema is a projection: it opens empty
        const tables = this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as Array<{ name: string }>;
        for (const { name } of tables) this.db.exec(`DROP TABLE IF EXISTS "${name}"`);
      }
      this.db.exec(DDL);
      this.db.exec(`PRAGMA user_version = ${String(VECTORS_SCHEMA)}`);
    });
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private write<T>(work: () => T): T {
    if (this.closed) throw new Error("the vector store is closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private live(): void {
    if (this.closed) throw new Error("the vector store is closed");
  }

  /** This method gives the plan of the chunks of a text when the store has each of its vectors, or undefined. */
  plan(embedder: string, sha: string): string | undefined {
    this.live();
    return (
      this.stmt("SELECT plan FROM texts WHERE sha = ? AND embedder = ?").get(sha, embedder) as
        { plan: string } | undefined
    )?.plan;
  }

  /** This method gives the text that a document points at, or undefined. */
  pointed(embedder: string, doc: string): string | undefined {
    this.live();
    return (
      this.stmt("SELECT sha FROM docs WHERE doc = ? AND embedder = ?").get(doc, embedder) as
        { sha: string } | undefined
    )?.sha;
  }

  /** This method gives the dimensions that the store keeps for an embedder, or undefined. */
  dimensions(embedder: string): number | undefined {
    this.live();
    return (
      this.stmt("SELECT dimensions FROM embedders WHERE id = ?").get(embedder) as
        { dimensions: number } | undefined
    )?.dimensions;
  }

  /**
   * This method writes the chunks of one text and points its documents at it, in one transaction.
   * A vector with a length that is different from the dimensions of the embedder throws an error.
   */
  put(input: VectorWrite): void {
    const dims = input.dimensions;
    for (const chunk of input.chunks) {
      if (chunk.vector.length !== dims) {
        throw new Error(
          `the embedder ${input.embedder} gave a vector of ${String(chunk.vector.length)} dimensions, not ${String(dims)}`,
        );
      }
    }
    let replaced = false;
    this.write(() => {
      const known = this.stmt("SELECT dimensions FROM embedders WHERE id = ?").get(
        input.embedder,
      ) as { dimensions: number } | undefined;
      // a text with no chunk tells nothing of the dimensions
      if (known === undefined && input.chunks.length > 0) {
        this.stmt("INSERT INTO embedders (id, dimensions, first_at) VALUES (?, ?, ?)").run(
          input.embedder,
          dims,
          input.at,
        );
      } else if (known !== undefined && input.chunks.length > 0 && known.dimensions !== dims) {
        throw new Error(
          `vectors.sqlite holds vectors of ${String(known.dimensions)} dimensions for the embedder ${input.embedder}, and it gave ${String(dims)}: give the embedder a new id, or delete vectors.sqlite`,
        );
      }
      const before = this.stmt("SELECT plan FROM texts WHERE sha = ? AND embedder = ?").get(
        input.sha,
        input.embedder,
      ) as { plan: string } | undefined;
      replaced = before !== undefined && before.plan !== input.plan;
      this.stmt("DELETE FROM chunks WHERE sha = ? AND embedder = ?").run(input.sha, input.embedder);
      const insert = this.stmt(
        "INSERT INTO chunks (sha, chunk, embedder, char_start, char_end, vector) VALUES (?, ?, ?, ?, ?, ?)",
      );
      input.chunks.forEach((chunk, at) => {
        insert.run(input.sha, at, input.embedder, chunk.start, chunk.end, bytesOf(chunk.vector));
      });
      this.stmt(
        `INSERT INTO texts (sha, embedder, plan, chunks, chars, embedded_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha, embedder) DO UPDATE SET plan = excluded.plan, chunks = excluded.chunks,
           chars = excluded.chars, embedded_at = excluded.embedded_at`,
      ).run(input.sha, input.embedder, input.plan, input.chunks.length, input.chars, input.at);
      for (const doc of input.docs) this.pointRow(input.embedder, doc, input.sha, input.at);
    });
    const matrix = this.matrices.get(input.embedder);
    if (matrix === undefined) return;
    if (replaced || matrix.texts.has(input.sha)) {
      // a text with new chunks: the next search reads the vectors again
      this.matrices.delete(input.embedder);
      return;
    }
    this.append(
      matrix,
      input.sha,
      input.chunks.map((chunk, at) => ({ ...chunk, chunk: at })),
    );
    for (const doc of input.docs) this.pointMatrix(matrix, doc, input.sha);
  }

  private pointRow(embedder: string, doc: string, sha: string, at: string): void {
    this.stmt(
      `INSERT INTO docs (doc, embedder, sha, pointed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(doc, embedder) DO UPDATE SET sha = excluded.sha, pointed_at = excluded.pointed_at`,
    ).run(doc, embedder, sha, at);
  }

  /** This method points a document at a text that the store has. */
  point(embedder: string, doc: string, sha: string, at: string): void {
    this.write(() => this.pointRow(embedder, doc, sha, at));
    const matrix = this.matrices.get(embedder);
    if (matrix === undefined) return;
    if (!matrix.texts.has(sha)) this.append(matrix, sha, this.chunks(embedder, sha));
    this.pointMatrix(matrix, doc, sha);
  }

  /** This method removes the pointer of a document, for example when the document is held back. Its text keeps its vectors. */
  forget(embedder: string, doc: string): void {
    this.write(() =>
      this.stmt("DELETE FROM docs WHERE doc = ? AND embedder = ?").run(doc, embedder),
    );
    const matrix = this.matrices.get(embedder);
    if (matrix === undefined) return;
    const sha = matrix.shaOf.get(doc);
    if (sha !== undefined) matrix.docsOf.get(sha)?.delete(doc);
    matrix.shaOf.delete(doc);
  }

  /** This method gives the chunks of a text, in their sequence. */
  chunks(embedder: string, sha: string): StoredChunk[] {
    this.live();
    return (
      this.stmt(
        "SELECT chunk, char_start, char_end, vector FROM chunks WHERE sha = ? AND embedder = ? ORDER BY chunk",
      ).all(sha, embedder) as Array<{
        chunk: number;
        char_start: number;
        char_end: number;
        vector: Uint8Array;
      }>
    ).map((row) => ({
      chunk: row.chunk,
      start: row.char_start,
      end: row.char_end,
      vector: vectorOf(row.vector),
    }));
  }

  private pointMatrix(matrix: Matrix, doc: string, sha: string): void {
    const before = matrix.shaOf.get(doc);
    if (before !== undefined && before !== sha) matrix.docsOf.get(before)?.delete(doc);
    matrix.shaOf.set(doc, sha);
    let docs = matrix.docsOf.get(sha);
    if (docs === undefined) {
      docs = new Set();
      matrix.docsOf.set(sha, docs);
    }
    docs.add(doc);
  }

  private append(matrix: Matrix, sha: string, chunks: readonly StoredChunk[]): void {
    const dims = matrix.dimensions;
    const need = matrix.rows + chunks.length;
    if (need > matrix.chunk.length) {
      const size = Math.max(need, matrix.chunk.length * 2, 64);
      const data = new Float32Array(size * dims);
      data.set(matrix.data.subarray(0, matrix.rows * dims));
      const grow = (old: Int32Array): Int32Array => {
        const next = new Int32Array(size);
        next.set(old.subarray(0, matrix.rows));
        return next;
      };
      matrix.data = data;
      matrix.chunk = grow(matrix.chunk);
      matrix.start = grow(matrix.start);
      matrix.end = grow(matrix.end);
    }
    const from = matrix.rows;
    for (const chunk of chunks) {
      const row = matrix.rows;
      if (chunk.vector.length === dims) matrix.data.set(chunk.vector, row * dims);
      matrix.chunk[row] = chunk.chunk;
      matrix.start[row] = chunk.start;
      matrix.end[row] = chunk.end;
      matrix.rows += 1;
    }
    matrix.texts.set(sha, { from, to: matrix.rows });
  }

  /** This method gives the vectors of an embedder in memory. It reads them again when a different process wrote the file. */
  private matrix(embedder: string): Matrix | undefined {
    this.live();
    const version = (this.db.prepare("PRAGMA data_version").get() as { data_version: number })
      .data_version;
    const cached = this.matrices.get(embedder);
    if (cached !== undefined && cached.version === version) return cached;
    const dims = this.dimensions(embedder);
    if (dims === undefined) return undefined;
    // one read transaction: the count, the rows and the pointers come from one snapshot of the file
    this.db.exec("BEGIN");
    try {
      const matrix = this.load(embedder, dims, version);
      this.matrices.set(embedder, matrix);
      return matrix;
    } finally {
      if (this.db.isTransaction) this.db.exec("COMMIT");
    }
  }

  private load(embedder: string, dims: number, version: number): Matrix {
    const count = (
      this.db
        .prepare(
          "SELECT count(*) AS n FROM chunks WHERE embedder = ? AND sha IN (SELECT sha FROM docs WHERE embedder = ?)",
        )
        .get(embedder, embedder) as { n: number }
    ).n;
    const matrix: Matrix = {
      dimensions: dims,
      rows: 0,
      data: new Float32Array(Math.max(1, count) * dims),
      chunk: new Int32Array(Math.max(1, count)),
      start: new Int32Array(Math.max(1, count)),
      end: new Int32Array(Math.max(1, count)),
      texts: new Map(),
      docsOf: new Map(),
      shaOf: new Map(),
      version,
    };
    const rows = this.db
      .prepare(
        `SELECT sha, chunk, char_start, char_end, vector FROM chunks
          WHERE embedder = ? AND sha IN (SELECT sha FROM docs WHERE embedder = ?)
          ORDER BY sha, chunk`,
      )
      .iterate(embedder, embedder) as IterableIterator<{
      sha: string;
      chunk: number;
      char_start: number;
      char_end: number;
      vector: Uint8Array;
    }>;
    let sha: string | undefined;
    let from = 0;
    for (const row of rows) {
      if (row.sha !== sha) {
        if (sha !== undefined) matrix.texts.set(sha, { from, to: matrix.rows });
        sha = row.sha;
        from = matrix.rows;
      }
      if (matrix.rows >= matrix.chunk.length) break;
      const at = matrix.rows;
      if (row.vector.byteLength === dims * 4) {
        new Uint8Array(matrix.data.buffer, at * dims * 4, dims * 4).set(row.vector);
      }
      matrix.chunk[at] = row.chunk;
      matrix.start[at] = row.char_start;
      matrix.end[at] = row.char_end;
      matrix.rows += 1;
    }
    if (sha !== undefined) matrix.texts.set(sha, { from, to: matrix.rows });
    for (const row of this.db
      .prepare("SELECT doc, sha FROM docs WHERE embedder = ?")
      .all(embedder) as Array<{ doc: string; sha: string }>) {
      this.pointMatrix(matrix, row.doc, row.sha);
    }
    return matrix;
  }

  /** This method gives the best chunk of one text for a question, or undefined when the store has no vector of the text. */
  best(embedder: string, sha: string, query: Float32Array): VectorHit | undefined {
    const matrix = this.matrix(embedder);
    const range = matrix?.texts.get(sha);
    if (matrix === undefined || range === undefined || range.to === range.from) return undefined;
    return this.hitOf(matrix, sha, range, query);
  }

  private hitOf(
    matrix: Matrix,
    sha: string,
    range: { readonly from: number; readonly to: number },
    query: Float32Array,
  ): VectorHit {
    let bestRow = range.from;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let row = range.from; row < range.to; row += 1) {
      const score = dot(matrix.data, row, query, matrix.dimensions);
      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
      }
    }
    return {
      sha,
      chunk: matrix.chunk[bestRow]!,
      start: matrix.start[bestRow]!,
      end: matrix.end[bestRow]!,
      similarity: bestScore,
      docs: [...(matrix.docsOf.get(sha) ?? [])],
    };
  }

  /**
   * This method compares a question with each stored vector of an embedder (a brute-force cosine).
   * It gives the best chunk of each text that a document points at, the best first. With `within`,
   * it compares only the texts of those documents.
   */
  search(
    embedder: string,
    query: Float32Array,
    options: { readonly within?: Iterable<string> | undefined } = {},
  ): VectorHit[] {
    const matrix = this.matrix(embedder);
    if (matrix === undefined) return [];
    if (query.length !== matrix.dimensions) {
      throw new Error(
        `the question has a vector of ${String(query.length)} dimensions, and the store holds ${String(matrix.dimensions)} for the embedder ${embedder}`,
      );
    }
    const shas = new Set<string>();
    if (options.within === undefined) {
      for (const [sha, docs] of matrix.docsOf) if (docs.size > 0) shas.add(sha);
    } else {
      for (const doc of options.within) {
        const sha = matrix.shaOf.get(doc);
        if (sha !== undefined) shas.add(sha);
      }
    }
    const hits: VectorHit[] = [];
    for (const sha of shas) {
      const range = matrix.texts.get(sha);
      if (range === undefined || range.to === range.from) continue;
      hits.push(this.hitOf(matrix, sha, range, query));
    }
    return hits.sort((a, b) => b.similarity - a.similarity || (a.sha < b.sha ? -1 : 1));
  }

  /** This method gives the counts of the store, for one embedder or for each embedder. */
  counts(embedder?: string): VectorCounts {
    this.live();
    const where = embedder === undefined ? "" : " WHERE embedder = ?";
    const params = embedder === undefined ? [] : [embedder];
    const one = (sql: string): number =>
      (this.stmt(sql).get(...params) as { n: number | null }).n ?? 0;
    return {
      texts: one(`SELECT count(*) AS n FROM texts${where}`),
      chunks: one(`SELECT count(*) AS n FROM chunks${where}`),
      docs: one(`SELECT count(*) AS n FROM docs${where}`),
      bytes: one(`SELECT sum(length(vector)) AS n FROM chunks${where}`),
    };
  }

  /** This method closes the file. A second close does nothing. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.matrices.clear();
    this.db.close();
  }
}
