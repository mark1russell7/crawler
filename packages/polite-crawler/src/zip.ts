import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

/*
 * This module writes a ZIP file with node:zlib only. The WACZ export uses it. It is not part of the
 * API of the package.
 *
 * - A member is stored (method 0) or deflated (method 8).
 * - The writer knows the CRC-32 and the sizes of each member before it writes the member. Thus the
 *   local headers hold the true values, and the file has no data descriptors.
 * - The writer adds the Zip64 records only when a size, an offset or the count of members is too
 *   large for the fields of 32 bits. The option `zip64: "always"` adds them in each case, for a test.
 */

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** This function calculates the CRC-32 of ISO 3309 with a table. It is the fallback of `crc32`. */
export const tableCrc32 = (bytes: Uint8Array, value = 0): number => {
  let crc = ~value >>> 0;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
};

const native = (zlib as { readonly crc32?: (data: Uint8Array, value?: number) => number }).crc32;

/** This function calculates the CRC-32 of the bytes. It continues from `value`. It uses `zlib.crc32` when Node.js has it. */
export const crc32 = (bytes: Uint8Array, value = 0): number =>
  native === undefined ? tableCrc32(bytes, value) : native(bytes, value);

/** These are the facts of a file that a tally gives at its close. */
export interface Tallied {
  readonly path: string;
  readonly size: number;
  readonly crc: number;
  /** This value is the SHA-256 of the bytes, as hexadecimal digits. */
  readonly sha256: string;
}

/** This function writes the whole buffer. A write can write less than the buffer, and the loop writes the rest. */
export const writeAll = async (handle: FileHandle, bytes: Uint8Array): Promise<void> => {
  let at = 0;
  while (at < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.length - at);
    at += bytesWritten;
  }
};

/** A tally writes a new file in sequence. It counts the bytes and calculates their CRC-32 and SHA-256. */
export class TalliedFile {
  private readonly hash = createHash("sha256");
  private crcValue = 0;
  private count = 0;

  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  /** This method makes a new file. It fails when the file exists. */
  static async create(path: string): Promise<TalliedFile> {
    return new TalliedFile(path, await open(path, "wx", 0o600));
  }

  /** This value is the count of bytes that the tally wrote. It is the offset of the next write. */
  get size(): number {
    return this.count;
  }

  async write(bytes: Uint8Array): Promise<void> {
    await writeAll(this.handle, bytes);
    this.hash.update(bytes);
    this.crcValue = crc32(bytes, this.crcValue);
    this.count += bytes.length;
  }

  /** This method closes the file and gives its facts. */
  async close(): Promise<Tallied> {
    await this.handle.close();
    return {
      path: this.path,
      size: this.count,
      crc: this.crcValue,
      sha256: this.hash.digest("hex"),
    };
  }

