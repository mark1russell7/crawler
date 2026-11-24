/**
 * Kept replies of a poll. A 304 answer of `poll` has no body: the caller keeps the result of the
 * last full answer. A caller that reads each full answer into many values keeps those values until
 * the next full answer. Thus its memory grows with the data of the feed. `keptReplies` keeps the
 * last full reply of each URL with its body as compressed bytes. At a 304, the caller reads the
 * reply again and gets the same values.
 *
 * - The compression is the Web stream `CompressionStream` with the format `deflate-raw`. Node.js
 *   and the browser have it. In Node.js, the stream operates in the thread pool of `zlib`, thus it
 *   does not block the event loop.
 * - The store keeps a value of the caller with each reply, for example the time of the fetch and
 *   its latency. Thus a new read gives the same result.
 * - A reply with `bytes` keeps its bytes as they are. Only the text body gets the compression.
 * - A failed compression or expansion rejects the `get` of the URL. The caller then has no earlier
 *   full answer.
 *
 * `keptFetch` and `keptStore` keep the answers of a `fetch` as text, for the clients that save
 * them between two runs. `keptReplies` keeps the replies of `poll` in memory for one run.
 */
import type { Reply } from "./api.ts";

/** This function gives the compressed bytes of a text. */
const deflate = async (text: string): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** This function gives the text of compressed bytes. */
const inflate = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
  ).text();

/**
 * One reply of a store of kept replies, with the value that the caller kept with it.
 *
 * @beta
 */
export interface KeptReply<Extra> {
  /** This value is the reply, with its body. */
  readonly reply: Reply;
  /** This value is the value that the caller kept with the reply. */
  readonly extra: Extra;
}

/**
 * A store of the last full reply of each URL.
 *
 * @beta
 */
export interface KeptReplies<Extra> {
  /** This method keeps the full reply of a URL in place of the last one. */
  keep(url: string, reply: Reply, extra: Extra): void;
  /** This method gives the last full reply of a URL, or `undefined` when the store has none. */
  get(url: string): Promise<KeptReply<Extra> | undefined>;
  /** This method removes the reply of a URL. */
  delete(url: string): void;
}

/** One reply in the store. The compression is a promise, thus a 304 that comes first waits for it. */
interface Entry<Extra> {
  readonly reply: Omit<Reply, "body">;
  readonly body: Promise<Uint8Array<ArrayBuffer>>;
  readonly extra: Extra;
}

/**
 * This function makes a store of the last full reply of each URL of a poll, with each text body
 * as compressed bytes. The store is in memory.
 *
 * @beta
 */
export function keptReplies<Extra>(): KeptReplies<Extra> {
  const entries = new Map<string, Entry<Extra>>();
  return {
    keep(url, reply, extra) {
      const { body, ...rest } = reply;
      const entry: Entry<Extra> = { reply: rest, body: deflate(body), extra };
      // A failed compression rejects only the next `get` of the URL. This handler stops an unhandled rejection before it.
      entry.body.catch(() => undefined);
      entries.set(url, entry);
    },
    async get(url) {
      const entry = entries.get(url);
      if (entry === undefined) return undefined;
      const body = await inflate(await entry.body);
      return { reply: { ...entry.reply, body }, extra: entry.extra };
    },
    delete(url) {
      entries.delete(url);
    },
  };
}
