/**
 * Wallets Mimir holds for its agents on gno.land (launch agents, copy wallets) and the market calls they make, plus
 * the same calls from env-configured keys (the house creator, the council). Replaces the Circle custodial wallets:
 *
 *   key       a fresh BIP-39 mnemonic generated here (lib/gno/keys.ts); its address is derived offline
 *   storage   only sealed: AES-256-GCM under GNO_WALLET_SECRET (32+ characters), bound to the wallet's `scope`
 *             (e.g. "launch:<slug>") as associated data, the same scheme as sealed BYOK keys (lib/launch/byok.ts).
 *             A sealed key copied onto another record does not open.
 *   signing   lib/gno/signer.ts: one transaction per action (an mUSD Approve rides in front when the allowance is
 *             short), gas in GNOT from the same wallet.
 *
 * Amounts are index units (18 dp, lib/chains/amounts.ts). Node only (node:crypto); imported with relative paths by
 * the Convex actions.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { gasBalanceUgnot, musdAllowanceWei, musdBalanceWei } from "../chains/client";
import { GNO, type GnoConfig } from "../gno/config";
import { addressFromMnemonic, newMnemonic } from "../gno/keys";
import { actionMessages, pullOf, transferMessage, type MarketAction, type MarketKind, type Side } from "../gno/msgs";
import { gnoSigner, type GnoSigner, type SentTx } from "../gno/signer";

/** What a record stores for a wallet Mimir holds: the public address and the sealed mnemonic. */
export interface SealedWallet {
  address: string;
  /** base64(iv[12] | tag[16] | ciphertext) */
  sealed: string;
}

function masterKey(secret = process.env.GNO_WALLET_SECRET): Buffer {
  const s = secret?.trim();
  if (!s || s.length < 32) throw new Error("GNO_WALLET_SECRET is not set (32+ characters)");
  return createHash("sha256").update(s).digest();
}

const aad = (scope: string) => Buffer.from(`mimir-gno-wallet:${scope}`);

export function sealMnemonic(scope: string, mnemonic: string, secret?: string): SealedWallet {
  const address = addressFromMnemonic(mnemonic);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(secret), iv);
  c.setAAD(aad(scope));
  const ct = Buffer.concat([c.update(mnemonic.trim(), "utf8"), c.final()]);
  return { address, sealed: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64") };
}

/** The mnemonic; throws when the record was tampered with, moved to another scope or the secret changed. */
export function openMnemonic(scope: string, w: SealedWallet, secret?: string): string {
  const raw = Buffer.from(w.sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", masterKey(secret), raw.subarray(0, 12));
  d.setAAD(aad(scope));
  d.setAuthTag(raw.subarray(12, 28));
  const mnemonic = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  if (addressFromMnemonic(mnemonic) !== w.address) throw new Error("sealed wallet does not match its address");
  return mnemonic;
}

/** A new wallet for `scope`, sealed. */
export const newSealedWallet = (scope: string, secret?: string): SealedWallet => sealMnemonic(scope, newMnemonic(), secret);

/** Whether wallets can be created and opened here. */
export function walletsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.GNO_WALLET_SECRET?.trim().length ?? 0) >= 32;
}

/** The signer of a sealed wallet. */
export const sealedSigner = (scope: string, w: SealedWallet, cfg: GnoConfig = GNO): Promise<GnoSigner> => gnoSigner(openMnemonic(scope, w), cfg);

// ── market calls from a signer ────────────────────────────────────────────────

/** One market action, with an exact Approve in front when the allowance is short: one transaction. */
export async function sendAction(s: GnoSigner, action: MarketAction, cfg: GnoConfig = GNO): Promise<SentTx> {
  const kind: MarketKind = action.type === "create" ? action.market.kind : action.type === "stake" ? action.kind : "vs";
  const allowance = pullOf(action) > 0n ? await musdAllowanceWei(s.address, kind, cfg) : 0n;
  return s.send(actionMessages(s.address, action, allowance, cfg));
}

/** Stake `wei` (gross, index units): a VS challenge (side 2) or a pool side. */
export const gnoStake = (s: GnoSigner, a: { kind: MarketKind; marketId: number; side: Side | number; wei: bigint; referrer?: string }, cfg: GnoConfig = GNO) =>
  sendAction(s, { type: "stake", kind: a.kind, marketId: a.marketId, stake: a.wei, side: (a.kind === "vs" ? 2 : a.side) as Side, referrer: a.referrer }, cfg);

export interface PoolDraft {
  question: string;
  labelA: string;
  labelB: string;
  resolutionUrl: string;
  category: string;
  deadline: number;
  side: Side | number;
}

/** The id a create opened, from its MarketCreated / ClaimCreated event; null when absent. */
export function createdMarketId(tx: Pick<SentTx, "events">, kind: MarketKind, cfg: GnoConfig = GNO): number | null {
  const realm = kind === "vs" ? cfg.realms.vs : cfg.realms.pool;
  const name = kind === "vs" ? "ClaimCreated" : "MarketCreated";
  const e = tx.events.find((x) => x.pkgPath === realm && x.type === name);
  const id = Number(e?.attrs.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Open a two-sided pool with a seed stake of `wei` on `side`; returns the tx and the market id. */
export async function gnoCreatePool(s: GnoSigner, d: PoolDraft, wei: bigint, cfg: GnoConfig = GNO): Promise<SentTx & { marketId: number | null }> {
  const tx = await sendAction(s, { type: "create", market: { kind: "pool", ...d, side: d.side as Side, stake: wei } }, cfg);
  return { ...tx, marketId: createdMarketId(tx, "pool", cfg) };
}

/** Cancel an unchallenged VS claim (the stake comes back). */
export const gnoCancelVs = (s: GnoSigner, marketId: number, cfg: GnoConfig = GNO) => sendAction(s, { type: "cancel", marketId }, cfg);

/** Send mUSD (index units, floored to 6 dp) to `to`. */
export function gnoSendMusd(s: GnoSigner, to: string, wei: bigint, cfg: GnoConfig = GNO): Promise<SentTx> {
  const units = (wei / 1_000_000_000_000n) * 1_000_000_000_000n;
  return s.send([transferMessage(s.address, to, units, cfg)]);
}

/** mUSD a wallet holds, index units. */
export const walletMusdWei = (address: string, cfg: GnoConfig = GNO) => musdBalanceWei(address, cfg);

/** GNOT a wallet holds for gas, ugnot. */
export const walletGasUgnot = (address: string, cfg: GnoConfig = GNO) => gasBalanceUgnot(address, cfg);

/** The gas one transaction may burn (lib/gno/config.ts fee), ugnot: below it a wallet cannot send. */
export const MIN_GAS_UGNOT = BigInt(GNO.gas.fee);
