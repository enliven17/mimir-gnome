/**
 * Mimir's own gno.land accounts (public addresses only; their mnemonics stay in server env, lib/gno/signer.ts):
 *
 *   house creator   GNO_CREATOR_ADDRESS    g1…
 *   council         GNO_COUNCIL_WALLETS    {"<slug>": "g1…"}
 *   oracle          ORACLE_MNEMONIC        the BIP-39 mnemonic of the realms' oracle role (gnokey derivation)
 *
 * Every account pays gas in GNOT: keep each funded with a little GNOT and mUSD.
 */
import { isGnoAddress } from "../gno/config";

type Env = Record<string, string | undefined>;

function json<T>(raw: string | undefined): T | null {
  try {
    return JSON.parse(raw ?? "null") as T;
  } catch {
    return null;
  }
}

const addressOf = (v: unknown): string | null => (isGnoAddress(v) ? v.trim().toLowerCase() : null);

export function houseCreatorWallet(env: Env = process.env): { address: string } | null {
  const address = addressOf(env.GNO_CREATOR_ADDRESS);
  return address ? { address } : null;
}

/** The council's addresses by persona slug; malformed entries are dropped. */
export function councilWallets(env: Env = process.env): Record<string, { address: string }> {
  const raw = json<Record<string, unknown>>(env.GNO_COUNCIL_WALLETS) ?? {};
  const out: Record<string, { address: string }> = {};
  for (const [slug, v] of Object.entries(raw)) {
    const address = addressOf(v);
    if (address) out[slug] = { address };
  }
  return out;
}

/** Every address Mimir's agents stake from (lowercase): the oracle holds markets they are in to firm verdicts. */
export function houseAddresses(env: Env = process.env): string[] {
  const out: string[] = [];
  const creator = houseCreatorWallet(env);
  if (creator) out.push(creator.address);
  for (const w of Object.values(councilWallets(env))) out.push(w.address);
  return out;
}

const MNEMONIC = /^[a-z]+( [a-z]+){11}( [a-z]+){0,12}$/;

/** The oracle's mnemonic (12 to 24 lowercase words), or null. */
export function oracleKey(env: Env = process.env): string | null {
  const raw = env.ORACLE_MNEMONIC?.trim().replace(/\s+/g, " ") ?? "";
  return MNEMONIC.test(raw) ? raw : null;
}

/** What is misconfigured, for the watchdog and the admin panel. */
export function oracleKeyWarnings(env: Env = process.env): string[] {
  const out: string[] = [];
  for (const old of ["ORACLE_KEY", "ARC_ORACLE_KEY", "BASE_ORACLE_KEY"]) {
    if (env[old]?.trim()) out.push(`${old} is an EVM key and is no longer read: remove it (the oracle signs with ORACLE_MNEMONIC)`);
  }
  if (env.ORACLE_MNEMONIC?.trim() && !oracleKey(env)) out.push("ORACLE_MNEMONIC is not a 12 to 24 word mnemonic");
  return out;
}

/** The UTC day a house spend belongs to ("2026-11-01"). */
export const budgetDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Whether a spend of `wei` fits today's house budget, given everything the house creator already put on markets today. */
export const fitsBudget = (budgetWei: bigint, spentWei: bigint, wei: bigint): boolean => wei > 0n && spentWei + wei <= budgetWei;
