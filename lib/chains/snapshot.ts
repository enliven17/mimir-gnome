/**
 * Market snapshots read straight from the realms' JSON views (lib/gno/reads.ts): the Convex indexer stores them, and
 * the chain fallback serves them when Convex is off. Realm logic is never re-implemented: the mappers only rename
 * fields and scale mUSD units (6 dp) to index units (18 dp). Pure mappers + thin async readers, so the mapping is
 * tested without a chain (tests/node/chain-snapshot.test.ts).
 */
import { GNO, type GnoConfig } from "../gno/config";
import { poolConfig, poolMarket, poolPosition, vsChallengers, vsClaim, vsConfig, type PoolMarket, type PoolPosition, type VsChallenger, type VsClaim } from "../gno/reads";
import { indexToUsd } from "./amounts";
import type { MarketChainId } from "./registry";
import { settlementTiming as timing } from "./settlement-timing";

export const V3_STATUS = ["open", "active", "resolved", "cancelled", "proposed", "disputed"] as const;
export const POOL_STATUS = ["open", "proposed", "disputed", "resolved"] as const;
/** The pool's outcome for an expired refund (gno/r/pool/pool.gno Unresolvable). */
const UNRESOLVABLE = 4;

const CHAIN: MarketChainId = "gno";
const SCALE = 1_000_000_000_000n;
const idx = (units: number | string | bigint) => BigInt(units) * SCALE;
const lower = (a: string) => a.trim().toLowerCase();
/** The owner's veto is a dispute with no disputer (VetoProposal). */
const vetoed = (status: string, disputer: string) => status === "disputed" && !disputer;

export interface SnapshotPosition {
  chain: MarketChainId;
  kind: "vs" | "pool";
  marketId: number;
  user: string;
  side: number;
  amount: string;
  amountUsd: number;
}

export function vsSnapshot(c: VsClaim, challengers: VsChallenger[], disputeWindow: number, block = 0) {
  const creatorStake = idx(c.creatorStake);
  const totalChallengerStake = idx(c.totalChallengerStake);
  const byUser = new Map<string, bigint>();
  for (const ch of challengers) byUser.set(lower(ch.address), (byUser.get(lower(ch.address)) ?? 0n) + idx(ch.stake));
  const positions: SnapshotPosition[] = [
    { chain: CHAIN, kind: "vs", marketId: c.id, user: lower(c.creator), side: 1, amount: creatorStake.toString(), amountUsd: indexToUsd(creatorStake) },
    ...[...byUser].map(([user, amount]) => ({ chain: CHAIN, kind: "vs" as const, marketId: c.id, user, side: 2, amount: amount.toString(), amountUsd: indexToUsd(amount) })),
  ];
  const status = V3_STATUS[c.state] ?? "open";
  return {
    market: {
      chain: CHAIN,
      kind: "vs" as const,
      marketId: c.id,
      creator: lower(c.creator),
      question: c.question,
      labelA: c.creatorPosition,
      labelB: c.counterPosition,
      resolutionUrl: c.resolutionUrl,
      category: c.category,
      deadline: c.deadline,
      createdAt: c.createdAt,
      status,
      lockAt: c.lockAt,
      settlementCutoff: c.settlementCutoff,
      eligibleA: idx(c.eligibleCreator).toString(),
      eligibleB: idx(c.eligibleChallengers).toString(),
      vetoed: vetoed(status, c.proposal.disputer),
      winner: c.winnerSide,
      summary: c.resolutionSummary,
      stakeA: creatorStake.toString(),
      stakeB: totalChallengerStake.toString(),
      volumeUsd: indexToUsd(creatorStake + totalChallengerStake),
      participants: 1 + byUser.size,
      isPrivate: c.isPrivate,
      ...timing(BigInt(c.deadline), BigInt(c.proposal.proposedAt), BigInt(c.proposal.disputedAt), BigInt(disputeWindow)),
      updatedBlock: block,
    },
    positions,
  };
}

export function poolSnapshot(m: PoolMarket, stakes: { user: string; position: Pick<PoolPosition, "a" | "b"> }[], disputeWindow: number, block = 0) {
  const totalA = idx(m.totalA);
  const totalB = idx(m.totalB);
  const positions: SnapshotPosition[] = [];
  for (const { user, position } of stakes) {
    for (const [side, units] of [[1, position.a], [2, position.b]] as const) {
      const amount = idx(units);
      if (amount > 0n) positions.push({ chain: CHAIN, kind: "pool", marketId: m.id, user: lower(user), side, amount: amount.toString(), amountUsd: indexToUsd(amount) });
    }
  }
  const status = m.state === 3 && m.outcome === UNRESOLVABLE ? ("cancelled" as const) : (POOL_STATUS[m.state] ?? "open");
  return {
    market: {
      chain: CHAIN,
      kind: "pool" as const,
      marketId: m.id,
      creator: lower(m.creator),
      question: m.question,
      labelA: m.labelA,
      labelB: m.labelB,
      resolutionUrl: m.resolutionUrl,
      category: m.category,
      deadline: m.deadline,
      createdAt: m.createdAt,
      // An expired refund resolves the market as unresolvable (outcome 4): shown as cancelled.
      status,
      winner: m.outcome,
      lockAt: m.lockAt,
      settlementCutoff: m.settlementCutoff,
      eligibleA: idx(m.eligibleA).toString(),
      eligibleB: idx(m.eligibleB).toString(),
      vetoed: vetoed(status, m.disputer),
      summary: m.summary,
      stakeA: totalA.toString(),
      stakeB: totalB.toString(),
      volumeUsd: indexToUsd(totalA + totalB),
      participants: m.participants,
      isPrivate: false,
      ...timing(BigInt(m.deadline), BigInt(m.proposedAt), BigInt(m.disputedAt), BigInt(disputeWindow)),
      updatedBlock: block,
    },
    positions,
  };
}

/** One VS claim with its challengers. `disputeWindow` defaults to the realm's. */
export async function readVs(id: number, opts: { block?: number; disputeWindow?: number; cfg?: GnoConfig } = {}) {
  const cfg = opts.cfg ?? GNO;
  const [c, challengers, window] = await Promise.all([
    vsClaim(id, cfg),
    vsChallengers(id, cfg),
    opts.disputeWindow ?? vsConfig(cfg).then((x) => x.disputeWindow),
  ]);
  return vsSnapshot(c, challengers ?? [], window, opts.block);
}

/** One pool market with the positions of `users` (the realm cannot enumerate stakers). */
export async function readPool(id: number, users: string[], opts: { block?: number; disputeWindow?: number; cfg?: GnoConfig } = {}) {
  const cfg = opts.cfg ?? GNO;
  const [m, window] = await Promise.all([poolMarket(id, cfg), opts.disputeWindow ?? poolConfig(cfg).then((x) => x.disputeWindow)]);
  const stakes = await Promise.all(users.map(async (user) => ({ user, position: await poolPosition(id, user, cfg) })));
  return poolSnapshot(m, stakes, window, opts.block);
}
