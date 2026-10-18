import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { DatasetFile } from "./dataset.ts";
import { datasetFiles, zenodoMetadata } from "./dataset.ts";
import type { Study } from "./study.ts";
import { ZENODO_USER_AGENT, ZenodoError, deposit } from "./zenodo.ts";

// A local copy of the deposit API of Zenodo. No test sends a request to Zenodo.

const site = new URL("../../", import.meta.url);
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(new URL(path, site)));
const input = {
  json: read("src/data/robots-study.json"),
  csv: read("public/data/robots-study.csv"),
  page: readFileSync(new URL("src/content/docs/notes/robots-txt-ai-agents.mdx", site), "utf8"),
};
const study = JSON.parse(new TextDecoder().decode(input.json)) as Study;
const TOKEN = "test-token-1234";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly auth: string | undefined;
  readonly agent: string | undefined;
  readonly type: string | undefined;
  readonly body: Buffer;
}

interface Behavior {
  /** The PUT of the metadata gives no reserved DOI. */
  readonly noDoi?: boolean;
  /** The first request fails with this status. */
  readonly failWith?: number;
  /** The bucket link goes to this origin. */
  readonly bucketOrigin?: string;
  /** The upload gives a wrong checksum. */
  readonly badChecksum?: boolean;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const bodyOf = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const zenodo = async (behavior: Behavior = {}) => {
  const calls: Call[] = [];
  let origin = "";
  const links = (id: number) => ({
    self: `${origin}/api/deposit/depositions/${String(id)}`,
    html: `${origin}/deposit/${String(id)}`,
    bucket: `${behavior.bucketOrigin ?? origin}/api/files/bucket-${String(id)}`,
    publish: `${origin}/api/deposit/depositions/${String(id)}/actions/publish`,
  });
  const send = (response: ServerResponse, status: number, value?: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(value === undefined ? "" : JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    void bodyOf(request).then((body) => {
      const method = request.method ?? "";
      const path = request.url ?? "";
      calls.push({
        method,
        path,
        auth: request.headers.authorization,
        agent: request.headers["user-agent"],
        type: request.headers["content-type"],
        body,
      });
      if (behavior.failWith !== undefined && calls.length === 1) {
        send(response, behavior.failWith, { status: behavior.failWith, message: "Bad request" });
        return;
      }
      const deposition = /^\/api\/deposit\/depositions\/(\d+)$/.exec(path);
      const file = /^\/api\/files\/bucket-(\d+)\/(.+)$/.exec(path);
      if (method === "POST" && path === "/api/deposit/depositions")
        send(response, 201, { id: 101, links: links(101), metadata: {}, files: [] });
      else if (method === "POST" && path === "/api/deposit/depositions/77/actions/newversion")
        send(response, 201, {
          id: 77,
          links: { ...links(77), latest_draft: `${origin}/api/deposit/depositions/202` },
        });
      else if (method === "GET" && path === "/api/deposit/depositions/202")
        send(response, 200, {
          id: 202,
          links: links(202),
          files: ["f1", "f2"].map((id) => ({
            id,
            links: { self: `${origin}/api/deposit/depositions/202/files/${id}` },
          })),
        });
      else if (method === "DELETE" && /^\/api\/deposit\/depositions\/202\/files\/f\d$/.test(path))
        send(response, 204);
      else if (method === "PUT" && deposition !== null) {
        const id = Number(deposition[1]);
        const sent = JSON.parse(body.toString("utf8")) as { metadata: Record<string, unknown> };
        send(response, 200, {
          id,
          links: links(id),
          metadata: {
            ...sent.metadata,
            ...(behavior.noDoi === true
              ? {}
              : { prereserve_doi: { doi: `10.5072/zenodo.${String(id)}`, recid: id } }),
          },
        });
      } else if (method === "PUT" && file !== null)
        send(response, 201, {
          key: decodeURIComponent(file[2]!),
          size: body.byteLength,
          checksum: `md5:${behavior.badChecksum === true ? "0".repeat(32) : createHash("md5").update(body).digest("hex")}`,
        });
      else if (
        method === "POST" &&
        /^\/api\/deposit\/depositions\/\d+\/actions\/publish$/.test(path)
      ) {
        const id = Number(/(\d+)/.exec(path)![1]);
        send(response, 202, {
          id,
          submitted: true,
          doi: `10.5072/zenodo.${String(id)}`,
          links: { ...links(id), record_html: `${origin}/records/${String(id)}` },
          metadata: { prereserve_doi: { doi: `10.5072/zenodo.${String(id)}`, recid: id } },
        });
      } else send(response, 404, { status: 404, message: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { api: `${origin}/api`, origin, calls };
};

/** The files of the dataset for a DOI, and the DOIs that the function got. */
const filesFor = () => {
  const dois: string[] = [];
  let last: readonly DatasetFile[] = [];
  return {
    dois,
    last: () => last,
    files: (doi: string): readonly DatasetFile[] => {
      dois.push(doi);
      last = datasetFiles({ ...input, doi });
      return last;
    },
  };
};

const route = (calls: readonly Call[]): string[] =>
  calls.map((call) => `${call.method} ${call.path}`);

describe("the Zenodo client", () => {
  it("makes a draft with a reserved DOI, puts the files in it, and publishes nothing by default", async () => {
    const server = await zenodo();
    const built = filesFor();
    const result = await deposit({
      api: server.api,
      token: TOKEN,
      metadata: zenodoMetadata(study),
      files: built.files,
    });
    expect(route(server.calls)).toEqual([
      "POST /api/deposit/depositions",
      "PUT /api/deposit/depositions/101",
      "PUT /api/files/bucket-101/CITATION.cff",
      "PUT /api/files/bucket-101/README.md",
      "PUT /api/files/bucket-101/robots-study.csv",
      "PUT /api/files/bucket-101/robots-study.json",
    ]);
    for (const call of server.calls) expect(call.auth).toBe(`Bearer ${TOKEN}`);
    // Zenodo refuses the default User-Agent of Node.js, so each request names the study
    for (const call of server.calls) expect(call.agent).toBe(ZENODO_USER_AGENT);
    // the metadata asks Zenodo to reserve the DOI
    const put = JSON.parse(server.calls[1]!.body.toString("utf8")) as {
      metadata: Record<string, unknown>;
    };
    expect(server.calls[1]!.type).toBe("application/json");
    expect(put.metadata).toMatchObject({
      upload_type: "dataset",
      title: "Robots.txt rules for AI crawlers on popular sites",
      creators: [{ name: "Russell, Mark" }],
      license: "cc-by-4.0",
      access_right: "open",
      version: study.fetched.from.slice(0, 10),
      publication_date: study.fetched.from.slice(0, 10),
      prereserve_doi: true,
      related_identifiers: [
        {
          identifier: "https://mark1russell7.github.io/crawler/notes/robots-txt-ai-agents/",
          relation: "isSupplementTo",
        },
        { identifier: "https://github.com/mark1russell7/crawler", relation: "isSupplementTo" },
      ],
    });
    // the files know the DOI, and Zenodo gets their bytes as they are
    expect(built.dois).toEqual(["10.5072/zenodo.101"]);
    built.last().forEach((file, index) => {
      const call = server.calls[index + 2]!;
      expect(call.type).toBe("application/octet-stream");
      expect(new Uint8Array(call.body)).toEqual(new Uint8Array(file.bytes));
    });
    expect(new TextDecoder().decode(built.last()[0]!.bytes)).toContain('doi: "10.5072/zenodo.101"');
    expect(result).toMatchObject({
      id: 101,
      doi: "10.5072/zenodo.101",
      url: `${server.origin}/deposit/101`,
      published: false,
    });
    expect(result.files.map((file) => file.name)).toEqual([
      "CITATION.cff",
      "README.md",
      "robots-study.csv",
      "robots-study.json",
    ]);
  });

  it("publishes the record only when it is asked to", async () => {
    const server = await zenodo();
    const result = await deposit({
      api: server.api,
      token: TOKEN,
      metadata: zenodoMetadata(study),
      files: filesFor().files,
      publish: true,
    });
    expect(route(server.calls).at(-1)).toBe("POST /api/deposit/depositions/101/actions/publish");
    expect(result).toMatchObject({ published: true, url: `${server.origin}/records/101` });
  });

  it("makes a new version of a record, without the files of the old version", async () => {
    const server = await zenodo();
    const built = filesFor();
    const result = await deposit({
      api: server.api,
      token: TOKEN,
      metadata: zenodoMetadata(study),
      files: built.files,
      newVersionOf: "77",
    });
    expect(route(server.calls)).toEqual([
      "POST /api/deposit/depositions/77/actions/newversion",
      "GET /api/deposit/depositions/202",
      "DELETE /api/deposit/depositions/202/files/f1",
      "DELETE /api/deposit/depositions/202/files/f2",
      "PUT /api/deposit/depositions/202",
      "PUT /api/files/bucket-202/CITATION.cff",
      "PUT /api/files/bucket-202/README.md",
      "PUT /api/files/bucket-202/robots-study.csv",
      "PUT /api/files/bucket-202/robots-study.json",
    ]);
    expect(built.dois).toEqual(["10.5072/zenodo.202"]);
    expect(result).toMatchObject({ id: 202, doi: "10.5072/zenodo.202", published: false });
    await expect(
      deposit({
        api: server.api,
        token: TOKEN,
        metadata: zenodoMetadata(study),
        files: built.files,
        newVersionOf: "77/../1",
      }),
    ).rejects.toThrow(/not a number/);
  });

  it("puts no file in a draft that has no reserved DOI", async () => {
    const server = await zenodo({ noDoi: true });
    const built = filesFor();
    await expect(
      deposit({
        api: server.api,
        token: TOKEN,
        metadata: zenodoMetadata(study),
        files: built.files,
      }),
    ).rejects.toThrow(/reserved no DOI/);
    expect(route(server.calls)).toEqual([
      "POST /api/deposit/depositions",
      "PUT /api/deposit/depositions/101",
    ]);
    expect(built.dois).toEqual([]);
  });

  it("stops at an error of the API, and names the status but not the token", async () => {
    const server = await zenodo({ failWith: 403 });
    const error = await deposit({
      api: server.api,
      token: TOKEN,
      metadata: zenodoMetadata(study),
      files: filesFor().files,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ZenodoError);
    expect((error as ZenodoError).status).toBe(403);
    expect((error as Error).message).toMatch(/^POST \/api\/deposit\/depositions: 403 /);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(server.calls).toHaveLength(1);
  });

  it("sends the token to no other origin, and compares the checksum of each file", async () => {
    const elsewhere = await zenodo({ bucketOrigin: "http://elsewhere.invalid" });
    await expect(
      deposit({
        api: elsewhere.api,
        token: TOKEN,
        metadata: zenodoMetadata(study),
        files: filesFor().files,
      }),
    ).rejects.toThrow(/different origin/);
    expect(route(elsewhere.calls)).toEqual([
      "POST /api/deposit/depositions",
      "PUT /api/deposit/depositions/101",
    ]);
    const wrong = await zenodo({ badChecksum: true });
    await expect(
      deposit({
        api: wrong.api,
        token: TOKEN,
        metadata: zenodoMetadata(study),
        files: filesFor().files,
        publish: true,
      }),
    ).rejects.toThrow(/CITATION.cff: Zenodo has the checksum md5:0+, not md5:/);
    // a wrong checksum stops before the publish
    expect(route(wrong.calls).some((call) => call.endsWith("/actions/publish"))).toBe(false);
  });
});
