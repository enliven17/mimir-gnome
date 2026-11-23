/** Market URLs: /arena/gno/<kind>/<id> is the market page. Pure. */
import type { MarketChainId } from "./registry";

export const marketPath = (chain: MarketChainId | null | undefined, kind: "vs" | "pool", id: number | string) => `/arena/${chain ?? "gno"}/${kind}/${id}`;

/** "pool-3" / "vs-3" for share links and cards. */
export const marketRef = (_chain: MarketChainId | null | undefined, kind: "vs" | "pool", id: number) => `${kind}-${id}`;
