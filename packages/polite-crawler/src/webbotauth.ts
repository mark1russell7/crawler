import type { JsonWebKeyInput, KeyObject } from "node:crypto";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

/**
 * Signed requests: HTTP Message Signatures (RFC 9421), as the IETF Web Bot Auth profile tells
 * (`draft-ietf-webbotauth-httpsig-protocol-00`, 1 September 2026). A signature lets a site verify that
 * a request comes from the holder of a key that the operator publishes.
 *
 * - Each request gets three headers: `Signature-Agent`, `Signature-Input` and `Signature`.
 * - `Signature-Agent` is a dictionary. Its member names the key directory of the operator.
 * - The signature covers `@authority` and that member of `Signature-Agent`.
 * - The parameters are `created`, `keyid` (the JWK thumbprint of the key), `alg="ed25519"`,
 *   `expires`, a random `nonce` and `tag="web-bot-auth"`.
 * - The key is an Ed25519 key, and `node:crypto` signs. The package adds no dependency.
 *
 * A signature adds an identity. It does not replace the `User-Agent` header, which stays honest.
 */

/** The path of the key directory on the host of the operator (the well-known URI of the draft). */
export const KEY_DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/** The media type of the key directory. The host of the directory sends it as `Content-Type`. */
export const KEY_DIRECTORY_TYPE = "application/http-message-signatures-directory+json";

/** The value of the `tag` parameter of a Web Bot Auth signature. */
export const WEB_BOT_AUTH_TAG = "web-bot-auth";

/**
 * This value tells how a site finds the keys from the URL of `Signature-Agent`:
 *
 * - `directory` (the default): the URL is an origin, and the keys are at `KEY_DIRECTORY_PATH` on it.
 * - `jwks_uri`: the URL is the address of a JSON Web Key Set, on any path.
 */
export type SignatureAgentType = "directory" | "jwks_uri";

/** A key in one of the forms that `node:crypto` reads: a `KeyObject`, PEM text, DER bytes (PKCS#8 or SPKI) or a JWK. */
/**
 * This type is a JSON Web Key, as `createPrivateKey` of `node:crypto` reads it. The type comes from `JsonWebKeyInput`, which
 * `@types/node` 22 and 26 both have: version 26 has no `JsonWebKey` export in `node:crypto`.
 */
export type JwkInput = JsonWebKeyInput["key"];

export type KeyInput = KeyObject | string | Uint8Array | JwkInput;

/** These options make a signer for Web Bot Auth. */
export interface WebBotAuthOptions {
  /** This key signs. It is an Ed25519 private key: a `KeyObject`, PKCS#8 (PEM text or DER bytes) or a JWK with `d`. */
  readonly privateKey: KeyInput;
  /**
   * This text is the `keyid` of each signature: the JWK thumbprint of the key (RFC 8037). The signer
   * calculates it. A value that is not the thumbprint of the key throws an error.
   */
  readonly keyId?: string | undefined;
  /**
   * This URL tells a site where the keys are. For the type `directory`, it is an https origin, for
   * example `https://bot.example.com`. For `jwks_uri`, it is the https URL of a JSON Web Key Set.
   */
  readonly signatureAgent: string;
  /** This value tells how a site finds the keys from `signatureAgent`. The default is `directory`. */
  readonly agentType?: SignatureAgentType | undefined;
  /** This value is the time that a signature stays valid, in milliseconds. The default is 5 minutes, and the maximum is 24 hours. */
  readonly lifetimeMs?: number | undefined;
  /** This text is the label of the signature, and the key of the member of `Signature-Agent`. The default is `sig1`. */
  readonly label?: string | undefined;
}

/**
 * A request signer gives the signature headers of one request. The crawler uses it for each
 * request, robots.txt too. `createWebBotAuthSigner` makes one. A signer of your own can sign with a
 * key in a hardware module, for example.
 */
export interface RequestSigner {
  /** This text is the `keyid` of the signatures. */
  readonly keyId: string;
  /** This URL is the value of the member of `Signature-Agent`: where a site finds the keys. */
  readonly signatureAgent: string;
  /** This method gives the headers that sign a request to `url` at the time `now` (milliseconds since the epoch). */
  sign(url: URL, now: number): Readonly<Record<string, string>>;
}

