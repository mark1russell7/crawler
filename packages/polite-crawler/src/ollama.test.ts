import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NO_OLLAMA, OLLAMA_MODELS, isLoopback, ollamaEmbedder } from "./ollama.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Request {
  readonly method: string;
  readonly path: string;
  readonly body: { model?: string; input?: string[]; truncate?: boolean };
}

type Handler = (request: Request, response: ServerResponse) => void;

/** This function starts a mock Ollama server on a loopback port. The handler answers each request. */
const ollama = async (
  handler?: Handler,
): Promise<{ readonly url: string; readonly requests: Request[]; readonly server: Server }> => {
  const requests: Request[] = [];
  const answer: Handler =
    handler ??
    ((request, response) => {
      const input = request.body.input ?? [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: request.body.model,
          embeddings: input.map((text) => [text.length, 1, 0]),
        }),
      );
    });
  const server = createServer((message: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    message.on("data", (chunk: Buffer) => chunks.push(chunk));
    message.on("end", () => {
      let body: Request["body"] = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request["body"];
      } catch {
        // a test can send no JSON
      }
      const request = { method: message.method ?? "", path: message.url ?? "", body };
      requests.push(request);
      answer(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, requests, server };
};

const errorOf = async (work: Promise<unknown>): Promise<Error> => {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the work did not fail");
};

describe("ollamaEmbedder", () => {
  it("posts batches to /api/embed with the prefixes of the model", async () => {
    const server = await ollama();
    expect(ollamaEmbedder().dimensions).toBe(768);
    const embedder = ollamaEmbedder({ baseUrl: server.url, batch: 2, dimensions: 3 });
    expect(embedder.id).toBe("ollama:nomic-embed-text");
    expect(embedder.dimensions).toBe(3);
    expect(embedder.maxInputTokens).toBe(8192);
    const vectors = await embedder.embed(["a", "bb", "ccc"], {});
    expect(vectors.map((vector) => [...vector])).toEqual([
      [18, 1, 0],
      [19, 1, 0],
      [20, 1, 0],
    ]);
    expect(server.requests.map((request) => [request.method, request.path])).toEqual([
      ["POST", "/api/embed"],
      ["POST", "/api/embed"],
    ]);
    expect(server.requests[0]!.body).toEqual({
      model: "nomic-embed-text",
      input: ["search_document: a", "search_document: bb"],
      truncate: true,
    });
    await embedder.embed(["q"], { purpose: "query" });
    expect(server.requests.at(-1)!.body.input).toEqual(["search_query: q"]);
    expect(await embedder.embed([], {})).toEqual([]);
  });

  it("learns the dimensions of a model that it does not know, and checks them", async () => {
    let width = 3;
    const server = await ollama((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          embeddings: (request.body.input ?? []).map(() =>
            Array.from({ length: width }, () => 0.5),
          ),
        }),
      );
    });
    const embedder = ollamaEmbedder({ baseUrl: `${server.url}/`, model: "my-embedder:v2" });
    expect(embedder.dimensions).toBe(0);
    expect(embedder.maxInputTokens).toBe(256);
    await embedder.embed(["x"], { purpose: "query" });
    expect(embedder.dimensions).toBe(3);
    expect(server.requests[0]!.body.input).toEqual(["x"]);
    width = 4;
    expect((await errorOf(embedder.embed(["y"], {}))).message).toMatch(
      /gave a vector of 4 dimensions, not 3/,
    );
    expect(OLLAMA_MODELS["all-minilm"]).toEqual({ dimensions: 384, maxInputTokens: 256 });
    expect(ollamaEmbedder({ model: "all-minilm:l6-v2" }).dimensions).toBe(384);
    expect(ollamaEmbedder({ documentPrefix: "passage: " }).id).toMatch(
      /^ollama:nomic-embed-text#[0-9a-f]{8}$/,
    );
    expect(ollamaEmbedder({ documentPrefix: "search_document: " }).id).toBe(
      "ollama:nomic-embed-text",
    );
  });

  it("says ollama pull when the model is not there", async () => {
    const server = await ollama((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: 'model "nomic-embed-text" not found, try pulling it first' }),
      );
    });
    const error = await errorOf(ollamaEmbedder({ baseUrl: server.url }).embed(["x"], {}));
    expect(error.message).toMatch(
      /^the model nomic-embed-text is not in Ollama: ollama pull nomic-embed-text/,
    );
  });

  it("says ollama serve when no server answers", async () => {
    const server = await ollama();
    const url = server.url;
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
    const error = await errorOf(ollamaEmbedder({ baseUrl: url }).embed(["x"], {}));
    expect(error.message).toContain(NO_OLLAMA);
    expect(error.message).toMatch(/ollama serve/);
    expect(error.message).toMatch(/ECONNREFUSED/);
    // fetch refuses port 9 with no network code: the error names the cause
    const refused = await errorOf(
      ollamaEmbedder({ baseUrl: "http://127.0.0.1:9" }).embed(["x"], {}),
    );
    expect(refused.message).toMatch(
      /^the request to Ollama at http:\/\/127\.0\.0\.1:9 failed: .+ \(.+\)$/,
    );
  });

  it("names an old Ollama, a model that does not embed, and the other errors", async () => {
    let status = 404;
    let body = "404 page not found";
    const server = await ollama((_request, response) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(body);
    });
    const embedder = ollamaEmbedder({ baseUrl: server.url, model: "llama3" });
    expect((await errorOf(embedder.embed(["x"], {}))).message).toMatch(
      /has no \/api\/embed: update Ollama to version 0\.3\.0 or later/,
    );
    status = 400;
    body = JSON.stringify({ error: '"llama3" does not support embeddings' });
    expect((await errorOf(embedder.embed(["x"], {}))).message).toMatch(
      /the model llama3 does not make embeddings: use an embedding model/,
    );
    status = 500;
    body = JSON.stringify({ error: "out of memory" });
    expect((await errorOf(embedder.embed(["x"], {}))).message).toBe(
      "Ollama answered 500: out of memory",
    );
    body = "{}";
    expect((await errorOf(embedder.embed(["x"], {}))).message).toBe("Ollama answered 500");
    status = 200;
    body = JSON.stringify({ embeddings: [] });
    expect((await errorOf(embedder.embed(["x"], {}))).message).toMatch(
      /Ollama gave no embedding for each text/,
    );
    body = "not json";
    expect((await errorOf(embedder.embed(["x"], {}))).message).toMatch(
      /Ollama gave no embedding for each text/,
    );
  });

  it("stops at the signal, and at its timeout", async () => {
    const server = await ollama(() => {
      // no answer: the request waits
    });
    const embedder = ollamaEmbedder({ baseUrl: server.url, timeoutMs: 200 });
    const controller = new AbortController();
    const work = embedder.embed(["x"], { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("the user stopped it")), 20);
    expect((await errorOf(work)).message).toBe("the user stopped it");
    const before = new AbortController();
    before.abort(new Error("stopped before"));
    expect((await errorOf(embedder.embed(["x"], { signal: before.signal }))).message).toBe(
      "stopped before",
    );
    expect((await errorOf(embedder.embed(["x"], {}))).message).toMatch(/did not answer in 200 ms/);
  });

  it("sends text only to this computer, unless allowRemote is true", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]", "api.localhost"])
      expect(isLoopback(host)).toBe(true);
    for (const host of ["10.0.0.5", "example.com", "128.0.0.1", "[::2]"])
      expect(isLoopback(host)).toBe(false);
    expect(() => ollamaEmbedder({ baseUrl: "http://10.0.0.5:11434" })).toThrow(
      /is not on this computer.*allowRemote: true/,
    );
    expect(ollamaEmbedder({ baseUrl: "http://10.0.0.5:11434", allowRemote: true }).id).toBe(
      "ollama:nomic-embed-text",
    );
    expect(() => ollamaEmbedder({ baseUrl: "ftp://127.0.0.1" })).toThrow(/http or https/);
    expect(() => ollamaEmbedder({ baseUrl: "not a url" })).toThrow(/is not a URL/);
    expect(() => ollamaEmbedder({ baseUrl: "http://user:secret@127.0.0.1" })).toThrow(
      /user name or a password/,
    );
    expect(() => ollamaEmbedder({ model: " " })).toThrow(RangeError);
  });
});
