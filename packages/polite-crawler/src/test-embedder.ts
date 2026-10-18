import type { EmbedCallOptions, Embedder } from "./embed.ts";

/**
 * These helpers are for the tests of the package. They are not part of the API.
 *
 * The fake embedder gives the same vector for the same text each time, with no model. Each group
 * of `CONCEPTS` is one dimension: the words of a group point the vector in the same direction.
 * Thus "loaf" is close to "bread" with no word in common. Each other word goes into one of 12
 * buckets, with a small weight.
 */

/** These groups of words have a similar meaning in the fake embedder. */
export const CONCEPTS: readonly (readonly string[])[] = [
  [
    "bread",
    "loaf",
    "sourdough",
    "bake",
    "baker",
    "bakery",
    "baking",
    "rye",
    "focaccia",
    "crust",
    "dough",
    "oven",
    "flour",
  ],
  ["boat", "ship", "sail", "sailing", "harbor", "yacht", "ferry", "sea", "dock"],
  ["car", "engine", "wheel", "garage", "motor", "road", "truck"],
  ["garden", "flower", "plant", "soil", "seed", "tree", "rose"],
];

const BUCKETS = 12;

/** This is a fake embedder that records each call. */
export interface FakeEmbedder extends Embedder {
  /** These are the texts of each call, in sequence. */
  readonly calls: Array<{ readonly texts: readonly string[]; readonly purpose: string }>;
  /** This function gives each text that the embedder got for documents. */
  readonly documents: () => string[];
  /** This value counts the calls of `close`. */
  readonly closed: { count: number };
}

/** These options change the fake embedder. */
export interface FakeOptions {
  readonly id?: string;
  /** This value adds dimensions of zeros, for a test of a change of dimensions. */
  readonly extra?: number;
  readonly maxInputTokens?: number;
  /** This function can change the answer of a call, for the tests of the errors. */
  readonly answer?: (texts: readonly string[], vectors: Float32Array[]) => Float32Array[];
  /** This value is a wait in milliseconds before each answer. */
  readonly delayMs?: number;
}

const bucketOf = (word: string): number => {
  let hash = 0;
  for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % BUCKETS;
};

/** This function gives the vector of a text in the fake embedder. */
export const fakeVector = (text: string, extra = 0): Float32Array => {
  const vector = new Float32Array(CONCEPTS.length + BUCKETS + extra);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const concept = CONCEPTS.findIndex((group) => group.includes(word));
    if (concept !== -1) vector[concept]! += 1;
    else vector[CONCEPTS.length + bucketOf(word)]! += 0.2;
  }
  return vector;
};

/** This function makes a fake embedder. */
export const fakeEmbedder = (options: FakeOptions = {}): FakeEmbedder => {
  const calls: Array<{ readonly texts: readonly string[]; readonly purpose: string }> = [];
  const closed = { count: 0 };
  return {
    id: options.id ?? "fake:concepts-1",
    dimensions: CONCEPTS.length + BUCKETS + (options.extra ?? 0),
    maxInputTokens: options.maxInputTokens ?? 64,
    calls,
    closed,
    documents: () =>
      calls.filter((call) => call.purpose === "document").flatMap((call) => [...call.texts]),
    async embed(texts: readonly string[], call: EmbedCallOptions): Promise<Float32Array[]> {
      call.signal?.throwIfAborted();
      calls.push({ texts: [...texts], purpose: call.purpose ?? "document" });
      if (options.delayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          call.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(call.signal?.reason as Error);
          });
        });
      }
      const vectors = texts.map((text) => fakeVector(text, options.extra ?? 0));
      return options.answer === undefined ? vectors : options.answer(texts, vectors);
    },
    close() {
      closed.count += 1;
      return Promise.resolve();
    },
  };
};