/** The signer that `createWebBotAuthSigner` makes. It also gives its public key for the key directory. */
export interface WebBotAuthSigner extends RequestSigner {
  /** This JWK is the public key of the signer, with no private part. Give it to `keyDirectory`. */
  readonly publicKey: JwkInput;
}

/** One key of a key directory: an Ed25519 public key as a JWK, with its thumbprint as `kid`. */
export interface DirectoryKey {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly kid: string;
  readonly x: string;
  readonly use: "sig";
}

/** A key directory: a JSON Web Key Set. The operator serves it as JSON at `KEY_DIRECTORY_PATH`, with the type `KEY_DIRECTORY_TYPE`. */
export interface KeyDirectory {
  readonly keys: readonly DirectoryKey[];
}

/** The parts of a request that `verifySignature` reads. */
export interface SignedRequest {
  readonly url: string;
  /** The default is `GET`. */
  readonly method?: string | undefined;
  /** These are the headers of the request. A name can be in any case, and a header can have more than one line. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** The result of `verifySignature`. */
export interface SignatureCheck {
  /** This value is true when a Web Bot Auth signature of the request verifies with a key of the directory. */
  readonly verified: boolean;
  /** This text is the label of the signature that the check examined last, or null. */
  readonly label: string | null;
  readonly keyId: string | null;
  /** This URL is the member of `Signature-Agent` that the signature covers, or null. */
  readonly agent: string | null;
  /** This text tells why the request does not verify. It is null when it verifies. */
  readonly reason: string | null;
}

// ── structured fields (RFC 9651): the parts that the signature headers use ──

/** A token of a structured field, for example `ed25519` in `alg=ed25519`. */
class Token {
  constructor(readonly value: string) {}
}

type BareItem = string | number | boolean | Uint8Array | Token;
type Params = ReadonlyArray<readonly [string, BareItem]>;

interface Item {
  readonly value: BareItem;
  readonly params: Params;
}

interface InnerList {
  readonly items: readonly Item[];
  readonly params: Params;
}

type Member = Item | InnerList;

const isInnerList = (member: Member): member is InnerList => "items" in member;

/** This error tells that a structured field does not parse. */
class FieldError extends Error {}

const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const TOKEN_START = /[A-Za-z*]/;
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const BASE64 = /^[A-Za-z0-9+/=]*$/;

/** This class reads one structured field from its text. */
class FieldParser {
  private at = 0;
  constructor(private readonly text: string) {}

  private peek(): string {
    return this.text[this.at] ?? "";
  }

  private spaces(): void {
    while (this.peek() === " ") this.at += 1;
  }

  private ows(): void {
    while (this.peek() === " " || this.peek() === "\t") this.at += 1;
  }

  dictionary(): Map<string, Member> {
    const out = new Map<string, Member>();
    this.spaces();
    while (this.at < this.text.length) {
      const key = this.key();
      let member: Member;
      if (this.peek() === "=") {
        this.at += 1;
        member = this.peek() === "(" ? this.innerList() : this.item();
      } else {
        member = { value: true, params: this.params() };
      }
      out.set(key, member);
      this.ows();
      if (this.at >= this.text.length) break;
      if (this.peek() !== ",") throw new FieldError(`a "," is necessary at ${String(this.at)}`);
      this.at += 1;
      this.ows();
      if (this.at >= this.text.length) throw new FieldError("the field ends with a comma");
    }
    return out;
  }

  /** This method reads one item and checks that the field has nothing after it. */
  wholeItem(): Item {
    this.spaces();
    const item = this.item();
    this.spaces();
    if (this.at < this.text.length) throw new FieldError("text after the item");
    return item;
  }

  private key(): string {
    if (!KEY_START.test(this.peek())) throw new FieldError(`no key at ${String(this.at)}`);
    const start = this.at;
    while (KEY_CHAR.test(this.peek()) && this.at < this.text.length) this.at += 1;
    return this.text.slice(start, this.at);
  }

