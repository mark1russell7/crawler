/**
 * The parts of hybrid search that need no store: the embedder interface, the chunks of a text, and
 * the fusion of ranked lists.
 *
 * An embedder changes texts into vectors. Two texts with a similar meaning get vectors that point
 * in a similar direction. Hybrid search ranks the stored documents two times: one time with the
 * full-text index (BM25), one time by the cosine of the vectors. Reciprocal rank fusion (RRF) then
 * makes one list of the two.
 *
 * `Embedder` is the extension point. `transformersEmbedder` and `ollamaEmbedder` are two adapters,
 * and an application can give an embedder of its own, as it can give a renderer of its own.
 */

/** These options go to each call of `Embedder.embed`. */
export interface EmbedCallOptions {
  /** When this signal aborts, the embedder stops and rejects with the reason of the signal. */
  readonly signal?: AbortSignal | undefined;
  /**
   * This value tells what the texts are: `document` (parts of stored texts, the default) or `query`
   * (the words of a search). Some models want a different prefix for each.
   */
  readonly purpose?: "document" | "query" | undefined;
}

/**
 * An embedder changes texts into vectors. The vector store keeps each vector with the `id` of its
 * embedder, so the vectors of two models do not mix.
 */
export interface Embedder {
  /** This text names the model and its version. Change it when the vectors of the model change. */
  readonly id: string;
  /** This value is the length of each vector. The value 0 tells that the embedder learns it from its first answer. */
  readonly dimensions: number;
  /** This value is the largest input of the model, in tokens. The chunks of a text fit in it. The default is 256. */
  readonly maxInputTokens?: number | undefined;
  /** This method gives one vector for each text, in the same sequence. */
  embed(texts: readonly string[], options: EmbedCallOptions): Promise<Float32Array[]>;
  /** This optional method releases the model. A later call of `embed` loads it again. */
  close?(): Promise<void>;
}

// ── chunks ──────────────────────────────────────────────────────────────────

/**
 * These are the limits of the chunks of a text.
 *
 * @beta
 */
export const CHUNK_LIMITS: {
  /** A chunk has this number of tokens at most, also for a model with a larger input. */
  readonly maxTokens: number;
  /** A chunk has this number of tokens when the embedder does not give `maxInputTokens`. */
  readonly defaultTokens: number;
  /** A chunk fills this share of its limit, because the count of the tokens is an estimate. */
  readonly fill: number;
  /** Two chunks next to each other share this share of the tokens of a chunk. */
  readonly overlap: number;
  /** A text gives this number of chunks at most. The rest of a longer text gets no vector. */
  readonly maxChunks: number;
} = { maxTokens: 512, defaultTokens: 256, fill: 0.9, overlap: 0.1, maxChunks: 64 };

/**
 * This is one chunk of a text: a window of paragraphs, with its position in the text.
 *
 * @beta
 */
export interface TextChunk {
  /** This value is the position of the chunk in the list, from 0. */
  readonly index: number;
  /** These values are the positions of the chunk in the text, in UTF-16 units. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * These options control the chunks of a text.
 *
 * @beta
 */
export interface ChunkOptions {
  /** This value is the largest number of tokens in a chunk. */
  readonly maxTokens: number;
  /** This value is the number of tokens that two chunks next to each other can share. The default is 10 percent of `maxTokens`. */
  readonly overlapTokens?: number | undefined;
  /** This value is the largest number of chunks. The default is `CHUNK_LIMITS.maxChunks`. */
  readonly maxChunks?: number | undefined;
}

/** These scripts write no space between words, so the estimate counts each character as a token. */
const SEGMENTED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD = /[\p{L}\p{N}\p{M}]/u;
const SPACE = /\s/u;

/** A word of this number of letters or fewer is one token in the estimate. A longer word is more tokens. */
const LETTERS_PER_TOKEN = 6;

const isAsciiWord = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a);
const isAsciiSpace = (code: number): boolean => code === 0x20 || (code >= 0x09 && code <= 0x0d);

