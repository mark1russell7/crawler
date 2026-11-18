/**
 * The sealed form of a store of kept answers. Use it for a place that other people can read, for
 * example the cache of a public repository in GitHub Actions. A kept answer of a private resource
 * holds its body as text. Thus a client that saves its store in such a place seals it first.
 *
 * `sealKept` encrypts the entries with AES-256-GCM. The key comes from a secret by HKDF-SHA-256
 * (RFC 5869). Each seal has a new random salt, and the label of the use is the info. Thus two labels
 * give two keys from one secret. The format name is the first line of the bytes. It is also the
 * associated data of the cipher, so a change of the format cannot go unseen.
 *
 * Each entry is compressed alone (gzip) before the encryption. A compression of all entries together
 * puts the text of one answer in the window of another answer. Then the size of the sealed bytes can
 * tell something of a private answer to a person who controls a public answer. With one compression
 * for each entry, the text of an answer meets only its own text.
 *
 * The functions use only Web APIs (`crypto.subtle`, `CompressionStream`). Thus they operate in
 * Node.js and in a browser.
 */
import { readKept, type Kept } from "./kept.ts";

/**
 * The name and the version of the sealed format. It is the first line of the sealed bytes.
 *
 * @beta
 */
export const KEPT_SEAL_FORMAT = "polite-crawler-kept-sealed/1";

/**
 * The smallest secret that `sealKept` and `openKept` take, in bytes. HKDF does not slow a guess, so
 * the secret must be a random key, not a password.
 *
 * @beta
 */
export const KEPT_SEAL_SECRET_MIN = 16;

/**
 * The options of `sealKept` and `openKept`.
 *
 * @beta
 */
export interface SealOptions {
  /**
   * This value is the label of the use, for example the name of the client. A store opens only with
   * the label that sealed it. Give a label when the secret has a second use. The default is "".
   */
  readonly label?: string | undefined;
}

/**
 * The result of `openKept`.
 *
 * @beta
 */
export interface OpenedKept {
  /** These values are the entries of the store. They are empty when the store does not open. */
  readonly entries: [string, Kept][];
  /** This value tells why the store gave fewer entries or none, when that occurs. */
  readonly note?: string | undefined;
}

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEADER = encoder.encode(`${KEPT_SEAL_FORMAT}\n`);

/** This function gives the bytes of the secret, or throws when the secret is too short. */
const secretBytes = (secret: string | Uint8Array): Uint8Array<ArrayBuffer> => {
  const bytes = typeof secret === "string" ? encoder.encode(secret) : new Uint8Array(secret);
  if (bytes.length < KEPT_SEAL_SECRET_MIN) {
    throw new RangeError(
      `The secret of a sealed store needs ${KEPT_SEAL_SECRET_MIN} bytes or more, and it has ${bytes.length}. Give a random key.`,
    );
  }
  return bytes;
};

/** This function gives the AES-GCM key of a seal from the secret, the salt and the label. */
const keyOf = async (
  secret: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  label: string,
  use: "encrypt" | "decrypt",
) => {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const info = encoder.encode(`${KEPT_SEAL_FORMAT}\n${label}`);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [use],
  );
};

/** This function sends the bytes through a compression stream or a decompression stream. */
const through = async (
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/** This function joins the parts into one array of bytes. */
const join = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * This function seals the entries of a store of kept answers, for example the `used` entries of a
 * run. It compresses each entry alone, and it encrypts all of them with a key from the secret. It
 * throws a `RangeError` when the secret has fewer than `KEPT_SEAL_SECRET_MIN` bytes.
 *
 * @beta
 */
export async function sealKept(
  entries: Iterable<readonly [string, Kept]>,
  secret: string | Uint8Array,
  options: SealOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const key = secretBytes(secret);
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const packed = await through(
      encoder.encode(JSON.stringify(entry)),
      new CompressionStream("gzip"),
    );
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, packed.length);
    parts.push(length, packed);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherKey = await keyOf(key, salt, options.label ?? "", "encrypt");
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: HEADER },
    cipherKey,
    join(parts),
  );
  return join([HEADER, salt, iv, new Uint8Array(sealed)]);
}

/**
 * This function opens a store that `sealKept` sealed, and gives its entries. Data that does not open
 * (another format, another secret, another label, damaged bytes) gives no entries and a note, and no
 * error, so a client goes on with an empty store. It throws a `RangeError` when the secret has fewer
 * than `KEPT_SEAL_SECRET_MIN` bytes, as `sealKept` does. As `readKept` does, it drops each entry that
 * does not have the shape of a kept answer.
 *
 * @beta
 */
export async function openKept(
  sealed: Uint8Array,
  secret: string | Uint8Array,
  options: SealOptions = {},
): Promise<OpenedKept> {
  const key = secretBytes(secret);
  const bytes = new Uint8Array(sealed);
  if (bytes.length < HEADER.length || HEADER.some((byte, index) => bytes[index] !== byte)) {
    return {
      entries: [],
      note: `The data is not a sealed store of the format ${KEPT_SEAL_FORMAT}.`,
    };
  }
  const start = HEADER.length;
  if (bytes.length < start + SALT_BYTES + IV_BYTES + TAG_BYTES) {
    return { entries: [], note: "The sealed store is too short, so it is damaged." };
  }
  const salt = bytes.slice(start, start + SALT_BYTES);
  const iv = bytes.slice(start + SALT_BYTES, start + SALT_BYTES + IV_BYTES);
  let plain: Uint8Array<ArrayBuffer>;
  try {
    const cipherKey = await keyOf(key, salt, options.label ?? "", "decrypt");
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: HEADER },
      cipherKey,
      bytes.slice(start + SALT_BYTES + IV_BYTES),
    );
    plain = new Uint8Array(opened);
  } catch {
    return {
      entries: [],
      note: "The sealed store does not open: another secret, another label, or damaged bytes.",
    };
  }
  const read: unknown[] = [];
  const view = new DataView(plain.buffer);
  let at = 0;
  try {
    while (at < plain.length) {
      if (at + 4 > plain.length) throw new Error("a length is cut");
      const length = view.getUint32(at);
      at += 4;
      if (at + length > plain.length) throw new Error("an entry is cut");
      read.push(
        JSON.parse(
          decoder.decode(
            await through(plain.slice(at, at + length), new DecompressionStream("gzip")),
          ),
        ),
      );
      at += length;
    }
  } catch {
    return {
      entries: readKept(read),
      note: "An entry of the sealed store does not read, so the store gives only the entries before it.",
    };
  }
  return { entries: readKept(read) };
}
