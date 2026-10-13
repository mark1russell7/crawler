import type { LookupAddress, LookupAllOptions, LookupOptions } from "node:dns";
import { lookup as systemLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";

/**
 * The egress policy keeps the crawler on the public internet. A page or an agent can ask for an
 * internal address. Examples are a loopback service, a router on the LAN and the metadata
 * service of a cloud host. The crawler refuses these addresses by default.
 *
 * - The crawler fetches only `http:` and `https:` URLs.
 * - The check uses the address after DNS. The `lookup` hook of the connection checks the address
 *   that the socket then uses, so a DNS answer that changes cannot pass the check.
 * - The crawler examines a literal IP host directly, in each spelling that the URL parser reads.
 * - The crawler examines each redirect hop again.
 *
 * A refusal is a skipped fetch with a clear note. It does not throw an error.
 */

/** These options change the egress policy. With no options, the crawler fetches only public addresses. */
export interface EgressOptions {
  /** The value true lets the crawler fetch loopback, private and link-local addresses. The default is false. */
  readonly allowPrivate?: boolean | undefined;
  /**
   * These hosts are permitted although their address is not public. An entry is a host name, a
   * name pattern (`*.corp.example`), an IP address or a CIDR range (`10.0.0.0/8`).
   */
  readonly allowHosts?: readonly string[] | undefined;
}

/** The connection hook gives this error when the policy refuses each address of a host. */
export class EgressRefused extends Error {
  readonly code: string = "EGRESS_REFUSED";
  constructor(
    readonly address: string,
    readonly kind: string,
  ) {
    super(egressNote(address, kind));
    this.name = "EgressRefused";
  }
}

/** This function gives the note of a refusal, with the address and the kind of address. */
export const egressNote = (address: string, kind: string): string =>
  `egress policy: ${address} is ${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind} address; set allowPrivate to fetch it`;

type Bytes = readonly number[];

/**
 * This function reads an IPv4 address the way the URL parser reads a host. The address has one to
 * four parts, and each part is decimal, octal (`0177`) or hexadecimal (`0x7f`). Thus
 * `2130706433` and `0x7f.1` both give 127.0.0.1. A text that is not an IPv4 address gives no value.
 */
export const parseIPv4 = (text: string): Bytes | undefined => {
  const parts = text.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0 || parts.length > 4) return undefined;
  const numbers: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0[xX][0-9a-fA-F]*$/.test(part))
      value = part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(part)) value = Number(part);
    else return undefined;
    numbers.push(value);
  }
  const last = numbers.pop()!;
  if (numbers.some((value) => value > 255)) return undefined;
  if (last >= 256 ** (4 - numbers.length)) return undefined;
  let rest = last;
  const tail: number[] = [];
  for (let index = numbers.length; index < 4; index += 1) {
    tail.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return [...numbers, ...tail];
};

