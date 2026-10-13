import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { fold, parseQuery, snippetOf } from "./fold.ts";
import type { AiInput } from "./signals.ts";
import { cacheKeyOf } from "./urls.ts";

export type { FtsQuery, Verified } from "./fold.ts";
export { ftsQuery, locate, parseQuery } from "./fold.ts";

/**
 * The reading index holds each document that the crawler extracts. A reader can search it with
 * SQLite FTS5 (BM25), read a range of characters, and find an exact quote. The index is a
 * projection: delete the file, and `reindex` builds it again from the capture log and the blobs.
 *
 * A document is what a reader cites, not what the crawler fetched. One search response of an API
 * can hold many papers, so one capture can give many documents. One paper from two sources is one
 * document with two captures. The ids are stable and easy to read (`doi:10.1/x`, `pmid:123`).
 *
 * Each capture of a document is a version. The index keeps each version, and it shows one version
 * as the current document. These are the rules:
 *
 * - For one recipe, the latest capture by fetch time wins. A page that changes thus shows its new
 *   text, also when the new text is shorter.
 * - A rendered capture wins over a plain capture of the same page. It stays current while the
 *   plain body stays the same. After the plain body changes, the plain capture wins until a new render.
 * - When two recipes give one document, the longer text wins (`merge: "richest"`, the default).
 *   With `merge: "latest"` on each version, the newer text wins. The metadata of the other recipes
 *   fills the keys that the current version does not have.
 * - The AI input of a recipe is what its newest capture says. A "no" of one recipe wins over the
 *   others. Thus a "no" stops when a later capture of the same page does not say it.
 *
 * The file has a schema version (`INDEX_SCHEMA`). A file of a different version opens empty, and
 * `stale` is true: the caller rebuilds it with `reindex`. Each connection waits for the lock of a
 * different process (`busy_timeout`), and each write is one transaction (`BEGIN IMMEDIATE`).
 */

/** This value is the version of the schema of the index file. Version 0.1 of the package wrote files of version 0. */
export const INDEX_SCHEMA = 2;

/** This value is the maximum number of capture ids that a document gives. The field `capture_count` gives the total. */
export const MAX_CAPTURES = 10;

/** The search index reads this many characters of each text, at most. */
const MAX_INDEX_CHARS = 200_000;

/** This is one document, as an extractor gives it. */
export interface ExtractedDoc {
  readonly doc: string;
  readonly kind: string;
  readonly title: string;
  /** This text is the readable text. For a paper, it is the title and the abstract. */
  readonly text: string;
  readonly url: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
  /** This rule chooses between the texts of two recipes. The default is `richest`: the longer text. */
  readonly merge?: "latest" | "richest" | undefined;
  /** When the extractor cut the text, this text is the whole text. The function `verify` looks for a quote here too. */
  readonly full_text?: string | undefined;
}

