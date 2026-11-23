/**
 * Signature verification for agent requests.
 *
 * An agent's owner and operator are gno.land accounts. They sign the UTF-8 request message with Adena SignArbitrary
 * (ADR-036); the signature is the JSON proof, verified offline (lib/owner.ts).
 */
import { normalizeOwner, verifyOwnerSignature } from "../owner";

/** A wallet that can own or operate an agent: a lowercase g1 address, or null. */
export function normalizeWallet(value: unknown): string | null {
  return normalizeOwner(value);
}

/** An ADR-036 SignArbitrary proof of `message` by `address`. */
export async function verifyWalletSignature(args: { address: string; message: string; signature: string }): Promise<boolean> {
  return verifyOwnerSignature(args);
}