  private innerList(): InnerList {
    this.at += 1;
    const items: Item[] = [];
    for (;;) {
      this.spaces();
      if (this.peek() === ")") {
        this.at += 1;
        return { items, params: this.params() };
      }
      if (this.at >= this.text.length) throw new FieldError("an inner list has no end");
      items.push(this.item());
      if (this.peek() !== " " && this.peek() !== ")")
        throw new FieldError(`a space or ")" is necessary at ${String(this.at)}`);
    }
  }

  private item(): Item {
    const value = this.bare();
    return { value, params: this.params() };
  }

  private params(): Params {
    const out: Array<readonly [string, BareItem]> = [];
    while (this.peek() === ";") {
      this.at += 1;
      this.spaces();
      const key = this.key();
      let value: BareItem = true;
      if (this.peek() === "=") {
        this.at += 1;
        value = this.bare();
      }
      const known = out.findIndex(([name]) => name === key);
      if (known === -1) out.push([key, value]);
      else out[known] = [key, value];
    }
    return out;
  }

  private bare(): BareItem {
    const char = this.peek();
    if (char === "-" || /[0-9]/.test(char)) return this.number();
    if (char === '"') return this.string();
    if (char === ":") return this.bytes();
    if (char === "?") return this.boolean();
    if (TOKEN_START.test(char)) return this.token();
    throw new FieldError(`no item at ${String(this.at)}`);
  }

  private number(): number {
    const match = /^-?(\d{1,15})(\.\d{1,3})?/.exec(this.text.slice(this.at));
    if (match === null || (match[2] !== undefined && match[1]!.length > 12))
      throw new FieldError(`not a number at ${String(this.at)}`);
    this.at += match[0].length;
    return Number(match[0]);
  }

  private string(): string {
    this.at += 1;
    let out = "";
    for (;;) {
      const char = this.peek();
      if (char === "") throw new FieldError("a string has no end");
      this.at += 1;
      if (char === "\\") {
        const next = this.peek();
        if (next !== '"' && next !== "\\") throw new FieldError("a bad escape in a string");
        out += next;
        this.at += 1;
      } else if (char === '"') {
        return out;
      } else {
        const code = char.charCodeAt(0);
        if (code < 0x20 || code > 0x7e)
          throw new FieldError("a string holds a character that is not printable ASCII");
        out += char;
      }
    }
  }

  private bytes(): Uint8Array {
    this.at += 1;
    const end = this.text.indexOf(":", this.at);
    if (end === -1) throw new FieldError("a byte sequence has no end");
    const text = this.text.slice(this.at, end);
    if (!BASE64.test(text)) throw new FieldError("a byte sequence is not base64");
    this.at = end + 1;
    return new Uint8Array(Buffer.from(text, "base64"));
  }

  private boolean(): boolean {
    const value = this.text.slice(this.at, this.at + 2);
    if (value !== "?1" && value !== "?0") throw new FieldError("not a boolean");
    this.at += 2;
    return value === "?1";
  }