/** This value is the kind of a code point for the estimate: a letter, a space, a segmented character or a different character. */
type Kind = "word" | "space" | "segmented" | "other";

const kindOf = (point: number): Kind => {
  if (point < 0x80) return isAsciiWord(point) ? "word" : isAsciiSpace(point) ? "space" : "other";
  const char = String.fromCodePoint(point);
  if (SEGMENTED.test(char)) return "segmented";
  if (WORD.test(char)) return "word";
  return SPACE.test(char) ? "space" : "other";
};

/**
 * This function estimates the number of tokens of a part of a text. A word is one token for each
 * six letters. A Chinese, Japanese or Thai character is one token. Each other character that is
 * not a space is one token. The estimate is a little high for English text, so a chunk fits.
 *
 * @beta
 */
export const estimateTokens = (
  text: string,
  start: number = 0,
  end: number = text.length,
): number => {
  let tokens = 0;
  let run = 0;
  for (let at = start; at < end;) {
    const point = text.codePointAt(at)!;
    at += point > 0xffff ? 2 : 1;
    const kind = kindOf(point);
    if (kind === "word") {
      run += 1;
      continue;
    }
    if (run > 0) tokens += Math.ceil(run / LETTERS_PER_TOKEN);
    run = 0;
    if (kind !== "space") tokens += 1;
  }
  if (run > 0) tokens += Math.ceil(run / LETTERS_PER_TOKEN);
  return tokens;
};

/** A piece of a text: a sentence, or a part of a long sentence. A chunk is a run of pieces. */
interface Piece {
  readonly start: number;
  readonly end: number;
  readonly tokens: number;
  /** This value is true when the piece starts a paragraph. A chunk ends at a paragraph when it can. */
  readonly paragraph: boolean;
}

/** These characters end a sentence when a space follows them. */
const STOP = /[.!?…]+["'”’)\]]*(?=\s|$)|[。！？]+/gu;

/** This function gives the ranges of the sentences of a part of a text, with no space at the ends. */
const sentencesOf = (
  text: string,
  start: number,
  end: number,
): Array<readonly [number, number]> => {
  const part = text.slice(start, end);
  const out: Array<readonly [number, number]> = [];
  let from = 0;
  for (const match of part.matchAll(STOP)) {
    const to = match.index + match[0].length;
    if (to > from) out.push([from, to]);
    from = to;
  }
  if (from < part.length) out.push([from, part.length]);
  return out
    .map(([a, b]): readonly [number, number] => {
      let first = a;
      let last = b;
      while (first < last && SPACE.test(part[first]!)) first += 1;
      while (last > first && SPACE.test(part[last - 1]!)) last -= 1;
      return [start + first, start + last];
    })
    .filter(([a, b]) => b > a);
};

/** This function cuts a part of a text that is longer than the limit. It cuts at the spaces, and in a word that is too long. */
const cutLong = (text: string, start: number, end: number, size: number): Piece[] => {
  const out: Piece[] = [];
  let from = start;
  let tokens = 0;
  let run = 0;
  let lastSpace = -1;
  let at = start;
  const emit = (to: number): void => {
    let first = from;
    while (first < to && SPACE.test(text[first]!)) first += 1;
    let last = to;
    while (last > first && SPACE.test(text[last - 1]!)) last -= 1;
    if (last > first) {
      out.push({
        start: first,
        end: last,
        tokens: estimateTokens(text, first, last),
        paragraph: false,
      });
    }
    from = to;
    tokens = 0;
    run = 0;
    lastSpace = -1;
  };
  while (at < end) {
    const point = text.codePointAt(at)!;
    const width = point > 0xffff ? 2 : 1;
    const kind = kindOf(point);
    let cost = 0;
    if (kind === "word") {
      run += 1;
      if (run % LETTERS_PER_TOKEN === 1) cost = 1;
    } else {
      run = 0;
      if (kind !== "space") cost = 1;
    }
    if (tokens + cost > size && at > from) {
      // a cut at the last space keeps the words whole, else the cut is at this character
      if (lastSpace > from) {
        const to = lastSpace;
        emit(to);
        at = to;
        continue;
      }
      emit(at);
    }
    if (kind === "space") lastSpace = at;
    tokens += cost;
    at += width;
  }
  emit(end);
  return out;
};

/** This function gives the pieces of a text: its sentences, in paragraphs, and the parts of a sentence that is longer than the limit. */
const piecesOf = (text: string, size: number): Piece[] => {
  const pieces: Piece[] = [];
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    let first = true;
    for (const [start, end] of sentencesOf(text, line.index, line.index + line[0].length)) {
      const tokens = estimateTokens(text, start, end);
      const parts =
        tokens <= size
          ? [{ start, end, tokens, paragraph: false }]
          : cutLong(text, start, end, size);
      for (const part of parts) {
        pieces.push({ ...part, paragraph: first });
        first = false;
      }
    }
  }
  return pieces;
};

