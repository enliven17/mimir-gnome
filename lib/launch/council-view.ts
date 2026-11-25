/**
 * Mimir Launch: the council personas as agents, from lib/launch/council.json (name and ticker). Each stakes from its
 * gno.land account: the public address comes from GNO_COUNCIL_WALLETS ({"<slug>": "g1…"}, lib/chains/house.ts), so it
 * is known on the server (routes, server components) and null in the browser, which gets it from the backend's views.
 * Isomorphic; public data only.
 */
import { GRC20_FACTORY } from "./token-factory";
import { realmUrl } from "../gno/config";
import data from "./council.json";

export type TokenChain = "gno";

export interface AgentToken {
  chain: TokenChain;
  /** "<factory path>:<symbol>": the token's id. */
  address: string;
  symbol?: string;
}

export interface CouncilAgent {
  slug: string;
  name: string;
  ticker: string;
  /** Its gno.land account (lowercase g1), server side only. */
  gno: string | null;
  token: AgentToken | null;
}

type Raw = { name: string; ticker: string };

function walletsFromEnv(): Record<string, string> {
  const raw = typeof process !== "undefined" ? process.env.GNO_COUNCIL_WALLETS : undefined;
  try {
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string" && /^g1[02-9ac-hj-np-z]{38}$/i.test(v)).map(([k, v]) => [k, (v as string).toLowerCase()]));
  } catch {
    return {};
  }
}

const WALLETS = walletsFromEnv();

export const COUNCIL_AGENTS: Record<string, CouncilAgent> = Object.fromEntries(
  Object.entries(data as Record<string, Raw>).map(([slug, r]) => [slug, { slug, name: r.name, ticker: r.ticker, gno: WALLETS[slug] ?? null, token: null }]),
);

/** gnoweb's page for an agent token made with the GRC20 factory. */
export function tokenPage(t: Pick<AgentToken, "address">): string {
  const symbol = t.address.split(":").pop() ?? "";
  return realmUrl(GRC20_FACTORY, symbol);
}
