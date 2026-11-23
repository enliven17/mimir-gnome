/**
 * Mimir on gno.land: the network and the realm paths. Pure and isomorphic (strings only), so the browser, the routes
 * and the Convex jobs share it.
 *
 *   NEXT_PUBLIC_GNO_CHAIN_ID   default "onyx-1" (the current testnet)
 *   NEXT_PUBLIC_GNO_RPC_URL    default https://rpc.onyx.testnets.gno.land:443
 *   NEXT_PUBLIC_GNO_NAMESPACE  the deployer address the packages live under
 *   NEXT_PUBLIC_GNOWEB_URL     default https://onyx.testnets.gno.land
 *
 * Amounts: mUSD has 6 decimals on chain. Everything off chain (Convex rows, quotes, the UI) keeps Mimir's one
 * chain-independent unit, USDC with 18 decimals ("index units"), so reads scale up by 1e12 and transaction builders
 * scale back down (lib/chains/amounts.ts).
 */
const env = (k: string): string | undefined => {
  const v = typeof process !== "undefined" ? process.env[k] : undefined;
  return v && v.trim() ? v.trim() : undefined;
};

export const DEFAULT_NAMESPACE = "g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz";

export interface GnoConfig {
  chainId: string;
  chainName: string;
  rpcUrl: string;
  gnoweb: string;
  namespace: string;
  realms: { musd: string; fees: string; pool: string; vs: string; agentpay: string };
  /** The gas fee every transaction offers, ugnot, and the gas it may use. */
  gas: { fee: number; wanted: number };
  /** mUSD on-chain decimals. */
  decimals: 6;
}

export function gnoConfig(e: (k: string) => string | undefined = env): GnoConfig {
  const chainId = e("NEXT_PUBLIC_GNO_CHAIN_ID") ?? "onyx-1";
  const namespace = e("NEXT_PUBLIC_GNO_NAMESPACE") ?? DEFAULT_NAMESPACE;
  const realm = (name: string) => `gno.land/r/${namespace}/${name}`;
  return {
    chainId,
    chainName: chainId === "gnoland-1" ? "gno.land" : `gno.land ${chainId}`,
    rpcUrl: e("NEXT_PUBLIC_GNO_RPC_URL") ?? "https://rpc.onyx.testnets.gno.land:443",
    gnoweb: e("NEXT_PUBLIC_GNOWEB_URL") ?? "https://onyx.testnets.gno.land",
    namespace,
    realms: { musd: realm("musd"), fees: realm("fees"), pool: realm("pool"), vs: realm("vs"), agentpay: realm("agentpay") },
    gas: { fee: 1_000_000, wanted: 50_000_000 },
    decimals: 6,
  };
}

export const GNO = gnoConfig();

/** gnoweb link to a realm page, e.g. a market: realmUrl(GNO.realms.pool, "12"). */
export function realmUrl(realmPath: string, renderPath = "", cfg: GnoConfig = GNO): string {
  const p = realmPath.replace(/^gno\.land/, "");
  return `${cfg.gnoweb}${p}${renderPath ? `:${renderPath}` : ""}`;
}

/** gnoweb's view of a transaction. */
export const txUrl = (hash: string, cfg: GnoConfig = GNO) => `${cfg.gnoweb}/tx/${encodeURIComponent(hash)}`;

/** A bech32 gno.land address. */
export const isGnoAddress = (v: unknown): v is string => typeof v === "string" && /^g1[02-9ac-hj-np-z]{38}$/.test(v.trim());
