// The raw answers of a run of the robots.txt study: what the crawler got for each domain, with the
// bytes of each body. The repository keeps the file of the newest run. Thus CI can count the rules
// again with each version of the parser, and a new version needs no new fetch.
// This module uses only node: modules, so that a plain Node.js process can write and read the file.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Study } from "./study.ts";

/** The facts of a run, as run.json of the store has them. */
export interface RunFacts {
  readonly list: Study["list"];
  readonly fetched: Study["fetched"];
  readonly userAgent: string;
  readonly runner?: string;
  readonly commit?: string;
}

/** What the crawler got for one domain, as answers.ndjson of the store has it. */
export interface StoredAnswer {
  readonly rank: number;
  readonly domain: string;
  readonly url: string;
  readonly status: number;
  readonly outcome: string;
  readonly contentType?: string;
  readonly note?: string;
  /** the SHA-256 of the body, as the store names it */
  readonly blob?: string;
  readonly bytes?: number;
}

/** One answer with the bytes of its body. */
export interface KeptAnswer extends StoredAnswer {
  readonly body?: Uint8Array;
}

/** A run with its answers. */
export interface RawRun {
  readonly run: RunFacts;
  readonly answers: readonly KeptAnswer[];
}

/** The path of the raw file of the newest run, from the folder of the site package. */
export const RAW_FILE = "src/data/robots-study.raw.ndjson.gz";

/** The SHA-256 of some bytes, in hexadecimal. */
export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The text of a body when UTF-8 gives back the same bytes, else undefined. */
function exactText(body: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    return Buffer.from(text, "utf8").equals(body) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This function writes the raw file of a run as gzip. The first JSON line is the run. Then each
 * answer has one line, in the sequence of the ranks. A body is in `text` when UTF-8 keeps its bytes. Else it
 * is in base64 in `body`. Thus the file keeps each byte, and text compresses better than base64.
 */
export function rawFile(raw: RawRun): Uint8Array {
  const lines = [JSON.stringify({ run: raw.run })];
  for (const answer of [...raw.answers].sort((a, b) => a.rank - b.rank)) {
    const { body, ...rest } = answer;
    const text = body === undefined ? undefined : exactText(body);
    if (body === undefined) lines.push(JSON.stringify(rest));
    else if (text === undefined)
      lines.push(JSON.stringify({ ...rest, body: Buffer.from(body).toString("base64") }));
    else lines.push(JSON.stringify({ ...rest, text }));
  }
  return new Uint8Array(gzipSync(`${lines.join("\n")}\n`, { level: 9 }));
}

/** This function reads a raw file. It stops for a body that does not have the SHA-256 of its blob. */
export function readRawFile(bytes: Uint8Array): RawRun {
  const [first, ...rest] = gunzipSync(bytes)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  const head = JSON.parse(first ?? "{}") as { readonly run?: RunFacts };
  if (head.run === undefined) throw new Error("The raw file has no run on its first line.");
  const answers = rest.map((line): KeptAnswer => {
    const { body, text, ...answer } = JSON.parse(line) as StoredAnswer & {
      readonly body?: string;
      readonly text?: string;
    };
    if (body === undefined && text === undefined) return answer;
    const kept = new Uint8Array(
      text === undefined ? Buffer.from(body ?? "", "base64") : Buffer.from(text, "utf8"),
    );
    if (answer.blob !== undefined && sha256(kept) !== answer.blob)
      throw new Error(`The body of ${answer.domain} does not have the SHA-256 ${answer.blob}.`);
    return { ...answer, body: kept };
  });
  return { run: head.run, answers };
}