const positive = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 1)
    throw new RangeError(`${name} must be a number of 1 or more, not ${String(value)}`);
  return Math.floor(value);
};

/**
 * This function cuts a text into chunks for an embedder. A chunk is a window of whole sentences.
 * It ends at the end of a paragraph when the paragraph fills half of the window or more. A
 * sentence that is longer than the window is cut at its spaces. Two chunks next to each other share
 * a few sentences (`overlapTokens`), so a passage at a cut is in one chunk. Each chunk keeps its
 * position in the text, so a hit points at a passage.
 *
 * @beta
 */
export const chunkText = (text: string, options: ChunkOptions): TextChunk[] => {
  const size = positive("maxTokens", options.maxTokens);
  // an overlap of half a chunk or more gives each sentence to many chunks
  const overlap = Math.min(
    Math.floor(size / 2),
    Math.max(0, Math.floor(options.overlapTokens ?? size * CHUNK_LIMITS.overlap)),
  );
  const maxChunks = positive("maxChunks", options.maxChunks ?? CHUNK_LIMITS.maxChunks);
  const pieces = piecesOf(text, size);
  const chunks: TextChunk[] = [];
  let first = 0;
  // the first piece that no earlier chunk holds
  let fresh = 0;
  while (first < pieces.length && chunks.length < maxChunks) {
    let last = first;
    let tokens = pieces[first]!.tokens;
    while (last + 1 < pieces.length && tokens + pieces[last + 1]!.tokens <= size) {
      last += 1;
      tokens += pieces[last]!.tokens;
    }
    // the chunk ends at the last paragraph that keeps it half full, when more text follows
    if (last + 1 < pieces.length && !pieces[last + 1]!.paragraph) {
      let filled = 0;
      let cut = -1;
      for (let at = first; at < last; at += 1) {
        filled += pieces[at]!.tokens;
        if (at >= fresh && pieces[at + 1]!.paragraph && filled * 2 >= size) cut = at;
      }
      if (cut !== -1) last = cut;
    }
    fresh = last + 1;
    const start = pieces[first]!.start;
    const end = pieces[last]!.end;
    chunks.push({ index: chunks.length, start, end, text: text.slice(start, end) });
    if (last + 1 >= pieces.length) break;
    // the next chunk starts with the last sentences of this chunk, to the overlap
    let next = last + 1;
    let shared = 0;
    while (next - 1 > first && shared + pieces[next - 1]!.tokens <= overlap) {
      next -= 1;
      shared += pieces[next]!.tokens;
    }
    if (shared + pieces[last + 1]!.tokens > size) next = last + 1;
    first = next;
  }
  return chunks;
};

