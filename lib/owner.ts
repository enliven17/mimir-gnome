/**
 * Who owns a Mimir account: a gno.land address (g1…). The connected Adena account is the user's identity: it signs
 * readable statements with SignArbitrary (ADR-036), and the signature string passed around the app is
 * JSON.stringify(SignedArbitraryData) (lib/gno/adena.ts signStatement).
 *
 * Verification is offline (@adena-wallet/sdk verifyArbitrarySignature): the public key must derive the claimed
 * address, the signed document must be the canonical one for exactly this message on Mimir's chain, and the
 * secp256k1 signature must hold.
 */
import { verifyArbitrarySignature, type SignedArbitraryData } from "@adena-wallet/sdk";

import { GNO, isGnoAddress } from "./gno/config";

/** A lowercase g1 address, or null. */
export function normalizeOwner(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return isGnoAddress(v) ? v : null;
}

/** At most a few KB: Adena signs at most 4096 bytes of data, the proof around it is small. */
const MAX_SIGNATURE_CHARS = 16_384;

export async function verifyOwnerSignature(args: { address: string; message: string; signature: string }, chainId: string = GNO.chainId): Promise<boolean> {
  const owner = normalizeOwner(args.address);
  if (!owner || typeof args.signature !== "string" || typeof args.message !== "string" || args.signature.length > MAX_SIGNATURE_CHARS) return false;
  let proof: unknown;
  try {
    proof = JSON.parse(args.signature);
  } catch {
    return false;
  }
  if (!proof || typeof proof !== "object") return false;
  return verifyArbitrarySignature(proof as SignedArbitraryData, { signer: owner, chainId, data: args.message });
}
