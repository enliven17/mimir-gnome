/**
 * Payments read from committed gno.land transactions (lib/gno/tx.ts). Pure over the parsed transaction, so the rules
 * are tested with fixtures; the callers fetch the transaction.
 *
 *   mUSD transfer   a GRC20 Transfer event emitted by the mUSD realm (from, to, value in mUSD units, 6 dp)
 *   agent call      an r/agentpay Paid event (callId, agent, payer, amount): callId = hex(sha256(secret)), where the
 *                   secret is the quote's 64-hex-character string hashed as UTF-8 text (`printf %s <secret> | sha256sum`)
 */
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha256";

import type { GnoTx } from "./tx";

export type PaymentCheck = { ok: true; units: bigint; payer: string } | { ok: false; error: string };

const lower = (s: string | undefined) => (s ?? "").trim().toLowerCase();
const units = (v: string | undefined) => (/^\d+$/.test(v ?? "") ? BigInt(v as string) : 0n);
const human = (u: bigint) => {
  const s = u.toString().padStart(7, "0");
  const frac = s.slice(-6).replace(/0+$/, "");
  return `${s.slice(0, -6)}${frac ? `.${frac}` : ""}`;
};

/** A fresh quote secret (32 random bytes as hex). */
export function newCallSecret(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** The call id a Paid event must carry for `secret`. */
export const callIdFor = (secret: string): string => bytesToHex(sha256(new TextEncoder().encode(secret.trim().toLowerCase())));

export const isCallSecret = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/**
 * mUSD sent to `to` in `tx` by any of `from` (empty = anyone), at least `min` units. Only Transfer events emitted by
 * the mUSD realm count, so a look-alike token's event pays nothing.
 */
export function musdTransferPaid(tx: GnoTx, a: { musd: string; to: string; from?: string[]; min: bigint }): PaymentCheck {
  if (!tx.ok) return { ok: false, error: "That transaction failed on chain." };
  const to = lower(a.to);
  const from = new Set((a.from ?? []).map(lower).filter(Boolean));
  let got = 0n;
  let payer = "";
  for (const e of tx.events) {
    if (e.pkgPath !== a.musd || e.type !== "Transfer" || lower(e.attrs.to) !== to) continue;
    if (from.size && !from.has(lower(e.attrs.from))) continue;
    got += units(e.attrs.value);
    payer ||= lower(e.attrs.from);
  }
  if (got === 0n) return { ok: false, error: "The transaction has no mUSD transfer to the fee recipient from your wallet." };
  return got >= a.min ? { ok: true, units: got, payer } : { ok: false, error: `It paid ${human(got)} mUSD; ${human(a.min)} is due.` };
}

/** What r/agentpay paid `agent` for `callId` in `tx`, at least `min` units. */
export function agentCallPaid(tx: GnoTx, a: { agentpay: string; agent: string; callId: string; min: bigint }): PaymentCheck {
  if (!tx.ok) return { ok: false, error: "That transaction failed on chain." };
  const agent = lower(a.agent);
  const callId = lower(a.callId);
  let got = 0n;
  let payer = "";
  for (const e of tx.events) {
    if (e.pkgPath !== a.agentpay || e.type !== "Paid" || lower(e.attrs.callId) !== callId || lower(e.attrs.agent) !== agent) continue;
    got += units(e.attrs.amount);
    payer ||= lower(e.attrs.payer);
  }
  if (got === 0n) return { ok: false, error: "The transaction has no agentpay payment to this agent for that secret." };
  return got >= a.min ? { ok: true, units: got, payer } : { ok: false, error: `The agent was paid ${human(got)} mUSD; one call needs ${human(a.min)}.` };
}
