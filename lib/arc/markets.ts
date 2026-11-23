/**
 * Mimir's markets from the app's side: the quotes the stake UI shows and the live stake limits. Amounts are index
 * units (mUSD, 18 dp off chain; lib/chains/amounts.ts). The transactions themselves are lib/gno/msgs.ts.
 *
 * VS (r/vs, pool odds): the creator stakes X, challengers together may stake up to 5X, and the winning side takes the
 * losing side's stake pro rata. Pool (r/pool): two-sided pari-mutuel, anyone stakes either side.
 * Fees (lib/arc/fees.ts): an entry fee comes off every stake (0.5%) and is kept on refunds; no fee on winnings, except
 * copy trades, which give 1% of the profit to the basket creator and 1% to Mimir.
 */
import { GNO, type GnoConfig } from "../gno/config";
import { fromMusdUnits } from "../gno/msgs";
import { poolConfig, poolMarket, vsClaim, vsConfig } from "../gno/reads";
import { MIN_STAKE_WEI as REALM_MIN_STAKE_WEI } from "../chains/registry";
import { COPY_FEE_BPS, REFERRER_FEE_BPS } from "./fees";

export type ArcMarketKind = "vs" | "pool";

/** Both realms: the minimum (gross) stake, betting closes 60 s before the deadline. */
export const MIN_STAKE_WEI = REALM_MIN_STAKE_WEI;
export const LOCK_SECONDS = 60;
export const MAX_POOL_MULTIPLE = 5n;

export interface StakeLimits {
  /** Net, index units; 0 = no cap. */
  maxMarket: bigint;
  maxAccount: bigint;
  /** Unix seconds betting closed early; 0 = the usual lock. */
  lockAt: number;
  paused: boolean;
}

/** The realm config (caps, pause) and the market (early lock), read live: the index can lag a block or two. Caps in index units. */
export async function readStakeLimits(kind: ArcMarketKind, marketId: number, cfg: GnoConfig = GNO): Promise<StakeLimits> {
  const [c, m] = await Promise.all([
    kind === "vs" ? vsConfig(cfg) : poolConfig(cfg),
    kind === "vs" ? vsClaim(marketId, cfg) : poolMarket(marketId, cfg),
  ]);
  return { maxMarket: fromMusdUnits(c.maxMarketStake), maxAccount: fromMusdUnits(c.maxAccountStake), lockAt: m.lockAt, paused: c.paused };
}



/**
 * Why a stake of `gross` would revert on the pause, the early lock or the caps (CapExceeded); null when it fits.
 * Caps count net stakes. `mine`: your net stake already in this market; a pool caps your total there, VS caps each
 * challenge (the realms check net stakes). `total`: both sides' net stakes now.
 */
export function stakeLimitBlocker(
  l: StakeLimits,
  a: { kind: ArcMarketKind; gross: bigint; entryBps: number; mine: bigint; total: bigint; now: number },
  fmt: (wei: bigint) => string,
): string | null {
  if (l.paused) return "Staking is paused on this market for now. Your funds are safe; refunds stay open.";
  if (l.lockAt !== 0 && a.now >= l.lockAt) return "Betting on this market closed early.";
  const net = a.gross - entryFeeOf(a.gross, a.entryBps);
  if (l.maxMarket !== 0n && a.total + net > l.maxMarket) {
    const room = l.maxMarket > a.total ? maxGrossFor(l.maxMarket - a.total, a.entryBps) : 0n;
    return room > 0n ? `This market is capped during launch: at most ${fmt(room)} more fits.` : "This market has reached its launch cap.";
  }
  const mine = a.kind === "pool" ? a.mine : 0n;
  if (l.maxAccount !== 0n && mine + net > l.maxAccount) {
    const room = l.maxAccount > mine ? maxGrossFor(l.maxAccount - mine, a.entryBps) : 0n;
    return room > 0n ? `Stakes are capped at ${fmt(l.maxAccount)} per account during launch: at most ${fmt(room)} more.` : `You have reached the ${fmt(l.maxAccount)} per-account launch cap here.`;
  }
  return null;
}

export const entryFeeOf = (gross: bigint, entryBps: number) => (gross * BigInt(entryBps)) / 10_000n;
const copyFees = (profit: bigint, copy: boolean) => (copy ? (profit * BigInt(REFERRER_FEE_BPS + COPY_FEE_BPS)) / 10_000n : 0n);

export interface Quote {
  /** What leaves your account. */
  risk: bigint;
  /** The entry fee in it (kept even on a refund). */
  fee: bigint;
  /** Net payout if your side wins. */
  win: bigint;
  /** True when `win` is a ceiling (later stakes on your side can only lower it). */
  atMost: boolean;
}

/**
 * A challenger sending `gross` to a VS market (stakes are net of their entry
 * fee). Challengers split the creator's stake pro rata, so every later
 * challenger shrinks your share: the payout now is the most you can win.
 */
export function vsChallengeQuote(creatorStake: bigint, totalChallengers: bigint, gross: bigint, entryBps: number, copy = false): Quote {
  const fee = entryFeeOf(gross, entryBps);
  const net = gross - fee;
  // The creator risks at most 5x what challengers put in (r/vs settle), so a lone small challenger wins 5x, not the pot.
  const pool = totalChallengers + net;
  const atRisk = creatorStake < pool * MAX_POOL_MULTIPLE ? creatorStake : pool * MAX_POOL_MULTIPLE;
  const profit = pool === 0n ? 0n : (net * atRisk) / pool;
  return { risk: gross, fee, win: net + profit - copyFees(profit, copy), atMost: true };
}

/** Net stake still allowed from challengers (the 5x cap on the creator's net stake). */
export function vsRoom(creatorStake: bigint, totalChallengers: bigint): bigint {
  const cap = creatorStake * MAX_POOL_MULTIPLE;
  return cap > totalChallengers ? cap - totalChallengers : 0n;
}

/** The largest gross amount whose net fits in `room`. */
export const maxGrossFor = (room: bigint, entryBps: number) => (room * 10_000n) / BigInt(10_000 - entryBps);

/** The creator of a VS market: wins whatever challengers stake, at most 5x their own net stake. */
export function vsCreatorQuote(gross: bigint, entryBps: number, copy = false): Quote {
  const fee = entryFeeOf(gross, entryBps);
  const net = gross - fee;
  const profit = net * MAX_POOL_MULTIPLE;
  return { risk: gross, fee, win: net + profit - copyFees(profit, copy), atMost: true };
}

/**
 * Sending `gross` to one side of a two-sided pool, given both sides' totals:
 * what it would return if the market closed now. Later stakes move it both
 * ways (more on the other side raises it), so it is an estimate, not a ceiling.
 */
export function poolQuote(sideTotal: bigint, otherSide: bigint, gross: bigint, entryBps: number, copy = false): Quote {
  const fee = entryFeeOf(gross, entryBps);
  const net = gross - fee;
  const profit = sideTotal + net === 0n ? 0n : (net * otherSide) / (sideTotal + net);
  return { risk: gross, fee, win: net + profit - copyFees(profit, copy), atMost: false };
}

/** "2.5" → index units; null for anything that is not a positive amount with at most 6 decimals (mUSD). */
export function parseUsdc(input: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) return null;
  const wei = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
  return wei > 0n ? wei : null;
}

export const weiToUsd = (wei: bigint | string) => Number(BigInt(wei)) / 1e18;
