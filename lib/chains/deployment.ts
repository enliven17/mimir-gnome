import type { MarketChain } from "./registry";

/** Persisted in Convex. A market ID is meaningful only within this exact deployment (chain + realm paths). */
export interface MarketDeployment {
  chain: string;
  chainId: string;
  network: string;
  vs: string;
  pool: string;
  fees: string;
  musd: string;
}

export function marketDeployment(chain: Pick<MarketChain, "id" | "chainId" | "network" | "realms">): MarketDeployment {
  return {
    chain: chain.id, chainId: chain.chainId, network: chain.network,
    vs: chain.realms.vs, pool: chain.realms.pool, fees: chain.realms.fees, musd: chain.realms.musd,
  };
}

export function assertSameDeployment(stored: MarketDeployment | null, expected: MarketDeployment): void {
  if (!stored) throw new Error(`${expected.chain}: market deployment is not bound; bind a clean Convex environment before serving markets`);
  for (const key of Object.keys(expected) as (keyof MarketDeployment)[]) {
    if (stored[key] !== expected[key]) {
      throw new Error(`${expected.chain}: deployment mismatch (${key}); use a separate Convex deployment for a different network or realms`);
    }
  }
}
