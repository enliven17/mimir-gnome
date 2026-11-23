/**
 * gno.land addresses: a realm's address is the bech32 ("g") of the first 20 bytes of sha256("pkgPath:" + path), the
 * same as chain.PackageAddress in Gno. tests/node/gno-address.test.ts pins it against values the chain produced.
 */
import { bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";

export function realmAddress(pkgPath: string): string {
  const digest = sha256(new TextEncoder().encode(`pkgPath:${pkgPath}`));
  return bech32.encode("g", bech32.toWords(digest.slice(0, 20)));
}
