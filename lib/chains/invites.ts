/** Wallet grants are participation rights, not secrets. All authority stays on chain (r/vs SetInvited). */
import { GNO, isGnoAddress, type GnoConfig } from "../gno/config";
import { vsInvited } from "../gno/reads";

export function parseInviteWallets(text: string, creator?: string): string[] {
  const words = text.trim().split(/[\s,;]+/).filter(Boolean);
  if (!words.length) throw new Error("Enter at least one wallet address.");
  const wallets = new Set<string>();
  for (const word of words) {
    const address = word.toLowerCase();
    if (!isGnoAddress(address)) throw new Error(`Invalid gno.land address: ${word}`);
    if (address === creator?.toLowerCase()) throw new Error("Use a participant's wallet, not the creator's.");
    wallets.add(address);
  }
  if (wallets.size > 100) throw new Error("Change up to 100 wallets per transaction.");
  return [...wallets];
}

/** A failed read is an error, never permission. */
export async function readClaimInvitation(marketId: number, wallet: string, cfg: GnoConfig = GNO): Promise<boolean> {
  if (!Number.isSafeInteger(marketId) || marketId <= 0 || !isGnoAddress(wallet)) throw new Error("Invalid invitation lookup.");
  return vsInvited(marketId, wallet, cfg);
}
