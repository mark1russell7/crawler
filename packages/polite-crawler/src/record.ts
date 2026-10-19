import { createHash } from "node:crypto";

/**
 * A capture record is one line of the capture log. Each fetch decision makes one record, and a
 * fetch that the crawler declines makes one too.
 *
 * The record id comes from a hash of its content, so the same decision always gets the same id.
 * A citation names this id.
 *
 * The id has 48 bits: the source and the first 12 hexadecimal digits of the hash. Approximately
 * 1 million records give a chance of a collision of 0.2 percent. The package keeps this length on purpose,
 * because the ids of the earlier capture logs and their citations must stay the same. A later
 * version can make the ids of new records longer behind a record version. It must still read a
 * 12-digit id.
 */
export interface CaptureRecord {
  readonly id: string;
  /** The source of the record. The crawler writes `fetch`, and an application can add its own sources. */
  readonly source: string;
  readonly kind: string;
  readonly external_id?: string | undefined;
  readonly occurred_at?: string | undefined;
  readonly received_at: string;
  readonly payload: unknown;
  readonly content_hash: string;
  /** This label comes from the application. The crawler writes it as it is and does not read it. */
  readonly scope?: string | undefined;
  /**
   * These labels come from the application, for example the lineage of a request. The crawler writes
   * them as they are and does not read them. Like `scope`, they are not part of the hash.
   */
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

/**
 * These are the fields of a new record. The function `makeRecord` calculates the id and the hash.
 *
 * @beta
 */
export interface RecordInput {
  readonly source: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly received_at: string;
  readonly external_id?: string | undefined;
  readonly occurred_at?: string | undefined;
  readonly scope?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

/**
 * This function writes a value as JSON with the keys of each object in sorted order. Equal values
 * thus always give equal text, and equal text gives an equal hash.
 */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
};

/** This function gives the SHA-256 hash of a text as hexadecimal digits. */
export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * This function makes a capture record. The hash covers the source, the kind, the external id
 * and the payload. The id is the source and the first 12 digits of the hash. The times, `scope`
 * and `labels` are not part of the hash.
 *
 * @beta
 */
export const makeRecord = (input: RecordInput): CaptureRecord => {
  const content_hash = sha256(
    stableStringify({
      source: input.source,
      kind: input.kind,
      external_id: input.external_id ?? null,
      payload: input.payload,
    }),
  );
  return {
    id: `${input.source}.${content_hash.slice(0, 12)}`,
    source: input.source,
    kind: input.kind,
    received_at: input.received_at,
    payload: input.payload,
    content_hash,
    ...(input.external_id !== undefined ? { external_id: input.external_id } : {}),
    ...(input.occurred_at !== undefined ? { occurred_at: input.occurred_at } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.labels !== undefined && Object.keys(input.labels).length > 0
      ? { labels: { ...input.labels } }
      : {}),
  };
};
