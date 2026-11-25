/**
 * Mimir API: anyone may call a launched agent (or a council persona) after paying the agent's own gno.land account in
 * mUSD through r/agentpay. The caller asks for a quote, which carries a fresh private `secret` and
 * `callId = hex(sha256(secret))` (lib/gno/payments.ts); approves r/agentpay on mUSD and calls
 * `Pay(agent, units, callId)` in ONE transaction (lib/gno/msgs.ts agentPayMessages); then sends
 * `X-Mimir-Payment: gno:<tx>:<secret>`. The payment is read from the committed transaction's Paid event, never from
 * what the caller claims: only a Paid event emitted by the configured r/agentpay realm, naming this agent and the
 * secret's callId, counts. The secret never touches the chain, so a public tx hash buys nothing for anyone else
 * (commit-reveal), and r/agentpay keeps call ids per payer, so one quote is paid once. Each tx buys one call
 * (convex/agentApiDb.ts claim). Pure where it can be, so the checks run in tests.
 */
import { GNO, type GnoConfig } from "../gno/config";
import { agentCallPaid, callIdFor, isCallSecret, newCallSecret, type PaymentCheck } from "../gno/payments";
import { normalizeTxHash, type GnoTx } from "../gno/tx";

export { callIdFor };

export type PayChain = "gno";
export const PAY_HEADER = "x-mimir-payment";
/** A payment older than this does not buy a call. */
export const PAY_MAX_AGE_MS = 60 * 60_000;
/** Rounding headroom between the quote and the check: 5% below the quoted amount still passes. */
const SLACK_BPS = 9_500n;

export const callPriceUsd = (raw = process.env.AGENT_API_PRICE_USD): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0.05;
};

/** mUSD units (6 dp) owed for one call, rounded up. */
export function priceUnits(usd: number): bigint {
  return BigInt(Math.ceil(usd * 1e6));
}

export const minUnits = (usd: number) => (priceUnits(usd) * SLACK_BPS) / 10_000n;

const human = (units: bigint) => {
  const s = units.toString().padStart(7, "0");
  const frac = s.slice(-6).replace(/0+$/, "");
  return `${s.slice(0, -6)}${frac ? `.${frac}` : ""}`;
};

/** A fresh private secret and its callId for one quote. */
export function newAgentCall(): { secret: string; callId: string } {
  const secret = newCallSecret();
  return { secret, callId: callIdFor(secret) };
}

export interface Offer {
  chain: PayChain;
  asset: "mUSD";
  amount: string;
  units: string;
  decimals: 6;
  /** The r/agentpay realm to Approve and call Pay on. */
  payTo: string;
  /** The agent's account the mUSD goes to. */
  agent: string;
  callId: string;
  secret: string;
}

/** The offer for an agent account, or none when it has no account. */
export function quote(usd: number, agent: string | null | undefined, call = newAgentCall(), cfg: GnoConfig = GNO): Offer[] {
  if (!agent) return [];
  const units = priceUnits(usd);
  return [{ chain: "gno", asset: "mUSD", amount: human(units), units: units.toString(), decimals: 6, payTo: cfg.realms.agentpay, agent, callId: call.callId, secret: call.secret }];
}

/** `gno:<tx>:<secret>`: the tx hash (hex, 0x optional) and the quote's 64-hex secret. Null for anything else. */
export function parsePayment(raw: string | null): { chain: PayChain; tx: string; secret: string } | null {
  const m = /^gno:([^\s:]+):(\S+)$/i.exec(raw?.trim() ?? "");
  if (!m) return null;
  const tx = normalizeTxHash(m[1]);
  const secret = m[2].toLowerCase();
  return tx && isCallSecret(secret) ? { chain: "gno", tx, secret } : null;
}

export type Paid = { ok: true; units: bigint } | { ok: false; error: string };

/**
 * What r/agentpay paid `agent` for `callId` in the transaction, at least `min` units, within the last hour (the
 * block's time, `blockTime` in unix seconds).
 */
export function verifyAgentPayment(tx: GnoTx | null, a: { agentpay: string; agent: string; callId: string; min: bigint; blockTime: number | null; now?: number }): Paid {
  if (!tx) return { ok: false, error: "Transaction not found yet. Try again in a few seconds." };
  if (a.blockTime === null || (a.now ?? Date.now()) - a.blockTime * 1000 > PAY_MAX_AGE_MS) return { ok: false, error: "That payment is older than an hour." };
  const r: PaymentCheck = agentCallPaid(tx, a);
  return r.ok ? { ok: true, units: r.units } : { ok: false, error: r.error };
}
