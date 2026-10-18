import { afterEach, describe, expect, it } from "vitest";
import { removeDir, tempDir } from "./test-helpers.ts";
import type { FeatureExtractor, TransformersModule } from "./transformers.ts";
import { NO_TRANSFORMERS, TRANSFORMERS_MODELS, transformersEmbedder } from "./transformers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Loaded {
  readonly model: string;
  readonly options: Parameters<TransformersModule["pipeline"]>[2];
}

/** This function gives a mock of the module: a pipeline that gives a vector of the length of each text. */
const mockModule = (
  width = 3,
): {
  readonly load: () => Promise<TransformersModule>;
  readonly loads: Loaded[];
  readonly calls: Array<{ texts: string[]; pooling: string; normalize: boolean }>;
  readonly disposed: { count: number };
  shape: ((texts: string[]) => readonly number[]) | undefined;
} => {
  const loads: Loaded[] = [];
  const calls: Array<{ texts: string[]; pooling: string; normalize: boolean }> = [];
  const disposed = { count: 0 };
  const mock = {
    loads,
    calls,
    disposed,
    shape: undefined as ((texts: string[]) => readonly number[]) | undefined,
    load: (): Promise<TransformersModule> =>
      Promise.resolve({
        pipeline: (_task, model, options) => {
          loads.push({ model, options });
          const run = ((texts: string[], call: { pooling: string; normalize: boolean }) => {
            calls.push({ texts, ...call });
            const data = new Float32Array(texts.length * width);
            texts.forEach((text, row) => {
              data[row * width] = text.length;
              data[row * width + 1] = row;
            });
            return Promise.resolve({ data, dims: mock.shape?.(texts) ?? [texts.length, width] });
          }) as FeatureExtractor;
          run.dispose = () => {
            disposed.count += 1;
            return Promise.resolve();
          };
          return Promise.resolve(run);
        },
      }),
  };
  return mock;
};