/**
 * This function gives the number of tokens of a chunk for an embedder. It is the input limit with a
 * margin for the estimate, and `CHUNK_LIMITS.maxTokens` at most.
 *
 * @beta
 */
export const chunkTokensOf = (embedder: Pick<Embedder, "maxInputTokens">): number => {
  const limit = embedder.maxInputTokens;
  const tokens =
    limit === undefined || !Number.isFinite(limit) || limit < 1
      ? CHUNK_LIMITS.defaultTokens
      : Math.min(limit, CHUNK_LIMITS.maxTokens);
  return Math.max(8, Math.floor(tokens * CHUNK_LIMITS.fill));
};

// ── vectors ─────────────────────────────────────────────────────────────────

/**
 * This function gives a copy of a vector with a length of 1. A vector of zeros stays zeros. A value that is not finite throws a `RangeError`.
 *
 * @beta
 */
export const unitVector = (vector: ArrayLike<number>): Float32Array => {
  const out = Float32Array.from(vector);
  let sum = 0;
  for (const value of out) {
    if (!Number.isFinite(value))
      throw new RangeError("the embedder gave a value that is not finite");
    sum += value * value;
  }
  if (sum === 0) return out;
  const scale = 1 / Math.sqrt(sum);
  for (let at = 0; at < out.length; at += 1) out[at] = out[at]! * scale;
  return out;
};

// ── fusion ──────────────────────────────────────────────────────────────────

/** These are the defaults of a hybrid search. */
export const HYBRID_DEFAULTS: {
  /** The full-text search gives this number of candidates. Each candidate gets vectors when it has none. */
  readonly candidates: number;
  /** The vector search gives this number of documents: the documents with the closest chunks. */
  readonly neighbors: number;
  /** This value is the constant k of reciprocal rank fusion. A larger k gives less weight to the top of each list. */
  readonly fusionK: number;
} = { candidates: 50, neighbors: 50, fusionK: 60 };

/**
 * This is one item of a fused list.
 *
 * @beta
 */
export interface FusedRank {
  readonly id: string;
  /** This value is the sum of 1 / (k + rank) over the lists that hold the item. */
  readonly score: number;
  /** These values are the rank of the item in each list, from 1, or null when a list does not hold it. */
  readonly ranks: ReadonlyArray<number | null>;
}

/**
 * This function fuses ranked lists with reciprocal rank fusion. Each item gets the sum of
 * 1 / (k + rank) over the lists that hold it, with the rank from 1. The best item is first. A tie goes to
 * the item with the best rank in a list, then to the earlier list, then to the smaller id. An item
 * that is two times in one list counts at its first place.
 *
 * @beta
 */
export const fuseRanks = (
  lists: ReadonlyArray<readonly string[]>,
  k: number = HYBRID_DEFAULTS.fusionK,
): FusedRank[] => {
  if (!Number.isFinite(k) || k < 0)
    throw new RangeError(`the fusion constant k must be a number of 0 or more, not ${String(k)}`);
  const ranks = new Map<string, Array<number | null>>();
  lists.forEach((list, which) => {
    list.forEach((id, at) => {
      let entry = ranks.get(id);
      if (entry === undefined) {
        entry = lists.map(() => null);
        ranks.set(id, entry);
      }
      entry[which] ??= at + 1;
    });
  });
  // the keys of the sort come first, one time for each item: a long list sorts fast
  const keyed = [...ranks].map(([id, entry]) => {
    let score = 0;
    let best = Number.POSITIVE_INFINITY;
    for (const rank of entry) {
      if (rank === null) continue;
      score += 1 / (k + rank);
      best = Math.min(best, rank);
    }
    return { id, score, ranks: entry, best, first: entry.findIndex((rank) => rank !== null) };
  });
  keyed.sort(
    (a, b) =>
      b.score - a.score ||
      a.best - b.best ||
      a.first - b.first ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return keyed.map(({ id, score, ranks: entry }) => ({ id, score, ranks: entry }));
};