/** This is one version of a document: the document as one capture gave it. */
export interface DocInput extends ExtractedDoc {
  /** These ids are the capture records that this version came from. The first id names the version. */
  readonly captures: readonly string[];
  readonly ai_input?: AiInput | undefined;
  /** This id is the capture of the version. The default is the first id of `captures`. */
  readonly capture?: string | undefined;
  /** This time (ISO 8601) is the time of the fetch. The default is the time of the upsert. */
  readonly fetched_at?: string | undefined;
  readonly blob?: string | null | undefined;
  /** This value is the recipe that read the capture. A version with no recipe has the recipe `""`. */
  readonly recipe?: string | undefined;
  /** This value is true when the headless browser made the capture. */
  readonly rendered?: boolean | undefined;
  /** This label comes from the capture. The index writes it as it is and does not read it. */
  readonly scope?: string | undefined;
  /** These labels come from the capture. The index writes them as they are and does not read them. */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

/** This is the current version of a document. */
export interface Doc {
  readonly doc: string;
  readonly kind: string;
  readonly title: string;
  readonly text: string;
  readonly url: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
  /** These ids are the captures behind the current text, the newest first, `MAX_CAPTURES` or fewer. */
  readonly captures: readonly string[];
  /** This value is the number of versions of the document. */
  readonly capture_count: number;
  /** This id is the capture of the current text. */
  readonly capture: string;
  readonly blob: string | null;
  /** This time (ISO 8601) is the fetch time of the current text. */
  readonly fetched_at: string;
  readonly recipe: string;
  readonly rendered: boolean;
  readonly ai_input: AiInput;
  /** This value is true when the extractor cut the text, and the index keeps the whole text for `verify`. */
  readonly cut: boolean;
  readonly scope?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  readonly updated_at: string;
}

/** This is one version of a document, with no text. */
export interface DocVersion {
  readonly doc: string;
  readonly capture: string;
  readonly recipe: string;
  readonly rendered: boolean;
  readonly fetched_at: string;
  readonly blob: string | null;
  readonly kind: string;
  readonly title: string;
  readonly url: string | null;
  readonly ai_input: AiInput;
  /** This value is the length of the text of the version. */
  readonly chars: number;
  /** This value is true when the index keeps a whole text that is longer than the text. */
  readonly cut: boolean;
}

/** This is the text of one version, with its metadata. */
export interface VersionText extends DocVersion {
  readonly text: string;
  /** This text is the whole text when the extractor cut `text`. */
  readonly full_text: string | undefined;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface Found {
  readonly doc: string;
  readonly kind: string;
  readonly title: string;
  readonly url: string | null;
  readonly snippet: string;
  readonly score: number;
  readonly ai_input: AiInput;
  /** This time (ISO 8601) is the fetch time of the current text. */
  readonly fetched_at: string;
  /** This id is the capture of the current text. */
  readonly capture: string;
}

/** The variant of a cache entry: the plain response, or the page that the browser rendered. */
export type Variant = "plain" | "rendered";

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
  /** This URL is the target of a stored redirect. Its secrets show as `REDACTED`. */
  readonly location?: string | null | undefined;
  /** This value is true when the stored body is only the first part of the response. */
  readonly truncated?: boolean | undefined;
  /** This time (ISO 8601) is the end of the freshness that the server gave. */
  readonly fresh_until?: string | null | undefined;
  /** This text holds the request headers that the response varies on (`Vary`), with their values. */
  readonly vary_key?: string | null | undefined;
  /** The default is `plain`. A key that ends in `#rendered` (the form of version 0.1) is `rendered`. */
  readonly variant?: Variant | undefined;
}

/** These are the counts of the index. */
export interface Counts {
  readonly docs: number;
  readonly urls: number;
}

/** A rebuild of the index writes a new generation of the tables. The old generation answers until the commit. */
export interface IndexBuild {
  /** This method adds a version to the new generation. The build writes the versions in batches. */
  upsert(input: DocInput, now: string): void;
  /** This method sets a cache entry in the new generation, when it is newer than the stored entry. */
  setLatest(entry: Latest): void;
  /** This method reads a cache entry of the new generation. */
  latest(url: string, variant?: Variant): Latest | undefined;
  /** This method writes the waiting versions in one transaction. */
  flush(): void;
  /**
   * This method copies the versions of each recipe that is not in `recipes` from the current
   * generation. A runtime with no extractor for a recipe thus keeps the documents of that recipe.
   * It gives the number of documents that it copied.
   */
  carry(recipes: ReadonlySet<string>): number;
  /**
   * This method makes the new generation current. It first copies the rows that a different writer
   * added to the current generation since `since`. Then it removes the old generation.
   */
  commit(since: string): Counts;
  /** This method removes the new generation. The current generation stays. */
  abort(): void;
}

interface Names {
  readonly docs: string;
  readonly fts: string;
  readonly versions: string;
  readonly texts: string;
  readonly latest: string;
}

const namesOf = (generation: number): Names => ({
  docs: `docs_${String(generation)}`,
  fts: `fts_${String(generation)}`,
  versions: `versions_${String(generation)}`,
  texts: `texts_${String(generation)}`,
  latest: `latest_${String(generation)}`,
});

const GENERATION_TABLE = /^(docs|fts|versions|texts|latest)_(\d+)$/;

/** A build that started this long ago and did not finish belongs to a process that stopped. */
const ABANDONED_MS = 24 * 60 * 60 * 1000;

/** The FTS5 tokenizer: folded text, English stems, and spacing marks kept in the words. */
const TOKENIZER = `tokenize = "porter unicode61 remove_diacritics 0 categories 'L* N* Co Mc'"`;

const ddlOf = (n: Names): string => `
CREATE TABLE IF NOT EXISTS ${n.texts} (
  sha TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${n.versions} (
  doc TEXT NOT NULL,
  capture TEXT NOT NULL,
  recipe TEXT NOT NULL,
  rendered INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  blob TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  meta_sha TEXT NOT NULL,
  text_sha TEXT NOT NULL,
  text_chars INTEGER NOT NULL,
  full_sha TEXT,
  ai_input TEXT NOT NULL,
  merge TEXT NOT NULL,
  scope TEXT,
  labels TEXT,
  PRIMARY KEY (doc, capture)
);
CREATE INDEX IF NOT EXISTS ${n.versions}_time ON ${n.versions} (doc, recipe, rendered, fetched_at);
CREATE INDEX IF NOT EXISTS ${n.versions}_capture ON ${n.versions} (capture);
CREATE INDEX IF NOT EXISTS ${n.versions}_fetched ON ${n.versions} (fetched_at);
CREATE INDEX IF NOT EXISTS ${n.versions}_recipe ON ${n.versions} (recipe);
CREATE TABLE IF NOT EXISTS ${n.docs} (
  doc TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  meta TEXT NOT NULL,
  text_sha TEXT NOT NULL,
  full_sha TEXT,
  captures TEXT NOT NULL,
  capture_count INTEGER NOT NULL,
  capture TEXT NOT NULL,
  blob TEXT,
  fetched_at TEXT NOT NULL,
  recipe TEXT NOT NULL,
  rendered INTEGER NOT NULL,
  ai_input TEXT NOT NULL,
  scope TEXT,
  labels TEXT,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS ${n.fts} USING fts5(
  title, text, content = '', contentless_delete = 1, ${TOKENIZER}
);
CREATE TABLE IF NOT EXISTS ${n.latest} (
  url TEXT NOT NULL,
  variant TEXT NOT NULL,
  capture TEXT NOT NULL,
  blob TEXT,
  etag TEXT,
  last_modified TEXT,
  content_type TEXT,
  fetched_at TEXT NOT NULL,
  status INTEGER NOT NULL,
  ai_input TEXT NOT NULL,
  location TEXT,
  truncated INTEGER,
  fresh_until TEXT,
  vary_key TEXT,
  PRIMARY KEY (url, variant)
);
CREATE INDEX IF NOT EXISTS ${n.latest}_fetched ON ${n.latest} (fetched_at);
`;

interface VersionRow {
  doc: string;
  capture: string;
  recipe: string;
  rendered: number;
  fetched_at: string;
  blob: string | null;
  kind: string;
  title: string;
  url: string | null;
  meta_sha: string;
  text_sha: string;
  text_chars: number;
  full_sha: string | null;
  ai_input: string;
  merge: string;
  scope: string | null;
  labels: string | null;
}

interface DocRow {
  rowid: number;
  doc: string;
  kind: string;
  title: string;
  url: string | null;
  meta: string;
  text_sha: string;
  full_sha: string | null;
  captures: string;
  capture_count: number;
  capture: string;
  blob: string | null;
  fetched_at: string;
  recipe: string;
  rendered: number;
  ai_input: string;
  scope: string | null;
  labels: string | null;
  updated_at: string;
}

interface LatestRow {
  url: string;
  variant: string;
  capture: string;
  blob: string | null;
  etag: string | null;
  last_modified: string | null;
  content_type: string | null;
  fetched_at: string;
  status: number;
  ai_input: string;
  location: string | null;
  truncated: number | null;
  fresh_until: string | null;
  vary_key: string | null;
}

const RENDERED_MARK = "#rendered";

/** This function splits a cache key into its URL and its variant. A key in the form of version 0.1 (`…#rendered`) is a rendered variant. */
const keyOf = (
  url: string,
  variant: Variant | undefined,
): { readonly url: string; readonly variant: Variant } => {
  if (url.endsWith(RENDERED_MARK)) {
    return { url: cacheKeyOf(url.slice(0, -RENDERED_MARK.length)), variant: "rendered" };
  }
  return { url: cacheKeyOf(url), variant: variant ?? "plain" };
};

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const toLatest = (row: LatestRow): Latest => ({
  url: row.url,
  capture: row.capture,
  blob: row.blob,
  etag: row.etag,
  last_modified: row.last_modified,
  content_type: row.content_type,
  fetched_at: row.fetched_at,
  status: row.status,
  ai_input: row.ai_input as AiInput,
  location: row.location,
  truncated: row.truncated === 1 ? true : undefined,
  fresh_until: row.fresh_until,
  vary_key: row.vary_key,
  variant: row.variant as Variant,
});

const toVersion = (row: VersionRow): DocVersion => ({
  doc: row.doc,
  capture: row.capture,
  recipe: row.recipe,
  rendered: row.rendered === 1,
  fetched_at: row.fetched_at,
  blob: row.blob,
  kind: row.kind,
  title: row.title,
  url: row.url,
  ai_input: row.ai_input as AiInput,
  chars: row.text_chars,
  cut: row.full_sha !== null,
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** These are the options of a reading index. */
export interface DocIndexOptions {
  /** This value is the time in milliseconds that a write waits for the lock of a different process. The default is 10 seconds. */
  readonly busyTimeoutMs?: number | undefined;
}

export class DocIndex {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private closed = false;
  /**
   * This value is true when the file had a different schema, or no tables, so the index opened
   * empty. A store with captures then needs `reindex`.
   */
  readonly stale: boolean;

  constructor(
    readonly path: string,
    options: DocIndexOptions = {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    // the wait for the lock of a different process comes first, before any statement that writes
    const wait = Math.max(0, Math.floor(options.busyTimeoutMs ?? 10_000));
    this.db.exec(`PRAGMA busy_timeout = ${String(wait)};`);
    try {
      this.db.exec(
        "CREATE VIRTUAL TABLE temp.polite_fts5_probe USING fts5(x, content = '', contentless_delete = 1); DROP TABLE temp.polite_fts5_probe;",
      );
    } catch (cause) {
      this.db.close();
      throw new Error(
        `polite-crawler needs SQLite FTS5 with contentless_delete, and the SQLite of Node.js ${process.version} does not have it: use Node.js 22.19 or later`,
        { cause },
      );
    }
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    // the index is a projection, so a power cut can cost its last transactions and nothing else
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.stale = this.write(() => this.prepareSchema());
  }

  /** This method makes the tables of the schema. It gives true when the index opened empty. */
  private prepareSchema(): boolean {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    if (version === INDEX_SCHEMA && tables.some((table) => table.name === "index_meta")) {
      this.dropAbandoned();
      return false;
    }
    // an index of a different schema is a projection: it opens empty, and reindex fills it
    const virtual = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
      )
      .all() as Array<{ name: string }>;
    for (const { name } of virtual) this.db.exec(`DROP TABLE IF EXISTS "${name}"`);
    const rest = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const { name } of rest) this.db.exec(`DROP TABLE IF EXISTS "${name}"`);
    this.db.exec("CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.exec(ddlOf(namesOf(1)));
    this.statements.clear();
    this.setMeta("generation", "1");
    this.setMeta("next_generation", "2");
    this.db.exec(`PRAGMA user_version = ${String(INDEX_SCHEMA)}`);
    return true;
  }

  private setMeta(key: string, value: string): void {
    this.stmt(
      "INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  private getMeta(key: string): string | undefined {
    return (this.stmt("SELECT value FROM index_meta WHERE key = ?").get(key) as { value: string } | undefined)
      ?.value;
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * This method does a write in one transaction. A transaction in progress takes the write in,
   * also a transaction that the caller opened on the connection.
   */
  private write<T>(work: () => T): T {
    if (this.closed) throw new Error("the index is closed");
    if (this.depth > 0 || this.db.isTransaction) {
      this.depth += 1;
      try {
        return work();
      } finally {
        this.depth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  private generation(): number {
    return Number(this.getMeta("generation") ?? "1");
  }

  /**
   * This method does a step on the tables of the current generation. A rebuild of a different
   * process can remove those tables in the meantime. Then the method reads the generation again
   * and does the step once more.
   */
  private live<T>(step: (names: Names) => T): T {
    if (this.closed) throw new Error("the index is closed");
    try {
      return step(namesOf(this.generation()));
    } catch (error) {
      if (!/no such table/i.test(messageOf(error)) || this.depth > 0) throw error;
      this.statements.clear();
      return step(namesOf(this.generation()));
    }
  }

  /** This method removes the tables of a generation. */
  private dropGeneration(generation: number): void {
    const n = namesOf(generation);
    for (const table of [n.fts, n.docs, n.versions, n.texts, n.latest]) {
      this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    this.db.prepare("DELETE FROM index_meta WHERE key = ?").run(`building:${String(generation)}`);
    this.statements.clear();
  }

  /** This method removes the generations of builds that a stopped process left. */
  private dropAbandoned(): void {
    const current = this.generation();
    const generations = new Set<number>();
    for (const { name } of this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>) {
      const match = GENERATION_TABLE.exec(name);
      if (match !== null) generations.add(Number(match[2]));
    }
    for (const generation of generations) {
      if (generation === current) continue;
      const started = this.getMeta(`building:${String(generation)}`);
      const age = started === undefined ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(started);
      if (!(age < ABANDONED_MS)) this.dropGeneration(generation);
    }
  }

  // ── texts and versions ────────────────────────────────────────────────────

  private putText(n: Names, body: string): string {
    const key = sha(body);
    this.stmt(`INSERT OR IGNORE INTO ${n.texts} (sha, body) VALUES (?, ?)`).run(key, body);
    return key;
  }

  private textOf(n: Names, key: string | null): string | undefined {
    if (key === null) return undefined;
    return (this.stmt(`SELECT body FROM ${n.texts} WHERE sha = ?`).get(key) as { body: string } | undefined)
      ?.body;
  }

  private putVersion(n: Names, input: DocInput, now: string): void {
    const full =
      input.full_text !== undefined && input.full_text !== input.text
        ? this.putText(n, input.full_text)
        : null;
    this.stmt(
      `INSERT INTO ${n.versions} (doc, capture, recipe, rendered, fetched_at, blob, kind, title, url,
         meta_sha, text_sha, text_chars, full_sha, ai_input, merge, scope, labels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc, capture) DO UPDATE SET recipe = excluded.recipe, rendered = excluded.rendered,
         fetched_at = excluded.fetched_at, blob = excluded.blob, kind = excluded.kind, title = excluded.title,
         url = excluded.url, meta_sha = excluded.meta_sha, text_sha = excluded.text_sha,
         text_chars = excluded.text_chars, full_sha = excluded.full_sha, ai_input = excluded.ai_input,
         merge = excluded.merge, scope = excluded.scope, labels = excluded.labels`,
    ).run(
      input.doc,
      input.capture ?? input.captures[0] ?? "",
      input.recipe ?? "",
      input.rendered === true ? 1 : 0,
      input.fetched_at ?? now,
      input.blob ?? null,
      input.kind,
      input.title,
      input.url,
      this.putText(n, JSON.stringify(input.meta ?? {})),
      this.putText(n, input.text),
      input.text.length,
      full,
      input.ai_input ?? "unset",
      input.merge ?? "richest",
      input.scope ?? null,
      input.labels === undefined ? null : JSON.stringify(input.labels),
    );
  }

  private newest(n: Names, doc: string, recipe: string, rendered: number): VersionRow | undefined {
    return this.stmt(
      `SELECT * FROM ${n.versions} WHERE doc = ? AND recipe = ? AND rendered = ?
        ORDER BY fetched_at DESC, capture DESC LIMIT 1`,
    ).get(doc, recipe, rendered) as VersionRow | undefined;
  }

  /** This method chooses the current version of a document from its versions, and writes it with its search entry. */
  private recompute(n: Names, doc: string, now: string): Doc | undefined {
    const groups = this.stmt(`SELECT DISTINCT recipe, rendered FROM ${n.versions} WHERE doc = ?`).all(
      doc,
    ) as Array<{ recipe: string; rendered: number }>;
    const before = this.stmt(`SELECT rowid, text_sha, title FROM ${n.docs} WHERE doc = ?`).get(doc) as
      | { rowid: number; text_sha: string; title: string }
      | undefined;
    if (groups.length === 0) {
      if (before !== undefined) {
        this.stmt(`DELETE FROM ${n.fts} WHERE rowid = ?`).run(before.rowid);
        this.stmt(`DELETE FROM ${n.docs} WHERE doc = ?`).run(doc);
      }
      return undefined;
    }
    const byRecipe = new Map<string, { plain?: VersionRow; rendered?: VersionRow }>();
    for (const group of groups) {
      const row = this.newest(n, doc, group.recipe, group.rendered);
      if (row === undefined) continue;
      const entry = byRecipe.get(group.recipe) ?? {};
      if (group.rendered === 1) entry.rendered = row;
      else entry.plain = row;
      byRecipe.set(group.recipe, entry);
    }
    interface Candidate {
      readonly row: VersionRow;
      readonly ai: AiInput;
      readonly others: readonly VersionRow[];
    }
    const candidates: Candidate[] = [];
    for (const [recipe, { plain, rendered }] of byRecipe) {
      let pick: VersionRow;
      if (rendered === undefined) pick = plain!;
      else if (plain === undefined || rendered.fetched_at >= plain.fetched_at) pick = rendered;
      else {
        // the plain body that the render read: the render stays current while that body stays
        const base = this.stmt(
          `SELECT blob FROM ${n.versions} WHERE doc = ? AND recipe = ? AND rendered = 0 AND fetched_at <= ?
            ORDER BY fetched_at DESC, capture DESC LIMIT 1`,
        ).get(doc, recipe, rendered.fetched_at) as { blob: string | null } | undefined;
        pick = base !== undefined && base.blob !== null && base.blob === plain.blob ? rendered : plain;
      }
      const newest =
        plain === undefined
          ? rendered!
          : rendered === undefined || plain.fetched_at > rendered.fetched_at
            ? plain
            : rendered;
      const others = [plain, rendered].filter(
        (row): row is VersionRow => row !== undefined && row !== pick,
      );
      candidates.push({ row: pick, ai: newest.ai_input as AiInput, others });
    }
    let winner = candidates[0]!;
    if (candidates.length > 1) {
      const latest = candidates.every((candidate) => candidate.row.merge === "latest");
      for (const candidate of candidates.slice(1)) {
        const a = candidate.row;
        const b = winner.row;
        const better = latest
          ? a.fetched_at > b.fetched_at
          : a.text_chars > b.text_chars || (a.text_chars === b.text_chars && a.fetched_at > b.fetched_at);
        if (better) winner = candidate;
      }
    }
    const row = winner.row;
    // a render can stay current after a newer plain capture: a no of its own capture still holds its text back
    const aiInput: AiInput = row.ai_input === "no" || candidates.some((candidate) => candidate.ai === "no")
      ? "no"
      : winner.ai !== "unset"
        ? winner.ai
        : candidates.some((candidate) => candidate.ai === "yes")
          ? "yes"
          : "unset";
    let meta = parseJson<Record<string, unknown>>(this.textOf(n, row.meta_sha), {});
    for (const candidate of candidates) {
      // a different source of the same document fills the keys that the current version lacks
      if (candidate !== winner) {
        meta = { ...parseJson<Record<string, unknown>>(this.textOf(n, candidate.row.meta_sha), {}), ...meta };
      }
    }
    const same = this.stmt(
      `SELECT capture FROM ${n.versions} WHERE doc = ? AND text_sha = ?
        ORDER BY fetched_at DESC, capture DESC LIMIT ?`,
    ).all(doc, row.text_sha, MAX_CAPTURES) as Array<{ capture: string }>;
    const captures = [
      ...new Set([
        row.capture,
        ...same.map((entry) => entry.capture),
        ...winner.others.map((other) => other.capture),
        ...candidates.filter((candidate) => candidate !== winner).map((candidate) => candidate.row.capture),
      ]),
    ].slice(0, MAX_CAPTURES);
    const count = (this.stmt(`SELECT count(*) AS n FROM ${n.versions} WHERE doc = ?`).get(doc) as { n: number }).n;
    const url = row.url ?? candidates.map((candidate) => candidate.row.url).find((value) => value !== null) ?? null;
    const saved = this.stmt(
      `INSERT INTO ${n.docs} (doc, kind, title, url, meta, text_sha, full_sha, captures, capture_count, capture,
         blob, fetched_at, recipe, rendered, ai_input, scope, labels, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc) DO UPDATE SET kind = excluded.kind, title = excluded.title, url = excluded.url,
         meta = excluded.meta, text_sha = excluded.text_sha, full_sha = excluded.full_sha,
         captures = excluded.captures, capture_count = excluded.capture_count, capture = excluded.capture,
         blob = excluded.blob, fetched_at = excluded.fetched_at, recipe = excluded.recipe,
         rendered = excluded.rendered, ai_input = excluded.ai_input, scope = excluded.scope,
         labels = excluded.labels, updated_at = excluded.updated_at
       RETURNING rowid`,
    ).get(
      doc,
      row.kind,
      row.title,
      url,
      JSON.stringify(meta),
      row.text_sha,
      row.full_sha,
      JSON.stringify(captures),
      count,
      row.capture,
      row.blob,
      row.fetched_at,
      row.recipe,
      row.rendered,
      aiInput,
      row.scope,
      row.labels,
      now,
    ) as { rowid: number };
    const text = this.textOf(n, row.text_sha) ?? "";
    if (before === undefined || before.text_sha !== row.text_sha || before.title !== row.title) {
      if (before !== undefined) this.stmt(`DELETE FROM ${n.fts} WHERE rowid = ?`).run(before.rowid);
      this.stmt(`INSERT INTO ${n.fts} (rowid, title, text) VALUES (?, ?, ?)`).run(
        saved.rowid,
        fold(row.title, "search"),
        fold(text.length > MAX_INDEX_CHARS ? text.slice(0, MAX_INDEX_CHARS) : text, "search"),
      );
    }
    return this.docOf(n, doc, text);
  }

  private docOf(n: Names, doc: string, knownText?: string): Doc | undefined {
    const row = this.stmt(`SELECT rowid, * FROM ${n.docs} WHERE doc = ?`).get(doc) as DocRow | undefined;
    if (row === undefined) return undefined;
    return this.toDoc(n, row, knownText);
  }

  private toDoc(n: Names, row: DocRow, knownText?: string): Doc {
    const labels = parseJson<Record<string, string> | undefined>(row.labels, undefined);
    return {
      doc: row.doc,
      kind: row.kind,
      title: row.title,
      text: knownText ?? this.textOf(n, row.text_sha) ?? "",
      url: row.url,
      meta: parseJson<Record<string, unknown>>(row.meta, {}),
      captures: parseJson<string[]>(row.captures, []),
      capture_count: row.capture_count,
      capture: row.capture,
      blob: row.blob,
      fetched_at: row.fetched_at,
      recipe: row.recipe,
      rendered: row.rendered === 1,
      ai_input: row.ai_input as AiInput,
      cut: row.full_sha !== null,
      ...(row.scope !== null ? { scope: row.scope } : {}),
      ...(labels !== undefined ? { labels } : {}),
      updated_at: row.updated_at,
    };
  }

  private versionTextOf(n: Names, row: VersionRow): VersionText {
    return {
      ...toVersion(row),
      text: this.textOf(n, row.text_sha) ?? "",
      full_text: this.textOf(n, row.full_sha),
      meta: parseJson<Record<string, unknown>>(this.textOf(n, row.meta_sha), {}),
    };
  }

  // ── the public methods ────────────────────────────────────────────────────

  get(doc: string): Doc | undefined {
    return this.live((n) => this.docOf(n, doc));
  }

  /**
   * This method adds one version of a document, and it gives the current document. The rules of
   * the class choose the current version. An upsert of a known capture replaces that version.
   */
  upsert(input: DocInput, now: string): Doc {
    return this.live((n) =>
      this.write(() => {
        this.putVersion(n, input, now);
        return this.recompute(n, input.doc, now)!;
      }),
    );
  }

  /** This method gives the versions of a document, the newest first. */
  versions(doc: string, options: { readonly limit?: number } = {}): DocVersion[] {
    const limit = Math.max(1, Math.floor(options.limit ?? 100));
    return this.live((n) =>
      (
        this.stmt(
          `SELECT * FROM ${n.versions} WHERE doc = ? ORDER BY fetched_at DESC, capture DESC LIMIT ?`,
        ).all(doc, limit) as unknown as VersionRow[]
      ).map(toVersion),
    );
  }

  /**
   * This method gives the text of one version of a document. With no capture, it gives the current
   * version. It also gives the text of a held-back version: the caller applies `isHeldBack` to the
   * `ai_input` of the version.
   */
  versionText(doc: string, capture?: string): VersionText | undefined {
    return this.live((n) => {
      const id = capture ?? this.docOf(n, doc)?.capture;
      if (id === undefined) return undefined;
      const row = this.stmt(`SELECT * FROM ${n.versions} WHERE doc = ? AND capture = ?`).get(doc, id) as
        | VersionRow
        | undefined;
      return row === undefined ? undefined : this.versionTextOf(n, row);
    });
  }

  /**
   * This method gives the texts of the earlier versions of a document, the newest first. Each
   * text comes one time, with the newest version that has it. It skips the current text. It also
   * gives held-back texts: the caller applies `isHeldBack` to the `ai_input` of each version.
   */
  earlierTexts(doc: string, options: { readonly limit?: number } = {}): VersionText[] {
    const limit = Math.max(1, Math.floor(options.limit ?? 50));
    return this.live((n) => {
      const head = this.stmt(`SELECT text_sha FROM ${n.docs} WHERE doc = ?`).get(doc) as
        | { text_sha: string }
        | undefined;
      if (head === undefined) return [];
      const rows = this.stmt(
        `SELECT * FROM ${n.versions} WHERE doc = ? AND text_sha != ? ORDER BY fetched_at DESC, capture DESC`,
      ).all(doc, head.text_sha) as unknown as VersionRow[];
      const seen = new Set<string>();
      const out: VersionText[] = [];
      for (const row of rows) {
        if (seen.has(row.text_sha)) continue;
        seen.add(row.text_sha);
        out.push(this.versionTextOf(n, row));
        if (out.length >= limit) break;
      }
      return out;
    });
  }

  /** This method gives the current documents that a capture gave. */
  docsOfCapture(capture: string): Doc[] {
    return this.live((n) =>
      (this.stmt(`SELECT DISTINCT doc FROM ${n.versions} WHERE capture = ?`).all(capture) as Array<{ doc: string }>)
        .map((row) => this.docOf(n, row.doc))
        .filter((doc): doc is Doc => doc !== undefined),
    );
  }

  /**
   * This method searches the documents with BM25, the best first. The syntax of the query is the
   * syntax of `parseQuery`. It first asks for each part. When that gives too few documents, it
   * adds the documents that match one part. A document that asked not to be AI input is not in
   * the results, so a search cannot show its text.
   */
  find(q: string, options: { readonly limit: number; readonly kind?: string | null }): Found[] {
    const query = parseQuery(q);
    if (query === undefined) return [];
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit) || 10));
    return this.live((n) => {
      const kindClause = options.kind === undefined || options.kind === null ? "" : "AND d.kind = ?";
      const sql = `SELECT d.rowid AS rowid, d.*, bm25(${n.fts}, 3.0, 1.0) AS rank
          FROM ${n.fts} JOIN ${n.docs} d ON d.rowid = ${n.fts}.rowid
         WHERE ${n.fts} MATCH ? AND d.ai_input != 'no' ${kindClause}
         ORDER BY rank LIMIT ?`;
      const run = (match: string): Array<DocRow & { rank: number }> => {
        const params: Array<string | number> = [match];
        if (kindClause.length > 0) params.push(options.kind as string);
        params.push(limit);
        return this.stmt(sql).all(...params) as unknown as Array<DocRow & { rank: number }>;
      };
      const rows = run(query.all);
      if (rows.length < limit && query.parts > 1) {
        const seen = new Set(rows.map((row) => row.doc));
        for (const row of run(query.any)) {
          if (rows.length >= limit) break;
          if (!seen.has(row.doc)) rows.push(row);
        }
      }
      return rows.map((row) => ({
        doc: row.doc,
        kind: row.kind,
        title: row.title,
        url: row.url,
        snippet: snippetOf(this.textOf(n, row.text_sha) ?? "", query.terms),
        // bm25() is lower-is-better; flip it so a bigger score is a better match
        score: Math.round(-row.rank * 1000) / 1000,
        ai_input: row.ai_input as AiInput,
        fetched_at: row.fetched_at,
        capture: row.capture,
      }));
    });
  }

  /**
   * This method scores a set of documents against a query, with the best first. It leaves out a
   * document that matches no term, and a document that asked not to be AI input. It ranks the
   * results of a source again, because the order of the source is only as good as its search engine.
   */
  rankWithin(
    q: string,
    docs: readonly string[],
  ): Array<{ readonly doc: string; readonly score: number }> {
    const query = parseQuery(q);
    if (query === undefined || docs.length === 0) return [];
    return this.live((n) =>
      (
        this.stmt(
          `SELECT d.doc AS doc, bm25(${n.fts}, 3.0, 1.0) AS rank
             FROM ${n.fts} JOIN ${n.docs} d ON d.rowid = ${n.fts}.rowid
            WHERE ${n.fts} MATCH ? AND d.ai_input != 'no' AND d.doc IN (SELECT value FROM json_each(?))
            ORDER BY rank`,
        ).all(query.any, JSON.stringify(docs)) as Array<{ doc: string; rank: number }>
      ).map((row) => ({ doc: row.doc, score: Math.round(-row.rank * 1000) / 1000 })),
    );
  }

  /** This method gives the cache entry of a URL. The key is canonical, so two spellings of one URL give one entry. */
  latest(url: string, variant?: Variant): Latest | undefined {
    const key = keyOf(url, variant);
    return this.live((n) => {
      const row = this.stmt(`SELECT * FROM ${n.latest} WHERE url = ? AND variant = ?`).get(
        key.url,
        key.variant,
      ) as LatestRow | undefined;
      return row === undefined ? undefined : toLatest(row);
    });
  }

  private putLatest(n: Names, entry: Latest): void {
    const key = keyOf(entry.url, entry.variant);
    // an older answer never replaces a newer one, so two processes and a replay agree
    this.stmt(
      `INSERT INTO ${n.latest} (url, variant, capture, blob, etag, last_modified, content_type, fetched_at,
         status, ai_input, location, truncated, fresh_until, vary_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url, variant) DO UPDATE SET capture = excluded.capture, blob = excluded.blob,
         etag = excluded.etag, last_modified = excluded.last_modified, content_type = excluded.content_type,
         fetched_at = excluded.fetched_at, status = excluded.status, ai_input = excluded.ai_input,
         location = excluded.location, truncated = excluded.truncated, fresh_until = excluded.fresh_until,
         vary_key = excluded.vary_key
       WHERE excluded.fetched_at >= ${n.latest}.fetched_at`,
    ).run(
      key.url,
      key.variant,
      entry.capture,
      entry.blob,
      entry.etag,
      entry.last_modified,
      entry.content_type,
      entry.fetched_at,
      entry.status,
      entry.ai_input,
      entry.location ?? null,
      entry.truncated === true ? 1 : null,
      entry.fresh_until ?? null,
      entry.vary_key ?? null,
    );
  }

  /** This method keeps the last answer for a URL. An entry that is older than the stored entry changes nothing. */
  setLatest(entry: Latest): void {
    this.live((n) => this.write(() => this.putLatest(n, entry)));
  }

  counts(): Counts {
    return this.live((n) => ({
      docs: (this.stmt(`SELECT count(*) AS n FROM ${n.docs}`).get() as { n: number }).n,
      urls: (this.stmt(`SELECT count(*) AS n FROM ${n.latest}`).get() as { n: number }).n,
    }));
  }

  /** This method empties the current generation. A rebuild uses `beginRebuild`, which keeps the index until its commit. */
  reset(): void {
    this.live((n) =>
      this.write(() => {
        for (const table of [n.fts, n.docs, n.versions, n.texts, n.latest]) {
          this.db.exec(`DELETE FROM ${table}`);
        }
      }),
    );
  }

  /**
   * This method starts a rebuild into a new generation of the tables. The current generation
   * answers each read and takes each write until the commit. A failed rebuild thus leaves the
   * index as it was.
   */
  beginRebuild(options: { readonly batch?: number } = {}): IndexBuild {
    const batchSize = Math.max(1, Math.floor(options.batch ?? 500));
    const generation = this.write(() => {
      const next = Number(this.getMeta("next_generation") ?? "2");
      this.setMeta("next_generation", String(next + 1));
      this.setMeta(`building:${String(next)}`, new Date().toISOString());
      this.db.exec(ddlOf(namesOf(next)));
      return next;
    });
    const n = namesOf(generation);
    const versions: Array<{ readonly input: DocInput; readonly now: string }> = [];
    const latest = new Map<string, Latest>();
    let open = true;
    const keyText = (url: string, variant: Variant | undefined): string => {
      const key = keyOf(url, variant);
      return `${key.variant} ${key.url}`;
    };
    const flush = (): void => {
      if (!open) throw new Error("the rebuild is over");
      if (versions.length === 0 && latest.size === 0) return;
      this.write(() => {
        const touched = new Map<string, string>();
        for (const { input, now } of versions) {
          this.putVersion(n, input, now);
          touched.set(input.doc, now);
        }
        for (const entry of latest.values()) this.putLatest(n, entry);
        for (const [doc, now] of touched) this.recompute(n, doc, now);
      });
      versions.length = 0;
      latest.clear();
    };
    /** This function copies the texts of the versions of the current generation that agree with `where`. */
    const copyTexts = (current: Names, where: string, params: string[]): void => {
      for (const column of ["text_sha", "meta_sha", "full_sha"]) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO ${n.texts} (sha, body)
             SELECT t.sha, t.body FROM ${current.texts} t
              WHERE t.sha IN (SELECT ${column} FROM ${current.versions} WHERE ${where})`,
          )
          .run(...params);
      }
    };
    return {
      upsert: (input, now) => {
        if (!open) throw new Error("the rebuild is over");
        versions.push({ input, now });
        if (versions.length >= batchSize) flush();
      },
      setLatest: (entry) => {
        if (!open) throw new Error("the rebuild is over");
        const key = keyText(entry.url, entry.variant);
        const before = latest.get(key);
        if (before === undefined || entry.fetched_at >= before.fetched_at) latest.set(key, entry);
        if (latest.size >= batchSize) flush();
      },
      latest: (url, variant) => {
        const waiting = latest.get(keyText(url, variant));
        if (waiting !== undefined) return waiting;
        const key = keyOf(url, variant);
        const row = this.stmt(`SELECT * FROM ${n.latest} WHERE url = ? AND variant = ?`).get(
          key.url,
          key.variant,
        ) as LatestRow | undefined;
        return row === undefined ? undefined : toLatest(row);
      },
      flush,
      carry: (recipes) => {
        flush();
        const known = JSON.stringify([...recipes]);
        const current = namesOf(this.generation());
        const docs = this.db
          .prepare(
            `SELECT DISTINCT doc FROM ${current.versions} WHERE recipe NOT IN (SELECT value FROM json_each(?))`,
          )
          .all(known) as Array<{ doc: string }>;
        const where =
          "recipe NOT IN (SELECT value FROM json_each(?)) AND doc IN (SELECT value FROM json_each(?))";
        for (let at = 0; at < docs.length; at += batchSize) {
          const part = JSON.stringify(docs.slice(at, at + batchSize).map((row) => row.doc));
          this.write(() => {
            copyTexts(current, where, [known, part]);
            this.db
              .prepare(`INSERT OR IGNORE INTO ${n.versions} SELECT * FROM ${current.versions} WHERE ${where}`)
              .run(known, part);
            const now = new Date().toISOString();
            for (const doc of JSON.parse(part) as string[]) this.recompute(n, doc, now);
          });
        }
        return docs.length;
      },
      commit: (since) => {
        flush();
        open = false;
        return this.write(() => {
          const current = this.generation();
          const old = namesOf(current);
          // the rows that a different writer added during the rebuild
          copyTexts(old, "fetched_at >= ?", [since]);
          const added = this.db
            .prepare(`SELECT DISTINCT doc FROM ${old.versions} WHERE fetched_at >= ?`)
            .all(since) as Array<{ doc: string }>;
          this.db
            .prepare(`INSERT OR IGNORE INTO ${n.versions} SELECT * FROM ${old.versions} WHERE fetched_at >= ?`)
            .run(since);
          const now = new Date().toISOString();
          for (const { doc } of added) this.recompute(n, doc, now);
          for (const row of this.db
            .prepare(`SELECT * FROM ${old.latest} WHERE fetched_at >= ?`)
            .all(since) as unknown as LatestRow[]) {
            this.putLatest(n, toLatest(row));
          }
          this.setMeta("generation", String(generation));
          this.db.prepare("DELETE FROM index_meta WHERE key = ?").run(`building:${String(generation)}`);
          this.dropGeneration(current);
          return {
            docs: (this.db.prepare(`SELECT count(*) AS n FROM ${n.docs}`).get() as { n: number }).n,
            urls: (this.db.prepare(`SELECT count(*) AS n FROM ${n.latest}`).get() as { n: number }).n,
          };
        });
      },
      abort: () => {
        open = false;
        versions.length = 0;
        latest.clear();
        if (this.closed) return;
        this.write(() => this.dropGeneration(generation));
      },
    };
  }

  /** This method closes the file. A second close does nothing. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }
}