describe("transformersEmbedder with a mock of transformers.js", () => {
  it("loads the q8 model one time, with the pooling of the model and normalized vectors", async () => {
    const mock = mockModule(384);
    const embedder = transformersEmbedder({ cacheDir: "/tmp/models", batch: 2 }, mock.load);
    expect(embedder.id).toBe("transformers:Xenova/bge-small-en-v1.5:q8:cls");
    expect(embedder.dimensions).toBe(384);
    expect(embedder.maxInputTokens).toBe(512);
    expect(mock.loads).toEqual([]);
    const vectors = await embedder.embed(["a", "bb", "ccc"], {});
    expect(mock.loads).toEqual([
      {
        model: "Xenova/bge-small-en-v1.5",
        options: { dtype: "q8", cache_dir: "/tmp/models" },
      },
    ]);
    expect(mock.calls).toEqual([
      { texts: ["a", "bb"], pooling: "cls", normalize: true },
      { texts: ["ccc"], pooling: "cls", normalize: true },
    ]);
    expect(vectors.map((vector) => vector.length)).toEqual([384, 384, 384]);
  });

  it("gives one vector for each text, and adds the prefix of a question", async () => {
    const mock = mockModule();
    const embedder = transformersEmbedder(
      { model: "Xenova/all-MiniLM-L6-v2", quantized: false, localOnly: true, dimensions: 3 },
      mock.load,
    );
    expect(embedder.id).toBe("transformers:Xenova/all-MiniLM-L6-v2:fp32:mean");
    const vectors = await embedder.embed(["one", "three"], { purpose: "document" });
    expect(vectors.map((vector) => [...vector])).toEqual([
      [3, 0, 0],
      [5, 1, 0],
    ]);
    await embedder.embed(["q"], { purpose: "query" });
    expect(mock.calls.map((call) => [call.texts, call.pooling])).toEqual([
      [["one", "three"], "mean"],
      [["q"], "mean"],
    ]);
    expect(mock.loads[0]!.options).toEqual({ dtype: "fp32", local_files_only: true });
    const bge = transformersEmbedder({ dimensions: 3 }, mockModule().load);
    await bge.embed(["what is rye"], { purpose: "query" });
    expect(await bge.embed([], {})).toEqual([]);
    expect(TRANSFORMERS_MODELS["Xenova/bge-small-en-v1.5"]!.queryPrefix).toMatch(/^Represent/);
  });

  it("learns the dimensions of a model that it does not know, and checks the shape", async () => {
    const mock = mockModule(5);
    const embedder = transformersEmbedder(
      { model: "someone/model", documentPrefix: "passage: " },
      mock.load,
    );
    expect(embedder.dimensions).toBe(0);
    expect(embedder.maxInputTokens).toBe(256);
    expect(embedder.id).toMatch(/^transformers:someone\/model:q8:mean#[0-9a-f]{8}$/);
    await embedder.embed(["x"], {});
    expect(embedder.dimensions).toBe(5);
    expect(mock.calls[0]!.texts).toEqual(["passage: x"]);
    mock.shape = () => [1, 7];
    await expect(embedder.embed(["x"], {})).rejects.toThrow(/7 dimensions, not 5/);
    mock.shape = () => [2, 5];
    await expect(embedder.embed(["x"], {})).rejects.toThrow(/shape \[2, 5\]/);
    mock.shape = () => [1, 0];
    await expect(embedder.embed(["x"], {})).rejects.toThrow(/shape/);
    expect(() => transformersEmbedder({ model: "" })).toThrow(RangeError);
    expect(() => transformersEmbedder({ pooling: "max" as never })).toThrow(/pooling/);
  });

  it("says how to install transformers.js when it is missing, and tries again later", async () => {
    let installed = false;
    const mock = mockModule();
    const embedder = transformersEmbedder({ dimensions: 3 }, () =>
      installed ? mock.load() : Promise.reject(new Error("Cannot find package")),
    );
    const error = await embedder.embed(["x"], {}).then(
      () => undefined,
      (failure: unknown) => failure as Error,
    );
    expect(error?.message).toBe(NO_TRANSFORMERS);
    expect(error?.message).toMatch(/npm install @huggingface\/transformers/);
    expect((error!.cause as Error).message).toBe("Cannot find package");
    installed = true;
    expect(await embedder.embed(["x"], {})).toHaveLength(1);
  });

  it("stops at the signal, and releases the model at close", async () => {
    const mock = mockModule();
    const embedder = transformersEmbedder({ dimensions: 3, batch: 1 }, mock.load);
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(embedder.embed(["x"], { signal: controller.signal })).rejects.toThrow("stopped");
    await embedder.close?.();
    expect(mock.disposed.count).toBe(0);
    await embedder.embed(["x"], {});
    await embedder.close?.();
    expect(mock.disposed.count).toBe(1);
    // a close does not stop a later use: the model loads again
    await embedder.embed(["x"], {});
    expect(mock.loads).toHaveLength(2);
    const failing = transformersEmbedder({ dimensions: 3 }, () => Promise.reject(new Error("no")));
    await expect(failing.embed(["x"], {})).rejects.toThrow(NO_TRANSFORMERS);
    await failing.close?.();
  });
});

// The one test with a real model. It runs only in CI, because the first use downloads the model
// (about 23 MB) from the Hugging Face Hub.
describe("transformersEmbedder with a real model (CI)", () => {
  it.skipIf(process.env["CI"] === undefined)(
    "loads Xenova/all-MiniLM-L6-v2, and similar sentences are closer",
    async () => {
      const cacheDir = await tempDir("models");
      cleanups.push(() => removeDir(cacheDir));
      const embedder = transformersEmbedder({ model: "Xenova/all-MiniLM-L6-v2", cacheDir });
      cleanups.push(() => embedder.close?.());
      const [cat, kitten, market] = await embedder.embed(
        [
          "The cat sits on the mat.",
          "A kitten is resting on a rug.",
          "The stock market fell sharply today.",
        ],
        {},
      );
      expect(embedder.dimensions).toBe(384);
      for (const vector of [cat, kitten, market]) {
        expect(vector).toHaveLength(384);
        expect(Math.hypot(...vector!)).toBeCloseTo(1, 3);
      }
      const cosine = (a: Float32Array, b: Float32Array): number =>
        a.reduce((sum, value, at) => sum + value * b[at]!, 0);
      expect(cosine(cat!, kitten!)).toBeGreaterThan(cosine(cat!, market!) + 0.1);
    },
    180_000,
  );
});
