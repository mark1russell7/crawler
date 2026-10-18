// The source of polite-crawler imports the type JsonWebKey from node:crypto, as @types/node 22 gives
// it. The @types/node 26 of the site has it only as webcrypto.JsonWebKey. This declaration gives the
// old name, so that the type check of the site can read the source of the package.
import type { webcrypto } from "node:crypto";

declare module "node:crypto" {
  export type JsonWebKey = webcrypto.JsonWebKey;
}
