/**
 * Mimir's own gno.land accounts (public addresses only; their mnemonics stay in server env, lib/gno/signer.ts):
 *
 *   house creator   GNO_CREATOR_ADDRESS    g1…                      (public: what the UI and the views show)
 *                   GNO_CREATOR_MNEMONIC   its key                  (Convex only: the creator opens and stakes)
 *   council         GNO_COUNCIL_WALLETS    {"<slug>": "g1…"}
 *                   GNO_COUNCIL_MNEMONICS  {"<slug>": "<mnemonic>"} (Convex only: the personas stake)
 *   oracle          ORACLE_MNEMONIC        the BIP-39 mnemonic of the realms' oracle role (gnokey derivation)
 *   audit agent     AUDIT_AGENT_MNEMONIC   the realms' audit agent (agents/audit), may dispute any proposal
 *
 * Where both an address and a mnemonic are set they must agree (houseKeyWarnings); with only a mnemonic, the address
 * is derived from it.
 *
 * Every account pays gas in GNOT: keep each funded with a little GNOT and mUSD.
 */
import { isGnoAddress } from "../gno/config";
import { addressFromMnemonic } from "../gno/keys";

type Env = Record<string, string | undefined>;

function json<T>(raw: string | undefined): T | null {
  try {
    return JSON.parse(raw ?? "null") as T;
  } catch {
    return null;
  }
}

const addressOf = (v: unknown): string | null => (isGnoAddress(v) ? v.trim().toLowerCase() : null);

const MNEMONIC = /^[a-z]+( [a-z]+){11}( [a-z]+){0,12}$/;
const mnemonicOf = (v: unknown): string | null => {
  const m = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return MNEMONIC.test(m) ? m : null;
};

// Deriving runs PBKDF2: once per mnemonic per process.
const derived = new Map<string, string | null>();
/** The g1 address of a mnemonic, or null when it is not a valid one. */
export function mnemonicAddress(mnemonic: string): string | null {
  if (!derived.has(mnemonic)) {
    let a: string | null = null;
    try {
      a = addressFromMnemonic(mnemonic);
    } catch {
      a = null;
    }
    derived.set(mnemonic, a);
  }
  return derived.get(mnemonic) ?? null;
}

export function houseCreatorWallet(env: Env = process.env): { address: string } | null {
  const key = creatorMnemonic(env);
  const address = addressOf(env.GNO_CREATOR_ADDRESS) ?? (key ? mnemonicAddress(key) : null);
  return address ? { address } : null;
}

/** The house creator's mnemonic (GNO_CREATOR_MNEMONIC), or null. */
export const creatorMnemonic = (env: Env = process.env): string | null => mnemonicOf(env.GNO_CREATOR_MNEMONIC);

/** The council personas' mnemonics by slug (GNO_COUNCIL_MNEMONICS); malformed entries are dropped. */
export function councilMnemonics(env: Env = process.env): Record<string, string> {
  const raw = json<Record<string, unknown>>(env.GNO_COUNCIL_MNEMONICS) ?? {};
  const out: Record<string, string> = {};
  for (const [slug, v] of Object.entries(raw)) {
    const m = mnemonicOf(v);
    if (m) out[slug] = m;
  }
  return out;
}

/** The council's addresses by persona slug (GNO_COUNCIL_WALLETS, else derived from GNO_COUNCIL_MNEMONICS). */
export function councilWallets(env: Env = process.env): Record<string, { address: string }> {
  const raw = json<Record<string, unknown>>(env.GNO_COUNCIL_WALLETS) ?? {};
  const out: Record<string, { address: string }> = {};
  for (const [slug, v] of Object.entries(raw)) {
    const address = addressOf(v);
    if (address) out[slug] = { address };
  }
  for (const [slug, m] of Object.entries(councilMnemonics(env))) {
    const address = out[slug] ? null : mnemonicAddress(m);
    if (address) out[slug] = { address };
  }
  return out;
}

/** The oracle's public address (from ORACLE_MNEMONIC), or null. */
export function oracleAddress(env: Env = process.env): string | null {
  const key = oracleKey(env);
  return key ? mnemonicAddress(key) : null;
}

/** The audit agent's mnemonic (AUDIT_AGENT_MNEMONIC), or null. */
export const auditAgentKey = (env: Env = process.env): string | null => mnemonicOf(env.AUDIT_AGENT_MNEMONIC);

/** Address and mnemonic env that disagree, or EVM-era variables still set: what the admin should fix. */
export function houseKeyWarnings(env: Env = process.env): string[] {
  const out: string[] = [];
  const creator = creatorMnemonic(env);
  const creatorAddr = addressOf(env.GNO_CREATOR_ADDRESS);
  if (creator && creatorAddr && mnemonicAddress(creator) !== creatorAddr) out.push("GNO_CREATOR_MNEMONIC does not derive GNO_CREATOR_ADDRESS");
  if (env.GNO_CREATOR_MNEMONIC?.trim() && !creator) out.push("GNO_CREATOR_MNEMONIC is not a 12 to 24 word mnemonic");
  const listed = json<Record<string, unknown>>(env.GNO_COUNCIL_WALLETS) ?? {};
  for (const [slug, m] of Object.entries(councilMnemonics(env))) {
    const a = addressOf(listed[slug]);
    if (a && mnemonicAddress(m) !== a) out.push(`GNO_COUNCIL_MNEMONICS.${slug} does not derive GNO_COUNCIL_WALLETS.${slug}`);
  }
  for (const old of ["ARC_CREATOR_WALLET", "BASE_CREATOR_WALLET", "ARC_COUNCIL_WALLETS", "BASE_COUNCIL_WALLETS", "CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"]) {
    if (env[old]?.trim()) out.push(`${old} is from the EVM deployment and is no longer read: remove it`);
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