  private token(): Token {
    const start = this.at;
    this.at += 1;
    while (TOKEN_CHAR.test(this.peek()) && this.at < this.text.length) this.at += 1;
    return new Token(this.text.slice(start, this.at));
  }
}

const serializeBare = (value: BareItem): string => {
  if (value instanceof Token) return value.value;
  if (value instanceof Uint8Array) return `:${Buffer.from(value).toString("base64")}:`;
  if (typeof value === "boolean") return value ? "?1" : "?0";
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  return `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;
};

const serializeParams = (params: Params): string =>
  params
    .map(([key, value]) => (value === true ? `;${key}` : `;${key}=${serializeBare(value)}`))
    .join("");

const serializeItem = (item: Item): string =>
  `${serializeBare(item.value)}${serializeParams(item.params)}`;

const serializeMember = (member: Member): string =>
  isInnerList(member)
    ? `(${member.items.map(serializeItem).join(" ")})${serializeParams(member.params)}`
    : serializeItem(member);

/** This function tells if a text is a key of a structured field: a label of a signature, for example. */
const isKey = (text: string): boolean => /^[a-z*][a-z0-9_\-.*]*$/.test(text);

// ── keys ──

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const isKeyObject = (key: KeyInput): key is KeyObject =>
  typeof key === "object" && key !== null && "asymmetricKeyType" in key && "export" in key;

/** This function reads a private key. Its errors do not hold the key. */
const privateKeyOf = (input: KeyInput): KeyObject => {
  let key: KeyObject;
  try {
    if (isKeyObject(input)) key = input;
    else if (typeof input === "string")
      key = input.trim().startsWith("{")
        ? createPrivateKey({ key: JSON.parse(input) as JwkInput, format: "jwk" })
        : createPrivateKey(input);
    else if (input instanceof Uint8Array)
      key = createPrivateKey({ key: Buffer.from(input), format: "der", type: "pkcs8" });
    else key = createPrivateKey({ key: input, format: "jwk" });
  } catch (cause) {
    throw new Error(
      "the private key of the signer does not parse: give an Ed25519 key as PKCS#8 (PEM or DER) or as a JWK",
      { cause },
    );
  }
  if (key.type !== "private")
    throw new Error("the key of the signer is not a private key: give the Ed25519 private key");
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error(
      `the key of the signer is ${key.asymmetricKeyType ?? "not an asymmetric key"}, not ed25519: Web Bot Auth here uses Ed25519 keys`,
    );
  return key;
};

/** This function reads a public key, or the public part of a private key. Its errors do not hold the key. */
const publicKeyOf = (input: KeyInput): KeyObject => {
  let key: KeyObject;
  try {
    if (isKeyObject(input)) key = input.type === "private" ? createPublicKey(input) : input;
    else if (typeof input === "string")
      key = input.trim().startsWith("{")
        ? createPublicKey({ key: JSON.parse(input) as JwkInput, format: "jwk" })
        : createPublicKey(input);
    else if (input instanceof Uint8Array) {
      const bytes = Buffer.from(input);
      try {
        key = createPublicKey({ key: bytes, format: "der", type: "spki" });
      } catch {
        key = createPublicKey(createPrivateKey({ key: bytes, format: "der", type: "pkcs8" }));
      }
    } else key = createPublicKey({ key: input, format: "jwk" });
  } catch (cause) {
    throw new Error("a key of the directory does not parse: give an Ed25519 key", { cause });
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error(
      `a key of the directory is ${key.asymmetricKeyType ?? "not an asymmetric key"}, not ed25519`,
    );
  return key;
};

/** This function gives the JWK thumbprint of an Ed25519 public key (RFC 7638, RFC 8037 appendix A.3). */
const thumbprintOf = (x: string): string =>
  base64url(
    createHash("sha256")
      .update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }), "utf8")
      .digest(),
  );

const directoryKeyOf = (key: KeyObject): DirectoryKey => {
  const jwk = key.export({ format: "jwk" });
  const x = typeof jwk.x === "string" ? jwk.x : "";
  return { kty: "OKP", crv: "Ed25519", kid: thumbprintOf(x), x, use: "sig" };
};

/**
 * This function makes the key directory for the operator to host: a JSON Web Key Set with each
 * public key and its thumbprint as `kid`. It takes public keys, or private keys, and it writes only
 * their public parts. Serve the JSON at `KEY_DIRECTORY_PATH` with the type `KEY_DIRECTORY_TYPE`.
 */
export const keyDirectory = (publicKeys: readonly KeyInput[]): KeyDirectory => {
  const keys = new Map<string, DirectoryKey>();
  for (const input of publicKeys) {
    const key = directoryKeyOf(publicKeyOf(input));
    keys.set(key.kid, key);
  }
  return { keys: [...keys.values()] };
};

// ── signing ──

/** The parts of one signature. The signer and the tests use this function. */
export interface SignatureParts {
  /** The value of `@authority`: the host and a port that is not the default port, in lowercase. */
  readonly authority: string;
  readonly label: string;
  /** The key of the member of `Signature-Agent`. The draft uses the label of the signature. */
  readonly agentKey: string;
  /** The serialized value of the member: a string, and its parameters. */
  readonly agentValue: string;
  readonly keyId: string;
  readonly created: number;
  readonly expires: number;
  readonly nonce?: string | undefined;
}

/** This function gives the `@signature-params` value: the covered components and the parameters, in the order of the draft. */
const signatureParams = (parts: SignatureParts): string =>
  `("@authority" "signature-agent";key=${serializeBare(parts.agentKey)});created=${String(parts.created)};keyid=${serializeBare(parts.keyId)};alg="ed25519";expires=${String(parts.expires)}${parts.nonce === undefined ? "" : `;nonce=${serializeBare(parts.nonce)}`};tag="${WEB_BOT_AUTH_TAG}"`;

/** This function gives the signature base of RFC 9421, section 2.5, for the components of Web Bot Auth. */
export const signatureBase = (parts: SignatureParts): string =>
  [
    `"@authority": ${parts.authority}`,
    `"signature-agent";key=${serializeBare(parts.agentKey)}: ${parts.agentValue}`,
    `"@signature-params": ${signatureParams(parts)}`,
  ].join("\n");

/** This function signs the parts with an Ed25519 key, and gives the three headers. */
export const signParts = (
  parts: SignatureParts,
  key: KeyObject,
): {
  readonly "signature-agent": string;
  readonly "signature-input": string;
  readonly signature: string;
} => {
  const signature = signBytes(null, Buffer.from(signatureBase(parts), "utf8"), key);
  return {
    "signature-agent": `${parts.agentKey}=${parts.agentValue}`,
    "signature-input": `${parts.label}=${signatureParams(parts)}`,
    signature: `${parts.label}=:${signature.toString("base64")}:`,
  };
};

const DEFAULT_LIFETIME_MS = 5 * 60_000;
const MAX_LIFETIME_MS = 24 * 60 * 60_000;

/** This function checks the URL of `Signature-Agent`, and gives the URL and the serialized value of the member. */
const agentOf = (
  url: string,
  type: SignatureAgentType,
): { readonly url: string; readonly value: string } => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(
      `signatureAgent "${url}" is not a URL: give the https URL of the key directory`,
    );
  }
  if (target.protocol !== "https:")
    throw new Error(`signatureAgent "${url}" is not an https URL: the draft permits only https`);
  if (target.username !== "" || target.password !== "" || target.hash !== "")
    throw new Error(`signatureAgent "${url}" has a user name, a password or a fragment`);
  if (type === "directory") {
    if (target.pathname !== "/" || target.search !== "")
      throw new Error(
        `signatureAgent "${url}" is not an origin: the type directory takes only an origin, such as https://bot.example.com. For a key set on a path, set agentType to jwks_uri`,
      );
    return { url: target.origin, value: serializeBare(target.origin) };
  }
  return { url: target.href, value: `${serializeBare(target.href)};type=${type}` };
};

