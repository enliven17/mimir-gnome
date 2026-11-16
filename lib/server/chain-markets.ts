/**
 * The market index read straight from the contracts, for when Convex is off or failing (lib/server/arc-index.ts).
 * Same row shape as convex/arc.ts `markets` / `market`, built by the indexer's own readers (lib/chains/snapshot.ts).
 * ponytail: no positions, events or verdicts (they need a full log scan); participants stay 0. Fine for a few hundred
 * markets; a bigger count wants a real index again.
 */
import { createPublicClient } from "viem";

import { chainTransport, viemChainOf } from "@/lib/chains/client";
import { POOL_ABI, V3_ABI } from "@/lib/chains/indexer";
import { MARKET_CHAINS, type MarketChain, type MarketChainId } from "@/lib/chains/registry";
import { readPool, readVs, type Client } from "@/lib/chains/snapshot";

type Kind = "vs" | "pool";
type Row = Awaited<ReturnType<typeof readPool>>["market"] | Awaited<ReturnType<typeof readVs>>["market"];

const TTL_MS = 30_000;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
let cache: { at: number; rows: Row[] } | null = null;

async function readChain(c: MarketChain): Promise<Row[]> {
  // Multicall3 (same address on Base and Arc): a few RPC requests instead of six per market, which public RPCs throttle.
  const chain = { ...viemChainOf(c), contracts: { multicall3: { address: MULTICALL3 } } };
  const client = createPublicClient({ chain, transport: chainTransport(c), batch: { multicall: { batchSize: 4096 } } }) as unknown as Client;
  const { mimirV3, mimirPool } = c.contracts;
  const block = Number(await client.getBlockNumber());
  const rows: Row[] = [];
  if (mimirPool) {
    const [count, window] = await Promise.all([
      client.readContract({ address: mimirPool, abi: POOL_ABI, functionName: "marketCount" }),
      client.readContract({ address: mimirPool, abi: POOL_ABI, functionName: "disputeWindow" }),
    ]);
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
    rows.push(...(await Promise.all(ids.map((id) => readPool(c, client, mimirPool, id, [], block, window)))).map((s) => s.market));
  }
  if (mimirV3) {
    const [count, window] = await Promise.all([
      client.readContract({ address: mimirV3, abi: V3_ABI, functionName: "claimCount" }),
      client.readContract({ address: mimirV3, abi: V3_ABI, functionName: "disputeWindow" }),
    ]);
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
    rows.push(...(await Promise.all(ids.map((id) => readVs(c, client, mimirV3, id, block, window)))).map((s) => s.market));
  }
  return rows;
}

async function allRows(): Promise<Row[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const chains = MARKET_CHAINS.enabled.map((id) => MARKET_CHAINS.chains[id]);
  const rows = (await Promise.all(chains.map(readChain))).flat().sort((a, b) => b.createdAt - a.createdAt);
  cache = { at: Date.now(), rows };
  return rows;
}

/** Public markets, newest first, like convex/arc.ts `markets`. */
export async function chainMarketList(kind?: Kind, chain?: MarketChainId, limit = 500) {
  const rows = await allRows();
  return rows.filter((m) => !m.isPrivate && (!kind || m.kind === kind) && (!chain || m.chain === chain)).slice(0, Math.min(limit, 500));
}

/** One market like convex/arc.ts `market`, without positions, events or a verdict. */
export async function chainMarketDetail(kind: Kind, marketId: number, chain: MarketChainId) {
  const m = (await allRows()).find((r) => r.kind === kind && r.marketId === marketId && r.chain === chain);
  return m ? { ...m, positions: [], events: [], verdict: null, feesCollected: "0", linked: [] } : null;
}
