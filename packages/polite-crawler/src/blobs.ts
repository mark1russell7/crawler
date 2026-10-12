import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A blob store keeps the bytes of each response, and the hash of the bytes is the key. The crawler
 * needs only these two operations, so an application can give its own store.
 */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<{ readonly hash: string }>;
  get(hash: string): Promise<Uint8Array | undefined>;
}

const blobPath = (root: string, hash: string): string =>
  join(root, hash.slice(0, 2), hash.slice(2, 4), hash);

/**
 * This store keeps each blob in a file: `<dir>/ab/cd/abcd…`, where the name is the SHA-256 hash
 * of the bytes. Equal bytes are written one time only. A write goes to a temporary file first,
 * so a crash cannot leave half a blob.
 */
export class FileBlobStore implements BlobStore {
  constructor(readonly dir: string) {}

  async put(bytes: Uint8Array): Promise<{ readonly hash: string; readonly existed: boolean }> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const target = blobPath(this.dir, hash);
    if (existsSync(target)) return { hash, existed: true };
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${String(process.pid)}-${String(Date.now())}`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
    return { hash, existed: false };
  }

  async get(hash: string): Promise<Uint8Array | undefined> {
    const target = blobPath(this.dir, hash);
    if (!existsSync(target)) return undefined;
    return new Uint8Array(await readFile(target));
  }
}