/**
 * This function makes a signer for Web Bot Auth with an Ed25519 key. Each signature covers
 * `@authority` and the member of `Signature-Agent`. It has a new random nonce, and it expires after
 * `lifetimeMs`. The signer keeps the private key in a closure: no property of the signer holds it.
 */
export const createWebBotAuthSigner = (options: WebBotAuthOptions): WebBotAuthSigner => {
  const key = privateKeyOf(options.privateKey);
  const publicKey = directoryKeyOf(createPublicKey(key));
  if (options.keyId !== undefined && options.keyId !== publicKey.kid)
    throw new Error(
      `keyId "${options.keyId}" is not the JWK thumbprint of the key (${publicKey.kid}): Web Bot Auth uses the thumbprint as keyid`,
    );
  const agent = agentOf(options.signatureAgent, options.agentType ?? "directory");
  const label = options.label ?? "sig1";
  if (!isKey(label))
    throw new Error(
      `label "${label}" is not a key of a structured field: use lowercase letters, digits, "_", "-", "." and "*"`,
    );
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > MAX_LIFETIME_MS)
    throw new RangeError(
      `lifetimeMs must be from 1000 (1 second) to ${String(MAX_LIFETIME_MS)} (24 hours), not ${String(lifetimeMs)}`,
    );
  const { kty, crv, x } = publicKey;
  return {
    keyId: publicKey.kid,
    signatureAgent: agent.url,
    publicKey: { kty, crv, x },
    sign(url, now) {
      const created = Math.floor(now / 1000);
      return signParts(
        {
          authority: url.host.toLowerCase(),
          label,
          agentKey: label,
          agentValue: agent.value,
          keyId: publicKey.kid,
          created,
          expires: created + Math.ceil(lifetimeMs / 1000),
          nonce: randomBytes(32).toString("base64"),
        },
        key,
      );
    },
  };
};