/** This function reads an IPv6 address, with or without brackets and a zone. It gives 16 bytes. */
export const parseIPv6 = (text: string): Bytes | undefined => {
  let value = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (isIP(value) !== 6) return undefined;
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === undefined) return undefined;
    const high = (v4[0]! << 8) | v4[1]!;
    const low = (v4[2]! << 8) | v4[3]!;
    value = `${value.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const [head = "", rest] = value.split("::");
  const groupsOf = (part: string): number[] =>
    part.length === 0 ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
  const front = groupsOf(head);
  const back = rest === undefined ? [] : groupsOf(rest);
  const groups = [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
  if (groups.length !== 8) return undefined;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
};

const v4 = (text: string): Bytes => parseIPv4(text)!;
const v6 = (text: string): Bytes => parseIPv6(text)!;

/** This function tells if the first `bits` bits of two addresses agree. */
const inPrefix = (address: Bytes, prefix: Bytes, bits: number): boolean => {
  if (address.length !== prefix.length) return false;
  for (let index = 0; index < address.length; index += 1) {
    const take = Math.max(0, Math.min(8, bits - index * 8));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((address[index]! & mask) !== (prefix[index]! & mask)) return false;
  }
  return true;
};

// the more specific ranges come first, so a metadata address does not read as link-local
const V4_RANGES: ReadonlyArray<readonly [Bytes, number, string]> = [
  [v4("169.254.169.254"), 32, "metadata"],
  [v4("168.63.129.16"), 32, "metadata"],
  [v4("100.100.100.200"), 32, "metadata"],
  [v4("0.0.0.0"), 8, "unspecified"],
  [v4("10.0.0.0"), 8, "private"],
  [v4("100.64.0.0"), 10, "carrier-grade NAT"],
  [v4("127.0.0.0"), 8, "loopback"],
  [v4("169.254.0.0"), 16, "link-local"],
  [v4("172.16.0.0"), 12, "private"],
  [v4("192.0.0.0"), 24, "reserved"],
  [v4("192.0.2.0"), 24, "documentation"],
  [v4("192.168.0.0"), 16, "private"],
  [v4("198.18.0.0"), 15, "benchmark"],
  [v4("198.51.100.0"), 24, "documentation"],
  [v4("203.0.113.0"), 24, "documentation"],
  [v4("224.0.0.0"), 4, "multicast"],
  [v4("240.0.0.0"), 4, "reserved"],
];

const V6_RANGES: ReadonlyArray<readonly [Bytes, number, string]> = [
  [v6("fd00:ec2::254"), 128, "metadata"],
  [v6("::"), 128, "unspecified"],
  [v6("::1"), 128, "loopback"],
  [v6("64:ff9b:1::"), 48, "reserved"],
  [v6("100::"), 64, "reserved"],
  [v6("2001::"), 32, "reserved"],
  [v6("2001:db8::"), 32, "documentation"],
  [v6("fc00::"), 7, "unique local"],
  [v6("fe80::"), 10, "link-local"],
  [v6("fec0::"), 10, "private"],
  [v6("ff00::"), 8, "multicast"],
];

const kindOfV4 = (address: Bytes): string | undefined =>
  V4_RANGES.find(([prefix, bits]) => inPrefix(address, prefix, bits))?.[2];

const kindOfV6 = (address: Bytes): string | undefined => {
  const zeroes = (from: number, to: number): boolean =>
    address.slice(from, to).every((byte) => byte === 0);
  const embedded = (from: number): string | undefined => kindOfV4(address.slice(from, from + 4));
  // an IPv4 address in an IPv6 form has the kind of the IPv4 address
  if (zeroes(0, 10) && address[10] === 0xff && address[11] === 0xff) return embedded(12);
  if (inPrefix(address, v6("64:ff9b::"), 96)) return embedded(12);
  if (address[0] === 0x20 && address[1] === 0x02) return embedded(2);
  const listed = V6_RANGES.find(([prefix, bits]) => inPrefix(address, prefix, bits))?.[2];
  if (listed !== undefined) return listed;
  // the old IPv4-compatible form (::a.b.c.d) and the rest of ::/8 are not public
  if (zeroes(0, 12)) return embedded(12) ?? "reserved";
  if (address[0] === 0) return "reserved";
  return undefined;
};

/**
 * This function gives the kind of an address that is not public, for example `loopback` or
 * `private`. It reads each IPv4 spelling and each IPv6 form. A public address, or a text that is not
 * an address, gives no value.
 */
export const addressKind = (address: string): string | undefined => {
  const four = parseIPv4(address);
  if (four !== undefined) return kindOfV4(four);
  const six = parseIPv6(address);
  return six === undefined ? undefined : kindOfV6(six);
};

const nameOf = (host: string): string => host.trim().toLowerCase().replace(/\.$/, "");

/** These names have a fixed meaning. They do not go to DNS. */
const NAME_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)localhost$/, "loopback"],
  [/^metadata\.google\.internal$/, "metadata"],
  [/^metadata\.goog$/, "metadata"],
];

const literalOf = (host: string): Bytes | undefined => parseIPv6(host) ?? parseIPv4(host);

const inRange = (entry: string, address: Bytes): boolean => {
  const slash = entry.indexOf("/");
  const base = literalOf(slash === -1 ? entry : entry.slice(0, slash));
  if (base === undefined || base.length !== address.length) return false;
  const bits = slash === -1 ? base.length * 8 : Number(entry.slice(slash + 1));
  return (
    Number.isInteger(bits) && bits >= 0 && bits <= base.length * 8 && inPrefix(address, base, bits)
  );
};

/** This function tells if an entry of `allowHosts` permits this host name or this address. */
const permitted = (policy: EgressOptions, host: string, address: string | undefined): boolean => {
  if (policy.allowPrivate === true) return true;
  const name = nameOf(host);
  const bytes = address === undefined ? literalOf(name) : literalOf(address);
  for (const raw of policy.allowHosts ?? []) {
    const entry = nameOf(raw);
    if (entry === name) return true;
    if (entry.startsWith("*.") && name.endsWith(entry.slice(1))) return true;
    if (bytes !== undefined && inRange(entry, bytes)) return true;
  }
  return false;
};

/** This function gives a short form of an address for a note: IPv6 in brackets, IPv4 with dots. */
const shown = (host: string): string => {
  const bytes = literalOf(host);
  if (bytes === undefined) return host;
  if (bytes.length === 4) return bytes.join(".");
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2)
    groups.push(((bytes[index]! << 8) | bytes[index + 1]!).toString(16));
  return groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
};

/**
 * This function examines a host before DNS: a literal IP address in any spelling, and the names
 * with a fixed meaning (`localhost`). It gives the note of a refusal, or no value. A host name that
 * needs DNS gets its check in the connection hook.
 */
export const egressRefusal = (policy: EgressOptions, host: string): string | undefined => {
  if (policy.allowPrivate === true) return undefined;
  const name = nameOf(host);
  const literal = literalOf(name);
  if (literal !== undefined) {
    const kind = addressKind(name);
    return kind === undefined || permitted(policy, name, undefined)
      ? undefined
      : egressNote(shown(name), kind);
  }
  for (const [pattern, kind] of NAME_KINDS) {
    if (pattern.test(name) && !permitted(policy, name, undefined)) return egressNote(name, kind);
  }
  return undefined;
};

/** This is the form of `dns.lookup` that the egress hook uses. Tests give a resolver of their own. */
export type Resolve = (
  host: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const resolveAll: Resolve = (host, options, callback) => systemLookup(host, options, callback);

/** This function keeps the addresses that the policy permits. When it keeps none, it gives the refusal. */
const screen = (
  policy: EgressOptions,
  host: string,
  addresses: readonly LookupAddress[],
): { readonly usable: LookupAddress[]; readonly refusal: EgressRefused | undefined } => {
  const usable: LookupAddress[] = [];
  let refusal: EgressRefused | undefined;
  for (const entry of addresses) {
    const kind = addressKind(entry.address);
    if (kind === undefined || permitted(policy, host, entry.address)) usable.push(entry);
    else refusal ??= new EgressRefused(shown(entry.address), kind);
  }
  return {
    usable,
    refusal: usable.length === 0 ? (refusal ?? new EgressRefused(host, "unresolved")) : undefined,
  };
};

/**
 * This function gives a `lookup` hook for the connection options of an undici `Agent`. The hook
 * resolves the name, removes each address that the policy refuses, and gives the rest to the
 * socket. When no address stays, the connection fails with `EgressRefused`.
 */
export const egressLookup =
  (policy: EgressOptions, resolve: Resolve = resolveAll): LookupFunction =>
  (host: string, options: LookupOptions, callback) => {
    resolve(host, { ...options, all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, []);
        return;
      }
      const { usable, refusal } =
        policy.allowPrivate === true
          ? { usable: addresses, refusal: undefined }
          : screen(policy, host, addresses);
      if (refusal !== undefined) {
        callback(refusal, []);
        return;
      }
      if (options.all === true) callback(null, usable);
      else callback(null, usable[0]!.address, usable[0]!.family);
    });
  };

/**
 * This function examines a URL with DNS, for a client that does its own DNS, for example the
 * browser. It refuses a host when one of its addresses is not public. A name that DNS cannot
 * resolve gets no refusal, because the client cannot connect to it either. The function gives
 * the note of a refusal, or no value.
 *
 * The client resolves the name again, so a DNS answer that changes between the two lookups can
 * pass. The connection hook (`egressLookup`) does not have this gap.
 */
export const checkEgress = async (
  policy: EgressOptions,
  url: URL,
  resolve: Resolve = resolveAll,
): Promise<string | undefined> => {
  if (policy.allowPrivate === true) return undefined;
  const before = egressRefusal(policy, url.hostname);
  if (before !== undefined) return before;
  const name = nameOf(url.hostname);
  if (literalOf(name) !== undefined || permitted(policy, name, undefined)) return undefined;
  const addresses = await new Promise<LookupAddress[] | Error>((settle) =>
    resolve(name, { all: true }, (error, found) => settle(error ?? found)),
  );
  if (addresses instanceof Error) return undefined;
  for (const entry of addresses) {
    const kind = addressKind(entry.address);
    if (kind !== undefined && !permitted(policy, name, entry.address))
      return egressNote(shown(entry.address), kind);
  }
  return undefined;
};

/** This function finds an `EgressRefused` in an error, its cause or its group of errors. */
export const egressError = (error: unknown): EgressRefused | undefined => {
  for (
    let current = error, depth = 0;
    current !== undefined && current !== null && depth < 5;
    depth += 1
  ) {
    if (current instanceof EgressRefused) return current;
    if (current instanceof AggregateError) {
      const inner = current.errors.find((item: unknown) => item instanceof EgressRefused) as
        EgressRefused | undefined;
      if (inner !== undefined) return inner;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};
