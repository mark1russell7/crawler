/**
 * A small client of the deposit API of Zenodo (https://developers.zenodo.org). It makes a draft record
 * with a reserved DOI, puts the files of the dataset in it, and publishes it only when the caller
 * asks. The workflow `.github/workflows/study-zenodo.yml` uses it, and a test uses it with a local
 * server. It needs Node.js.
 */
import { createHash } from "node:crypto";
import type { DatasetFile, ZenodoMetadata } from "./dataset.ts";

/** These addresses are the APIs of Zenodo and of its sandbox, which is for tests. */
export const ZENODO_API = "https://zenodo.org/api";
export const ZENODO_SANDBOX_API = "https://sandbox.zenodo.org/api";

/** The options of `deposit`. */
export interface DepositOptions {
  /** This address is the API, for example `https://zenodo.org/api`, with no `/` at the end. */
  readonly api: string;
  /** This text is a personal access token with the scopes `deposit:write` and `deposit:actions`. */
  readonly token: string;
  readonly metadata: ZenodoMetadata;
  /** This function gives the files, when the DOI is known. A file can thus name its own DOI. */
  readonly files: (doi: string) => readonly DatasetFile[];
  /** This value is the id of a published record. The deposit is then a new version of that record. */
  readonly newVersionOf?: string | undefined;
  /** This value is true to publish the record. The default is false: the record stays a draft. */
  readonly publish?: boolean | undefined;
  /** This function sends the requests. The default is the `fetch` of Node.js. */
  readonly fetch?: typeof fetch | undefined;
}

/** The result of `deposit`. */
export interface DepositResult {
  readonly id: number;
  readonly doi: string;
  /** This address is the page of the draft on Zenodo, or of the record when it is published. */
  readonly url: string;
  readonly published: boolean;
  readonly files: ReadonlyArray<{
    readonly name: string;
    readonly size: number;
    readonly md5: string;
  }>;
  /** This value is the last answer of the API: the deposition. */
  readonly deposition: Deposition;
}

/** The part of a deposition of the API that the client reads. */
export interface Deposition {
  readonly id: number;
  readonly submitted?: boolean;
  readonly metadata?: { readonly prereserve_doi?: { readonly doi?: string } };
  readonly links?: Readonly<Record<string, string | undefined>>;
  readonly files?: ReadonlyArray<{
    readonly id: string;
    readonly links?: Readonly<Record<string, string | undefined>>;
  }>;
}

/** An error of the API, with the method, the path and the status. */
export class ZenodoError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ZenodoError";
    this.status = status;
  }
}

const md5Of = (bytes: Uint8Array): string => createHash("md5").update(bytes).digest("hex");

/**
 * This function makes a draft record on Zenodo and gives its DOI and its address. These are the steps:
 *
 * 1. It makes a new draft, or a new version of the record `newVersionOf`. A new version starts with
 *    the files of the old version, so the function removes them.
 * 2. It sets the metadata with `prereserve_doi`, so Zenodo reserves the DOI of the record.
 * 3. It puts each file in the bucket of the draft, and compares the MD5 checksum of Zenodo.
 * 4. It publishes the record only when `publish` is true.
 *
 * The function sends the token only to the origin of `api`. It fails when Zenodo gives no DOI, before
 * it puts a file in the draft.
 */
export const deposit = async (options: DepositOptions): Promise<DepositResult> => {
  const send = options.fetch ?? fetch;
  const api = options.api.replace(/\/+$/, "");
  const origin = new URL(api).origin;
  const call = async (
    method: string,
    url: string,
    body?: { readonly bytes: Uint8Array | string; readonly type: string },
  ): Promise<unknown> => {
    const target = new URL(url);
    // the token goes only to the API: a link to a different origin is an error
    if (target.origin !== origin)
      throw new ZenodoError(`${method} ${url}: a link of Zenodo goes to a different origin`, 0);
    const response = await send(target, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": body.type }),
      },
      // a copy of the bytes has its own ArrayBuffer, which the type of a body asks for
      ...(body === undefined
        ? {}
        : { body: typeof body.bytes === "string" ? body.bytes : new Uint8Array(body.bytes) }),
    });
    const text = await response.text();
    if (!response.ok)
      throw new ZenodoError(
        `${method} ${target.pathname}: ${String(response.status)} ${text.slice(0, 500)}`,
        response.status,
      );
    return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  };
  const json = (value: unknown) => ({ bytes: JSON.stringify(value), type: "application/json" });
  const depositions = `${api}/deposit/depositions`;

  let draft: Deposition;
  if (options.newVersionOf !== undefined) {
    if (!/^\d+$/.test(options.newVersionOf))
      throw new Error(`the record id is not a number: ${options.newVersionOf}`);
    // the answer is the old record, and its link latest_draft is the new version
    const old = (await call(
      "POST",
      `${depositions}/${options.newVersionOf}/actions/newversion`,
    )) as Deposition;
    const latest = old.links?.["latest_draft"];
    if (latest === undefined) throw new ZenodoError("the new version has no link latest_draft", 0);
    draft = (await call("GET", latest)) as Deposition;
    for (const file of draft.files ?? [])
      await call(
        "DELETE",
        file.links?.["self"] ?? `${depositions}/${String(draft.id)}/files/${file.id}`,
      );
  } else {
    draft = (await call("POST", depositions, json({}))) as Deposition;
  }

  draft = (await call(
    "PUT",
    `${depositions}/${String(draft.id)}`,
    json({ metadata: { ...options.metadata, prereserve_doi: true } }),
  )) as Deposition;
  const doi = draft.metadata?.prereserve_doi?.doi;
  if (doi === undefined || doi.length === 0)
    throw new ZenodoError("Zenodo reserved no DOI for the draft", 0);

  const bucket = draft.links?.["bucket"];
  if (bucket === undefined) throw new ZenodoError("the draft has no link bucket", 0);
  const files: Array<{ name: string; size: number; md5: string }> = [];
  for (const file of options.files(doi)) {
    const md5 = md5Of(file.bytes);
    const stored = (await call("PUT", `${bucket}/${encodeURIComponent(file.name)}`, {
      bytes: file.bytes,
      type: "application/octet-stream",
    })) as { readonly checksum?: string } | undefined;
    if (stored?.checksum !== undefined && stored.checksum !== `md5:${md5}`)
      throw new ZenodoError(
        `${file.name}: Zenodo has the checksum ${stored.checksum}, not md5:${md5}`,
        0,
      );
    files.push({ name: file.name, size: file.bytes.byteLength, md5 });
  }

  const published = options.publish === true;
  if (published)
    draft = (await call(
      "POST",
      `${depositions}/${String(draft.id)}/actions/publish`,
    )) as Deposition;
  const site = new URL(api).origin;
  const url = published
    ? (draft.links?.["record_html"] ??
      draft.links?.["html"] ??
      `${site}/records/${String(draft.id)}`)
    : (draft.links?.["html"] ?? `${site}/uploads/${String(draft.id)}`);
  return { id: draft.id, doi, url, published, files, deposition: draft };
};