/** This function tells if a value is a request signer, not the options of one. */
export const isRequestSigner = (value: RequestSigner | WebBotAuthOptions): value is RequestSigner =>
  typeof (value as Partial<RequestSigner>).sign === "function";

/** This function gives a request signer: the signer itself, or a new signer from its options. */
export const signerOf = (
  value: RequestSigner | WebBotAuthOptions | undefined,
): RequestSigner | undefined =>
  value === undefined ? undefined : isRequestSigner(value) ? value : createWebBotAuthSigner(value);

// ── verification ──

/** A signature can start this long before the clock of the verifier, for a small difference of the clocks. */
const CLOCK_SKEW_S = 60;

const headerLines = (
  headers: SignedRequest["headers"],
  name: string,
): readonly string[] | undefined => {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) continue;
    return typeof value === "string" ? [value] : value;
  }
  return undefined;
};

/** This function gives the value of a header as RFC 9421 section 2.1 combines it: each line without its outer spaces, with ", " between. */
const fieldValue = (headers: SignedRequest["headers"], name: string): string | undefined =>
  headerLines(headers, name)
    ?.map((line) => line.replace(/\r?\n[ \t]+/g, " ").trim())
    .join(", ");

/** This function gives the value of one component of a request, or an error text. */
const componentValue = (
  component: Item,
  request: SignedRequest,
  target: URL,
): { readonly value: string } | { readonly error: string } => {
  const name = component.value;
  if (typeof name !== "string") return { error: "a component is not a string" };
  const params = new Map(component.params);
  if (name.startsWith("@")) {
    if (params.size > 0) return { error: `the parameters of ${name} are not supported` };
    switch (name) {
      case "@method":
        return { value: (request.method ?? "GET").toUpperCase() };
      case "@authority":
        return { value: target.host.toLowerCase() };
      case "@scheme":
        return { value: target.protocol.slice(0, -1).toLowerCase() };
      case "@target-uri":
        return { value: target.href };
      case "@path":
        return { value: target.pathname === "" ? "/" : target.pathname };
      case "@query":
        return { value: target.search === "" ? "?" : target.search };
      case "@request-target":
        return { value: `${target.pathname}${target.search}` };
      default:
        return { error: `the component ${name} is not supported` };
    }
  }
  const value = fieldValue(request.headers, name);
  if (value === undefined) return { error: `the request has no ${name} header` };
  if ([...params.keys()].some((param) => param !== "key"))
    return { error: `the parameters of ${name} are not supported` };
  const key = params.get("key");
  if (key === undefined) return { value };
  if (typeof key !== "string") return { error: `the key of ${name} is not a string` };
  let member: Member | undefined;
  try {
    member = new FieldParser(value).dictionary().get(key);
  } catch (error) {
    return { error: `the ${name} header is not a dictionary: ${(error as Error).message}` };
  }
  if (member === undefined) return { error: `the ${name} header has no member ${key}` };
  return { value: serializeMember(member) };
};

const failed = (
  reason: string,
  facts: { label?: string | null; keyId?: string | null; agent?: string | null } = {},
): SignatureCheck => ({
  verified: false,
  label: facts.label ?? null,
  keyId: facts.keyId ?? null,
  agent: facts.agent ?? null,
  reason,
});

/**
 * This function verifies the Web Bot Auth signatures of a request with the keys of a directory. It
 * applies RFC 9421 section 3.2 and the profile of the draft. The profile asks for the tag
 * `web-bot-auth`, `created`, `expires` and `@authority`. It also asks for the member of
 * `Signature-Agent`, and a key with the thumbprint of `keyid`. The tests use it, and an operator can check a setup with it. It sends no request.
 */
