import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { LineSorter } from "./sorter.ts";
import { cacheKeyOf } from "./urls.ts";
import { VERSION } from "./version.ts";
import type { ArchiveCounts, ArchiveOptions, ArchiveSource } from "./warc.ts";
import { cdxjLine, outputOf, planArchive, writeArchive } from "./warc.ts";
import type { Tallied, ZipMember } from "./zip.ts";
import { TalliedFile, deflateFile, memberOf, writeZip } from "./zip.ts";

/*
 * This module writes a WACZ 1.1.1 file: a ZIP with the WARC file, a sorted CDXJ index, a page list
 * and the data package with the SHA-256 of each part. Replay tools (ReplayWeb.page, pywb) open it.
 */

/** This is the version of the WACZ specification that the export follows. */
const WACZ_VERSION = "1.1.1";
const WARC_NAME = "data.warc.gz";
const NEWLINE = Buffer.from("\n");
const TAB = 0x09;
const PAGES_HEADER = { format: "json-pages-1.0", id: "pages", title: "All Pages" };

/** This is the result of `exportWacz`. */
export interface WaczResult extends ArchiveCounts {
  readonly format: "wacz";
  /** This value is the absolute path of the archive. */
  readonly out: string;
  readonly bytes: number;
  /** This value is the count of pages in `pages/pages.jsonl`: one for each document. */
  readonly pages: number;
}

/** This function writes lines to a file in batches of approximately 64 KiB. It gives the count of lines. */
const writeLines = async (file: TalliedFile, lines: AsyncIterable<Uint8Array>): Promise<number> => {
  let batch: Uint8Array[] = [];
  let size = 0;
  let count = 0;
  for await (const line of lines) {
    batch.push(line, NEWLINE);
    size += line.length + 1;
    count += 1;
    if (size >= 65_536) {
      await file.write(Buffer.concat(batch));
      batch = [];
      size = 0;
    }
  }
  if (batch.length > 0) await file.write(Buffer.concat(batch));
  return count;
};

/**
 * This function keeps the last line of each document. Each line is the key of the document, a tab,
 * the time, a tab and the JSON of the page. The sorter gives the lines of one key together, the
 * oldest first.
 */
async function* latestOf(lines: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let held: Buffer | undefined;
  let heldKey: Buffer | undefined;
  for await (const line of lines) {
    const key = line.subarray(0, line.indexOf(TAB));
    if (held !== undefined && heldKey !== undefined && !key.equals(heldKey)) {
      yield held.subarray(held.indexOf(TAB, heldKey.length + 1) + 1);
    }
    held = line;
    heldKey = key;
  }
  if (held !== undefined && heldKey !== undefined)
    yield held.subarray(held.indexOf(TAB, heldKey.length + 1) + 1);
}

const resourceOf = (
  path: string,
  facts: Tallied,
): {
  readonly name: string;
  readonly path: string;
  readonly hash: string;
  readonly bytes: number;
} => ({
  name: basename(path).toLowerCase(),
  path,
  hash: `sha256:${facts.sha256}`,
  bytes: facts.size,
});

/**
 * This function writes the captures of a store as a WACZ 1.1.1 file. The ZIP holds these parts:
 *
 * - `archive/data.warc.gz`: the WARC file of `exportWarc`, stored with no more compression, so a
 *   replay tool reads a record at its offset.
 * - `indexes/index.cdxj`: the index of the `response` and `revisit` records, sorted by SURT key.
 * - `pages/pages.jsonl`: one page for each document, at its latest capture.
 * - `datapackage.json` and `datapackage-digest.json`: the SHA-256 of each part, and of the package.
 *
 * The index and the page list are sorted on the disk, so the memory does not grow with the store.
 * The export writes temporary files beside `out` and removes them at the end.
 */
export const exportWacz = async (
  source: ArchiveSource,
  options: ArchiveOptions,
): Promise<WaczResult> => {
  const plan = planArchive(source, options);
  const { target, temporary } = outputOf(options);
  const parts = `${temporary}.parts`;
  await mkdir(parts, { recursive: true, mode: 0o700 });
  try {
    const created = new Date();
    const warc = await TalliedFile.create(join(parts, WARC_NAME));
    const index = new LineSorter(join(parts, "index"));
    const pages = new LineSorter(join(parts, "pages"));
    let counts: ArchiveCounts;
    try {
      counts = await writeArchive(plan, warc, WARC_NAME, async (record) => {
        await index.add(cdxjLine(record, WARC_NAME));
        if (record.page) {
          const page = JSON.stringify({ id: record.capture, url: record.url, ts: record.date });
          await pages.add(`${cacheKeyOf(record.url)}\t${record.date}\t${page}`);
        }
      });
    } catch (error) {
      await warc.abandon();
      throw error;
    }
    const archive = await warc.close();

    const indexFile = await TalliedFile.create(join(parts, "index.cdxj"));
    try {
      await writeLines(indexFile, index.sorted());
    } catch (error) {
      await indexFile.abandon();
      throw error;
    }
    const indexFacts = await indexFile.close();

    const pagesFile = await TalliedFile.create(join(parts, "pages.jsonl"));
    let pageCount: number;
    try {
      await pagesFile.write(Buffer.from(`${JSON.stringify(PAGES_HEADER)}\n`));
      pageCount = await writeLines(pagesFile, latestOf(pages.sorted()));
    } catch (error) {
      await pagesFile.abandon();
      throw error;
    }
    const pagesFacts = await pagesFile.close();

    const datapackage = Buffer.from(
      JSON.stringify(
        {
          profile: "data-package",
          wacz_version: WACZ_VERSION,
          software: `polite-crawler ${VERSION}`,
          created: created.toISOString().replace(/\.\d{3}Z$/, "Z"),
          title: "polite-crawler export",
          resources: [
            resourceOf(`archive/${WARC_NAME}`, archive),
            resourceOf("indexes/index.cdxj", indexFacts),
            resourceOf("pages/pages.jsonl", pagesFacts),
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const digest = Buffer.from(
      JSON.stringify(
        {
          path: "datapackage.json",
          hash: `sha256:${createHash("sha256").update(datapackage).digest("hex")}`,
        },
        null,
        2,
      ),
      "utf8",
    );

    const deflated = async (name: string, facts: Tallied): Promise<ZipMember> => {
      const file = `${facts.path}.deflate`;
      return {
        name,
        method: 8,
        crc: facts.crc,
        size: facts.size,
        compressedSize: await deflateFile(facts.path, file),
        file,
      };
    };
    const members: ZipMember[] = [
      {
        name: `archive/${WARC_NAME}`,
        method: 0,
        crc: archive.crc,
        size: archive.size,
        compressedSize: archive.size,
        file: archive.path,
      },
      await deflated("indexes/index.cdxj", indexFacts),
      await deflated("pages/pages.jsonl", pagesFacts),
      memberOf("datapackage.json", datapackage),
      memberOf("datapackage-digest.json", digest),
    ];
    let bytes: number;
    try {
      bytes = await writeZip(temporary, members, { date: created });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return { format: "wacz", out: target, bytes, pages: pageCount, ...counts };
  } finally {
    await rm(parts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};
