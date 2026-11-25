/**
 * Mimir Launch copy staking, the pure part. A follower copies an agent's (or a council persona's) market stakes from a
 * copy wallet of their own (a gno.land key Mimir generated and keeps sealed, lib/server/gno-wallets.ts): when the agent
 * stakes on a pool, each active follower stakes the same side, capped by their max per stake. Gas is GNOT, so no mUSD
 * is held back for it; a wallet without GNOT counts as empty. Mimir's fee is the realms' own (the copy/referrer fee),
 * nothing more. The fan-out is lib/launch/arc-copy.ts; one follower's job is runArcCopy (convex/launchCopyJobs.ts).
 */
import type { Log } from "./log";

/** mUSD left in a copy wallet: none, gas is paid in GNOT. */
export const COPY_GAS_RESERVE_USDC = 0;

export type JobStatus = "done" | "failed" | "unknown" | "skipped";

const short = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/** A racing request's fresh wallet never replaces the stored one (its address and sealed key win). */
export function keepStoredWallet<T extends { address: string; sealed: string }>(stored: T | undefined, next: T | undefined): T | undefined {
  return stored && next ? { ...next, sealed: stored.sealed, address: stored.address } : (stored ?? next);
}

/** One follower's copy wallet: `agent` is the copy key, which with the follower scopes the sealed key. */
export type ArcSubRow = { id: string; agent: string; follower: string; sealed: string; wallet: string; maxPerStakeUsdc: number; active: boolean; on: boolean };

/** The stake each follower places: its cap, within its balance minus the reserve, in cents; 0 = skip. */
export function arcCopyAmount(capUsdc: number, balanceUsdc: number, minStakeUsdc: number): number {
  const amount = Math.floor(Math.min(capUsdc, balanceUsdc - COPY_GAS_RESERVE_USDC) * 100) / 100;
  return amount >= minStakeUsdc ? amount : 0;
}

export type ArcCopyDeps = {
  store: {
    /** Takes the job's key once; false = it already ran (or is running): do nothing. */
    claim(key: string, sub: string): Promise<boolean>;
    finish(key: string, status: JobStatus, note?: string): Promise<void>;
    arcSub(subId: string): Promise<ArcSubRow | null>;
  };
  balanceUsdc(wallet: string): Promise<number>;
  /** Stakes `amountUsdc` on pool `marketId`, side `side`, from the subscription's copy wallet; returns the tx hash. */
  stake(a: { sub: ArcSubRow; marketId: number; side: number; amountUsdc: number }): Promise<string>;
  log: Log;
  minStakeUsdc: number;
};

/**
 * One follower's copy of an agent's pool stake. Never retried: a transaction that timed out may still land, so an
 * error is "unknown" (the stake shows up in the index under the copy wallet if it did).
 */
export async function runArcCopy(d: ArcCopyDeps, job: { key: string; sub: string; marketId: number; side: number }): Promise<JobStatus> {
  if (!(await d.store.claim(job.key, job.sub))) return "skipped";
  const done = async (status: JobStatus, note?: string) => (await d.store.finish(job.key, status, note), status);
  const s = await d.store.arcSub(job.sub);
  if (!s || !s.active || !s.on) return done("skipped", "not copying");
  let amount: number;
  try {
    amount = arcCopyAmount(s.maxPerStakeUsdc, await d.balanceUsdc(s.wallet), d.minStakeUsdc);
  } catch (err) {
    return done("failed", short(err));
  }
  if (!amount) return done("skipped", "copy wallet short");
  try {
    const tx = await d.stake({ sub: s, marketId: job.marketId, side: job.side, amountUsdc: amount });
    return done("done", tx);
  } catch (err) {
    d.log.warn("copy stake failed", { subId: s.id, marketId: job.marketId, err });
    return done("unknown", short(err));
  }
}
