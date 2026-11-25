/**
 * Agent tokens on gno.land: a GRC20 opened through the chain's own factory realm, gno.land/r/demo/defi/grc20factory
 * (it is on onyx-1). The owner's Adena account sends `New(name, symbol, decimals, initialMint, faucet)` and becomes the
 * token's admin (it may Mint later); the factory registers it with r/nt/grc20reg. Symbols are unique in the factory.
 * Pure and isomorphic: the browser builds the message, the server verifies the result.
 */
import type { GnoMsgCall } from "../gno/msgs";
import type { GnoTx } from "../gno/tx";

export const GRC20_FACTORY = "gno.land/r/demo/defi/grc20factory";
export const TOKEN_DECIMALS = 6;

/** The token's id as stored: "<factory>:<symbol>". */
export const factoryTokenId = (symbol: string) => `${GRC20_FACTORY}:${symbol}`;

/** The owner's launch: one MsgCall, nothing minted up front, no faucet. */
export function newTokenMessage(owner: string, name: string, symbol: string): GnoMsgCall {
  return {
    type: "/vm.m_call",
    value: { caller: owner, send: "", max_deposit: "", pkg_path: GRC20_FACTORY, func: "New", args: [name, symbol, String(TOKEN_DECIMALS), "0", "0"] },
  };
}

/** The admin the factory's Render(symbol) names ("**Admin**: g1…"), lowercase; null when absent. */
export function adminFromRender(markdown: string): string | null {
  const m = /\*\*Admin\*\*:\s*(g1[02-9ac-hj-np-z]{38})/i.exec(markdown);
  return m ? m[1].toLowerCase() : null;
}

export type TokenCheck = { ok: true; token: { chain: "gno"; address: string; symbol: string } } | { ok: false; status: number; error: string };

/**
 * The launch, checked from the chain: the tx committed, the factory emitted NewToken for the agent's ticker, and the
 * token's admin (from the factory's own page) is the agent's owner.
 */
export function checkTokenLaunch(tx: GnoTx | null, admin: string | null, a: { owner: string; ticker: string }): TokenCheck {
  if (!tx) return { ok: false, status: 404, error: "Transaction not found yet. Try again in a few seconds." };
  if (!tx.ok) return { ok: false, status: 400, error: "That launch failed on chain." };
  const ev = tx.events.find((e) => e.pkgPath === GRC20_FACTORY && e.type === "NewToken");
  if (!ev) return { ok: false, status: 400, error: "That transaction is not a GRC20 factory launch." };
  if ((ev.attrs.symbol ?? "").toUpperCase() !== a.ticker.toUpperCase()) return { ok: false, status: 400, error: `That token is not $${a.ticker}.` };
  if (!admin || admin !== a.owner.toLowerCase()) return { ok: false, status: 403, error: "The token's admin is not the agent owner." };
  return { ok: true, token: { chain: "gno", address: factoryTokenId(ev.attrs.symbol), symbol: ev.attrs.symbol } };
}
