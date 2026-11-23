import { MARKET_CHAINS } from "@/lib/chains/registry";

/**
 * The Arena runs when the market chain (gno.land, lib/chains/registry.ts) is enabled and Convex is set; otherwise the
 * market pages are empty. The name is historical.
 */
export const arcArenaEnabled = Boolean(MARKET_CHAINS.enabled.length && process.env.NEXT_PUBLIC_CONVEX_URL);
