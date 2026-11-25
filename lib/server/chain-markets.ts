/**
 * The market index read straight from the realms, for when Convex is off or failing (lib/server/arc-index.ts).
 * Same row shape as convex/arc.ts `markets` / `market`, built by the indexer's own mappers (lib/chains/snapshot.ts)
 * from the realms' paged JSON views (MarketsJSON, ClaimsJSON).
 * ponytail: no positions, events or verdicts (pool stakers are not enumerable on chain); fine for a few hundred
 * markets.
 */
import { MARKET_CHAINS, type MarketChainId } from "@/lib/chains/registry";
import { readAllMarkets } from "@/lib/chains/snapshot";

type Kind = "vs" | "pool";
type Row = Awaited<ReturnType<typeof readAllMarkets>>["vs"][number] | Awaited<ReturnType<typeof readAllMarkets>>["pool"][number];

const TTL_MS = 30_000;
let cache: { at: number; rows: Row[] } | null = null;

async function allRows(): Promise<Row[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const { vs, pool } = await readAllMarkets({ cfg: MARKET_CHAINS.chains.gno.gno });
  const rows = [...vs, ...pool].sort((a, b) => b.createdAt - a.createdAt);
  cache = { at: Date.now(), rows };
  return rows;
}

/** Public markets, newest first, like convex/arc.ts `markets`. */
export async function chainMarketList(kind?: Kind, chain?: MarketChainId, limit = 500) {
  const rows = await allRows();
  return rows.filter((m) => !m.isPrivate && (!kind || m.kind === kind) && (!chain || m.chain === chain)).slice(0, Math.min(limit, 500));
}

/** One market like convex/arc.ts `market`, without positions, events or a verdict. */
export async function chainMarketDetail(kind: Kind, marketId: number, chain: MarketChainId = "gno") {
  const m = (await allRows()).find((r) => r.kind === kind && r.marketId === marketId && r.chain === chain);
  return m ? { ...m, positions: [], events: [], verdict: null, feesCollected: "0" } : null;
}
