/**
 * Server side of the wallet proof (lib/wallet-proof.ts): the gno.land address a request proves it controls.
 */
import { normalizeOwner, verifyOwnerSignature } from "@/lib/owner";
import { WALLET_PROOF_HEADER, WALLET_HEADER, walletProofMessage, parseProofHeader } from "@/lib/wallet-proof";

/** The wallet a request proves it controls (the signed wallet proof headers), lowercase, or null. */
export async function provenWallet(req: Request): Promise<string | null> {
  const wallet = normalizeOwner(req.headers.get(WALLET_HEADER));
  const proof = parseProofHeader(req.headers.get(WALLET_PROOF_HEADER));
  if (!wallet || !proof) return null;
  const ok = await verifyOwnerSignature({ address: wallet, message: walletProofMessage(wallet, proof.signedAt), signature: proof.signature });
  return ok ? wallet : null;
}