export const verifySignature = (
  request: SignedRequest,
  directory: KeyDirectory,
  options: { readonly now?: number | undefined } = {},
): SignatureCheck => {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return failed("the URL of the request is not a URL");
  }
  const inputText = fieldValue(request.headers, "signature-input");
  const signatureText = fieldValue(request.headers, "signature");
  if (inputText === undefined || signatureText === undefined)
    return failed("the request has no Signature-Input or no Signature header");
  let inputs: Map<string, Member>;
  let signatures: Map<string, Member>;
  try {
    inputs = new FieldParser(inputText).dictionary();
    signatures = new FieldParser(signatureText).dictionary();
  } catch (error) {
    return failed(`a signature header does not parse: ${(error as Error).message}`);
  }
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const keys = new Map<string, KeyObject>();
  for (const entry of directory.keys) {
    try {
      const key = createPublicKey({
        key: { kty: entry.kty, crv: entry.crv, x: entry.x },
        format: "jwk",
      });
      keys.set(thumbprintOf(entry.x), key);
    } catch {
      // a key that does not parse verifies nothing
    }
  }
  let last: SignatureCheck = failed("the request has no Web Bot Auth signature");
  for (const [label, input] of inputs) {
    if (!isInnerList(input)) continue;
    const params = new Map(input.params);
    if (params.get("tag") !== WEB_BOT_AUTH_TAG) continue;
    const keyId = typeof params.get("keyid") === "string" ? (params.get("keyid") as string) : null;
    const covered = input.items;
    const names = covered.map((item) => serializeItem(item));
    const agentItem = covered.find((item) => item.value === "signature-agent");
    let agent: string | null = null;
    if (agentItem !== undefined) {
      const value = componentValue(agentItem, request, target);
      if ("value" in value) {
        try {
          const member = new FieldParser(value.value).wholeItem().value;
          agent = typeof member === "string" ? member : null;
        } catch {
          agent = null;
        }
      }
    }
    const facts = { label, keyId, agent };
    if (new Set(names).size !== names.length) {
      last = failed("a component is covered two times", facts);
      continue;
    }
    if (!names.includes('"@authority"') && !names.includes('"@target-uri"')) {
      last = failed("the signature does not cover @authority or @target-uri", facts);
      continue;
    }
    if (agentItem === undefined) {
      last = failed("the signature does not cover Signature-Agent", facts);
      continue;
    }
    const created = params.get("created");
    const expires = params.get("expires");
    if (typeof created !== "number" || typeof expires !== "number") {
      last = failed("the signature has no created or no expires", facts);
      continue;
    }
    if (expires <= now) {
      last = failed("the signature expired", facts);
      continue;
    }
    if (created > now + CLOCK_SKEW_S) {
      last = failed("the signature was created in the future", facts);
      continue;
    }
    const alg = params.get("alg");
    if (alg !== undefined && alg !== "ed25519") {
      last = failed(`the algorithm ${serializeBare(alg)} is not ed25519`, facts);
      continue;
    }
    const key = keyId === null ? undefined : keys.get(keyId);
    if (key === undefined) {
      last = failed("no key of the directory has the thumbprint of keyid", facts);
      continue;
    }
    const lines: string[] = [];
    let error: string | undefined;
    for (const item of covered) {
      const value = componentValue(item, request, target);
      if ("error" in value) {
        error = value.error;
        break;
      }
      lines.push(`${serializeItem(item)}: ${value.value}`);
    }
    if (error !== undefined) {
      last = failed(error, facts);
      continue;
    }
    lines.push(`"@signature-params": ${serializeMember(input)}`);
    const signature = signatures.get(label);
    if (
      signature === undefined ||
      isInnerList(signature) ||
      !(signature.value instanceof Uint8Array)
    ) {
      last = failed(`the Signature header has no byte sequence for ${label}`, facts);
      continue;
    }
    const good = verifyBytes(null, Buffer.from(lines.join("\n"), "utf8"), key, signature.value);
    if (good) return { verified: true, label, keyId, agent, reason: null };
    last = failed("the signature does not match the signature base", facts);
  }
  return last;
};
