// Market snapshots read straight from the contracts: the Convex indexer (convex/arcSync.ts) stores them, and the
// chain fallback (lib/server/chain-markets.ts) serves them when Convex is off. Contract logic is never re-implemented.
import type { createPublicClient } from "viem";
import type { MarketChain } from "./registry";
import { indexToUsd, toIndexUnits } from "./amounts";
import { lower, POOL_ABI, V3_ABI, ZERO_ADDRESS } from "./indexer";
import { settlementTiming as timing } from "./settlement-timing";

export const V3_STATUS = ["open", "active", "resolved", "cancelled", "proposed", "disputed"] as const;
export const POOL_STATUS = ["open", "proposed", "disputed", "resolved"] as const;
/** The owner's veto is a dispute with no disputer (vetoProposal). */
const vetoed = (status: string, disputer: string) => status === "disputed" && lower(disputer) === ZERO_ADDRESS;

export type Client = ReturnType<typeof createPublicClient>;

/** The chain's raw on-chain amount (wei on Arc, 6-dp units on Base) in index units. */
const idx = (cfg: Pick<MarketChain, "usdc">, raw: bigint) => toIndexUnits(cfg, raw);

export async function readVs(chain: Pick<MarketChain, "id" | "usdc">, client: Client, address: `0x${string}`, id: bigint, block: number, window: bigint) {
  const [c, cfg, list, proposal, lock, cutoff, eligible] = await Promise.all([
    client.readContract({ address, abi: V3_ABI, functionName: "getClaim", args: [id] }),
    client.readContract({ address, abi: V3_ABI, functionName: "getClaimMarketConfig", args: [id] }),
    client.readContract({ address, abi: V3_ABI, functionName: "getChallengerList", args: [id] }),
    client.readContract({ address, abi: V3_ABI, functionName: "proposals", args: [id] }),
    client.readContract({ address, abi: V3_ABI, functionName: "lockAt", args: [id] }).catch(() => 0n), // contracts before the cutover have no lockAt
    client.readContract({ address, abi: V3_ABI, functionName: "settlementCutoff", args: [id] }),
    client.readContract({ address, abi: V3_ABI, functionName: "eligibleTotals", args: [id] }),
  ]);
  const [creator, question, creatorPosition, counterPosition, resolutionUrl, rawCreatorStake, rawChallengerStake, , deadline, state, winnerSide, summary, , category, , , createdAt] = c;
  const creatorStake = idx(chain, rawCreatorStake);
  const totalChallengerStake = idx(chain, rawChallengerStake);
  const byUser = new Map<string, bigint>();
  list[0].forEach((a, i) => byUser.set(lower(a), (byUser.get(lower(a)) ?? 0n) + idx(chain, list[1][i])));
  const positions = [
    { chain: chain.id, kind: "vs" as const, marketId: Number(id), user: lower(creator), side: 1, amount: creatorStake.toString(), amountUsd: indexToUsd(creatorStake) },
    ...[...byUser].map(([user, amount]) => ({ chain: chain.id, kind: "vs" as const, marketId: Number(id), user, side: 2, amount: amount.toString(), amountUsd: indexToUsd(amount) })),
  ];
  return {
    market: {
      chain: chain.id,
      kind: "vs" as const,
      marketId: Number(id),
      creator: lower(creator),
      question,
      labelA: creatorPosition,
      labelB: counterPosition,
      resolutionUrl,
      category,
      deadline: Number(deadline),
      createdAt: Number(createdAt),
      status: V3_STATUS[state] ?? "open",
      lockAt: Number(lock),
      settlementCutoff: Number(cutoff),
      eligibleA: idx(chain, eligible[0]).toString(),
      eligibleB: idx(chain, eligible[1]).toString(),
      vetoed: vetoed(V3_STATUS[state] ?? "open", proposal[4]),
      winner: winnerSide,
      summary,
      stakeA: creatorStake.toString(),
      stakeB: totalChallengerStake.toString(),
      volumeUsd: indexToUsd(creatorStake + totalChallengerStake),
      participants: 1 + byUser.size,
      isPrivate: cfg[6],
      ...timing(deadline, BigInt(proposal[2]), BigInt(proposal[3]), window),
      updatedBlock: block,
    },
    positions,
  };
}

export async function readPool(cfg: Pick<MarketChain, "id" | "usdc">, client: Client, address: `0x${string}`, id: bigint, users: string[], block: number, window: bigint) {
  const [m, text, proposal, lock, cutoff, eligible] = await Promise.all([
    client.readContract({ address, abi: POOL_ABI, functionName: "getMarket", args: [id] }),
    client.readContract({ address, abi: POOL_ABI, functionName: "getMarketText", args: [id] }),
    client.readContract({ address, abi: POOL_ABI, functionName: "getProposal", args: [id] }),
    client.readContract({ address, abi: POOL_ABI, functionName: "lockAt", args: [id] }).catch(() => 0n), // contracts before the cutover have no lockAt
    client.readContract({ address, abi: POOL_ABI, functionName: "settlementCutoff", args: [id] }),
    client.readContract({ address, abi: POOL_ABI, functionName: "eligibleTotals", args: [id] }),
  ]);
  const [creator, deadline, createdAt, state, outcome, rawA, rawB] = m;
  const totalA = idx(cfg, rawA);
  const totalB = idx(cfg, rawB);
  const [question, labelA, labelB, resolutionUrl, category, summary] = text;
  const positions = [];
  for (const u of users) {
    const [onA, onB] = await client.readContract({ address, abi: POOL_ABI, functionName: "stakeOf", args: [id, u as `0x${string}`] });
    for (const [side, raw] of [[1, onA], [2, onB]] as const) {
      const amount = idx(cfg, raw);
      if (amount > 0n) positions.push({ chain: cfg.id, kind: "pool" as const, marketId: Number(id), user: lower(u), side, amount: amount.toString(), amountUsd: indexToUsd(amount) });
    }
  }
  return {
    market: {
      chain: cfg.id,
      kind: "pool" as const,
      marketId: Number(id),
      creator: lower(creator),
      question,
      labelA,
      labelB,
      resolutionUrl,
      category,
      deadline: Number(deadline),
      createdAt: Number(createdAt),
      // An expired refund resolves the market as unresolvable (outcome 4): shown as cancelled.
      status: state === 3 && outcome === 4 ? ("cancelled" as const) : (POOL_STATUS[state] ?? "open"),
      winner: outcome,
      lockAt: Number(lock),
      settlementCutoff: Number(cutoff),
      eligibleA: idx(cfg, eligible[0]).toString(),
      eligibleB: idx(cfg, eligible[1]).toString(),
      vetoed: vetoed(POOL_STATUS[state] ?? "open", proposal[3]),
      summary,
      stakeA: totalA.toString(),
      stakeB: totalB.toString(),
      volumeUsd: indexToUsd(totalA + totalB),
      // ponytail: participants is filled from the positions table in arc.apply (no on-chain count for pools).
      participants: 0,
      isPrivate: false,
      ...timing(deadline, proposal[1], proposal[2], window),
      updatedBlock: block,
    },
    positions,
  };
}

