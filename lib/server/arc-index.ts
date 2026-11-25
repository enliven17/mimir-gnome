/**
 * Server-side reads of the market index in Convex (convex/arc.ts: every chain), for routes and
 * the Telegram bot. Plain HTTP queries; null client when Convex is not configured.
 */
import { ConvexHttpClient } from "convex/browser";

import { api } from "@/convex/_generated/api";
import type { MarketChainId } from "@/lib/chains/registry";
import { chainMarketDetail, chainMarketList } from "./chain-markets";

let client: ConvexHttpClient | null | undefined;

/** NEXT_PUBLIC_CONVEX_OFF=1: Convex is down (quota): markets come from the chain, the rest reads as empty. */
const OFF = process.env.NEXT_PUBLIC_CONVEX_OFF === "1";

function convex(): ConvexHttpClient | null {
  if (OFF) return null;
  if (client === undefined) {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
    client = url ? new ConvexHttpClient(url) : null;
  }
  return client;
}

/** Every position a gno.land account holds, each with its market. */
export async function arcPositions(arcAccount: string) {
  const c = convex();
  if (OFF) return [];
  if (!c) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  return c.query(api.arc.positionsOf, { user: arcAccount });
}

/** VS markets the given gno.land addresses challenged, in the given statuses, each with its positions. */
export async function arcChallengedBy(wallets: string[], statuses: string[], limit: number) {
  const c = convex();
  if (OFF) return [];
  if (!c) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  return c.query(api.arcViews.challengedBy, { wallets: wallets.map((w) => w.toLowerCase()), statuses, limit });
}

/** The council's gno.land accounts (slug → address), from the Convex view. */
export async function arcCouncilWallets(): Promise<Map<string, string>> {
  const c = convex();
  if (!c) return new Map();
  const rows = await c.query(api.arcViews.council, {});
  return new Map(rows.map((r) => [r.slug, r.address.toLowerCase()]));
}

export async function arcVolumeByUser(): Promise<Array<{ user: string; usdc: number }>> {
  const c = convex();
  if (!c) return [];
  return c.query(api.arcViews.volumeByUser, {});
}

/** Public markets, newest first, on one chain or all. */
export async function arcMarketList(kind?: "vs" | "pool", chain?: MarketChainId) {
  const c = convex();
  if (!c) return chainMarketList(kind, chain);
  // Convex failing (quota, outage): the chain still has every market.
  return c.query(api.arc.markets, { kind, chain, limit: 500 }).catch(() => chainMarketList(kind, chain));
}

/** One market with its positions, events and verdict. */
export async function arcMarketDetail(kind: "vs" | "pool", marketId: number, chain: MarketChainId = "gno") {
  const c = convex();
  if (!c) return chainMarketDetail(kind, marketId, chain);
  return c.query(api.arc.market, { chain, kind, marketId }).catch(() => chainMarketDetail(kind, marketId, chain));
}
