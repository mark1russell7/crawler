import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A blob store keeps the bytes of each response, and the hash of the bytes is the key. The crawler
 * needs only these two operations, so an application can give its own store.
 */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<{ readonly hash: string }>;
  get(hash: string): Promise<Uint8Array | undefined>;
}

/**
 * These options change a file blob store.
 *
 * @beta
 */
export interface FileBlobStoreOptions {
  /** When this value is true (the default), a blob is on the disk (`fsync`) before `put` finishes. */
  readonly sync?: boolean | undefined;
}

const HASH = /^[0-9a-f]{64}$/;

/** A rename can fail with these codes when a different writer puts the same blob at the same time. */
const RACE_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "EEXIST",
  "EBUSY",
  "EACCES",
  "ENOTEMPTY",
]);

const blobPath = (root: string, hash: string): string =>
  join(root, hash.slice(0, 2), hash.slice(2, 4), hash);

const hashOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const codeOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";

const statOf = (path: string): Promise<Stats | undefined> => stat(path).catch(() => undefined);

/** This function writes a folder to the disk, so a rename in it stays after a power cut. Windows cannot open a folder, so it skips this step. */
const syncFolder = async (path: string): Promise<void> => {
  if (process.platform === "win32") return;
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // a file system that cannot sync a folder keeps the blob in any case
  }
};

/**
 * This store keeps each blob in a file: `<dir>/ab/cd/abcd…`, where the name is the SHA-256 hash
 * of the bytes. These are its rules:
 *
 * - Equal bytes are written one time only. A file of the wrong size (a write that a crash cut) is
 *   written again.
 * - A write goes to a temporary file with a random name, goes to the disk, and then gets its name.
 *   A crash thus cannot leave half a blob under its name.
 * - Two writers can put the same bytes at the same time. When the rename of one fails because the
 *   other was first, the put succeeds if the stored file has the same hash.
 * - The method `get` examines the hash of the bytes. A damaged file gets a new name
 *   (`.damaged`), and `get` gives no bytes, so the crawler fetches the body again.
 *
 * @beta
 */
export class FileBlobStore implements BlobStore {
  private readonly writing = new Map<
    string,
    Promise<{ readonly hash: string; readonly existed: boolean }>
  >();
  private readonly sync: boolean;

  constructor(
    readonly dir: string,
    options: FileBlobStoreOptions = {},
  ) {
    this.sync = options.sync ?? true;
  }

  put(bytes: Uint8Array): Promise<{ readonly hash: string; readonly existed: boolean }> {
    const hash = hashOf(bytes);
    const running = this.writing.get(hash);
    if (running !== undefined) return running;
    const work = this.write(hash, bytes).finally(() => this.writing.delete(hash));
    this.writing.set(hash, work);
    return work;
  }

  /** This method tells if a file holds exactly the bytes of a hash. */
  private static async holds(path: string, hash: string): Promise<boolean> {
    try {
      return hashOf(await readFile(path)) === hash;
    } catch {
      return false;
    }
  }

  private async write(
    hash: string,
    bytes: Uint8Array,
  ): Promise<{ readonly hash: string; readonly existed: boolean }> {
    const target = blobPath(this.dir, hash);
    const existing = await statOf(target);
    if (existing?.isFile() === true && existing.size === bytes.length)
      return { hash, existed: true };
    const folder = dirname(target);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        if (this.sync) await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, target);
      } catch (error) {
        // a different writer put the same bytes first, and Windows does not replace a file in use
        if (!RACE_CODES.has(codeOf(error)) || !(await FileBlobStore.holds(target, hash)))
          throw error;
        return { hash, existed: true };
      }
      if (this.sync) await syncFolder(folder);
      return { hash, existed: false };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async get(hash: string): Promise<Uint8Array | undefined> {
    if (!HASH.test(hash)) return undefined;
    const target = blobPath(this.dir, hash);
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch {
      return undefined;
    }
    if (hashOf(bytes) !== hash) {
      // a torn or damaged file is never the body: it moves away, and the next put writes it again
      await rename(target, `${target}.${randomUUID()}.damaged`).catch(() => undefined);
      return undefined;
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}