  /** This method closes the file after an error. It gives no facts. */
  async abandon(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

/** This function deflates a file into a new file (raw deflate, as ZIP needs it). It gives the size of the new file. */
export const deflateFile = async (from: string, to: string): Promise<number> => {
  await pipeline(
    createReadStream(from),
    zlib.createDeflateRaw(),
    createWriteStream(to, { flags: "wx", mode: 0o600 }),
  );
  return (await stat(to)).size;
};

/** A member of a ZIP file. Its bytes are in a file or in memory, as the ZIP stores them. */
export interface ZipMember {
  /** This value is the path of the member in the ZIP file. */
  readonly name: string;
  /** The value 0 stores the bytes. The value 8 holds deflated bytes. */
  readonly method: 0 | 8;
  /** This value is the CRC-32 of the bytes before compression. */
  readonly crc: number;
  /** This value is the count of bytes before compression. */
  readonly size: number;
  /** This value is the count of bytes in the ZIP file. */
  readonly compressedSize: number;
  /** This file holds the bytes as the ZIP stores them. */
  readonly file?: string | undefined;
  /** These bytes are the member as the ZIP stores them, when `file` is not given. */
  readonly data?: Uint8Array | undefined;
}

/** This function makes a member from bytes in memory. A member of method 8 holds the bytes deflated. */
export const memberOf = (name: string, bytes: Uint8Array, method: 0 | 8 = 8): ZipMember => {
  const data = method === 8 ? zlib.deflateRawSync(bytes) : bytes;
  return {
    name,
    method,
    crc: crc32(bytes),
    size: bytes.length,
    compressedSize: data.length,
    data,
  };
};

/** These options change a ZIP file. */
export interface ZipOptions {
  /** This time goes into each member, in the MS-DOS format of ZIP (UTC, to 2 seconds). */
  readonly date: Date;
  /** The value `auto` (the default) adds the Zip64 records only when they are necessary. */
  readonly zip64?: "auto" | "always" | undefined;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const VERSION_ZIP = 20;
const VERSION_ZIP64 = 45;
/** The member was made on Unix (3), with version 4.5 of the specification. */
const MADE_BY = (3 << 8) | VERSION_ZIP64;
/** A plain file that its owner can read and write, and the others can read (`0o100644`). */
const FILE_MODE = (0o100644 << 16) >>> 0;
/** Bit 11 of the flags tells that the name is UTF-8. */
const UTF8_NAMES = 0x0800;

const dosTime = (date: Date): { readonly time: number; readonly day: number } => {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
};

/** This function makes the Zip64 extra field (id 0x0001) with these values of 64 bits. */
const zip64Extra = (values: readonly number[]): Buffer => {
  const extra = Buffer.alloc(4 + 8 * values.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(8 * values.length, 2);
  values.forEach((value, at) => extra.writeBigUInt64LE(BigInt(value), 4 + 8 * at));
  return extra;
};

/**
 * This function writes a ZIP file with these members, in this sequence. It writes a new file and
 * fails when the file exists. It gives the size of the ZIP file.
 */
export const writeZip = async (
  target: string,
  members: readonly ZipMember[],
  options: ZipOptions,
): Promise<number> => {
  const always = options.zip64 === "always";
  const { time, day } = dosTime(options.date);
  const handle = await open(target, "wx", 0o600);
  let offset = 0;
  const put = async (bytes: Uint8Array): Promise<void> => {
    await writeAll(handle, bytes);
    offset += bytes.length;
  };
  try {
    const central: Buffer[] = [];
    for (const member of members) {
      const name = Buffer.from(member.name, "utf8");
      const start = offset;
      const bigSizes = always || member.size >= MAX32 || member.compressedSize >= MAX32;
      const localExtra = bigSizes
        ? zip64Extra([member.size, member.compressedSize])
        : Buffer.alloc(0);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(bigSizes ? VERSION_ZIP64 : VERSION_ZIP, 4);
      local.writeUInt16LE(UTF8_NAMES, 6);
      local.writeUInt16LE(member.method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(member.crc >>> 0, 14);
      local.writeUInt32LE(bigSizes ? MAX32 : member.compressedSize, 18);
      local.writeUInt32LE(bigSizes ? MAX32 : member.size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(localExtra.length, 28);
      await put(local);
      await put(name);
      await put(localExtra);
      const before = offset;
      if (member.file !== undefined) {
        for await (const chunk of createReadStream(member.file) as AsyncIterable<Buffer>)
          await put(chunk);
      } else await put(member.data ?? new Uint8Array());
      if (offset - before !== member.compressedSize)
        throw new Error(
          `the member ${member.name} has ${String(offset - before)} bytes, not ${String(member.compressedSize)}`,
        );

      // the central header names only the values that are too large, in this sequence
      const bigSize = always || member.size >= MAX32;
      const bigCompressed = always || member.compressedSize >= MAX32;
      const bigOffset = always || start >= MAX32;
      const values = [
        ...(bigSize ? [member.size] : []),
        ...(bigCompressed ? [member.compressedSize] : []),
        ...(bigOffset ? [start] : []),
      ];
      const extra = values.length > 0 ? zip64Extra(values) : Buffer.alloc(0);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(MADE_BY, 4);
      header.writeUInt16LE(values.length > 0 ? VERSION_ZIP64 : VERSION_ZIP, 6);
      header.writeUInt16LE(UTF8_NAMES, 8);
      header.writeUInt16LE(member.method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(day, 14);
      header.writeUInt32LE(member.crc >>> 0, 16);
      header.writeUInt32LE(bigCompressed ? MAX32 : member.compressedSize, 20);
      header.writeUInt32LE(bigSize ? MAX32 : member.size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(FILE_MODE, 38);
      header.writeUInt32LE(bigOffset ? MAX32 : start, 42);
      central.push(header, name, extra);
    }

    const centralStart = offset;
    for (const part of central) await put(part);
    const centralSize = offset - centralStart;
    const count = members.length;
    const zip64End = always || count >= MAX16 || centralStart >= MAX32 || centralSize >= MAX32;
    if (zip64End) {
      const recordAt = offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(MADE_BY, 12);
      record.writeUInt16LE(VERSION_ZIP64, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(centralSize), 40);
      record.writeBigUInt64LE(BigInt(centralStart), 48);
      await put(record);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(recordAt), 8);
      locator.writeUInt32LE(1, 16);
      await put(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(zip64End ? MAX16 : count, 8);
    end.writeUInt16LE(zip64End ? MAX16 : count, 10);
    end.writeUInt32LE(zip64End ? MAX32 : centralSize, 12);
    end.writeUInt32LE(zip64End ? MAX32 : centralStart, 16);
    end.writeUInt16LE(0, 20);
    await put(end);
  } finally {
    await handle.close();
  }
  return offset;
};
