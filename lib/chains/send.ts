/**
 * Sending one market action from a wallet the user holds (Adena in the browser):
 *
 *   the allowance already covers the pull (or nothing is pulled) → the call alone;
 *   else → Approve(exact pull) + the call, both in ONE transaction.
 *   Gas is GNOT: with none, it stops before the wallet opens, with a plain message.
 *
 * Pure: the wallet and the chain reads come in as functions (tests/node/chain-send.test.ts).
 */
import { isUserRejection, type TxReceipt } from "../gno/adena";
import { actionMessages, kindOfAction, needsApproval, pullOf, type GnoMsgCall, type MarketAction, type MarketKind } from "../gno/msgs";
import type { MarketChain } from "./registry";

export { isUserRejection };
export type { TxReceipt };

export interface MarketSendDeps {
  /** mUSD allowance owner → the market realm of `kind`, index units. */
  allowance(owner: string, kind: MarketKind): Promise<bigint>;
  /** GNOT balance, ugnot; null when unknown (no check then). */
  gasBalance?(owner: string): Promise<bigint | null>;
  /** Signs and broadcasts the messages as one transaction. */
  send(messages: GnoMsgCall[]): Promise<TxReceipt>;
}

export type SendPath = "allowance" | "approve";

export class NoGasError extends Error {
  constructor(chain: Pick<MarketChain, "gas" | "name">) {
    super(`Your wallet has no ${chain.gas.symbol} on ${chain.name} for gas. Add a little ${chain.gas.symbol}, then try again.`);
  }
}

export async function sendMarketAction(
  chain: Pick<MarketChain, "gas" | "name" | "gno">,
  owner: string,
  action: MarketAction,
  deps: MarketSendDeps,
): Promise<TxReceipt & { path: SendPath }> {
  if (deps.gasBalance) {
    const gas = await deps.gasBalance(owner).catch(() => null);
    if (gas === 0n) throw new NoGasError(chain);
  }
  const allowance = pullOf(action) > 0n ? await deps.allowance(owner, kindOfAction(action)) : 0n;
  const path: SendPath = needsApproval(action, allowance) ? "approve" : "allowance";
  return { ...(await deps.send(actionMessages(owner, action, allowance, chain.gno))), path };
}
