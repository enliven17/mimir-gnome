/**
 * The market chain: Mimir runs its markets on gno.land only (docs/GNO.md). One entry, id "gno", built from
 * lib/gno/config.ts:
 *
 *   id       "gno": the key stored with every indexed row (convex/schema.ts) and used in URLs
 *            (/arena/gno/<kind>/<id>)
 *   token    mUSD, a GRC20 realm with 6 decimals; a market realm pulls it with TransferFrom after an Approve that rides
 *            in the same transaction (lib/gno/msgs.ts). Gas is GNOT (ugnot, 6 dp).
 *   realms   the VS and pool market realms, the fee tiers and mUSD (package paths, not addresses).
 *
 * Amounts, everywhere off chain (Convex rows, quotes, the UI, agent sizing), are in ONE unit: mUSD with 18 decimals
 * ("index units"). Reads scale the 6-dp chain amounts up by 1e12; transaction builders scale back down
 * (lib/chains/amounts.ts), refusing sub-unit dust.
 *
 * Pure and isomorphic (strings only), so the browser, the routes and the Convex jobs share it.
 */
import { gnoConfig, realmUrl, txUrl, type GnoConfig } from "../gno/config";

export type MarketChainId = "gno";
export const MARKET_CHAIN_IDS: readonly MarketChainId[] = ["gno"];
export type ChainNetwork = "testnet" | "mainnet";
export type MarketKind = "vs" | "pool";

export interface MarketChain {
  id: MarketChainId;
  /** Short name for badges and copy. */
  label: string;
  /** The network's full name, e.g. "gno.land onyx-1". */
  name: string;
  network: ChainNetwork;
  /** The Tendermint chain id, e.g. "onyx-1". */
  chainId: string;
  rpcUrls: string[];
  rpcUrl: string;
  /** gnoweb. */
  explorer: string;
  explorerName: string;
  /** What gas is paid in. */
  gas: { symbol: "GNOT"; denom: "ugnot"; decimals: 6 };
  /** The stake token. */
  token: { symbol: "mUSD"; decimals: 6; realm: string };
  realms: GnoConfig["realms"];
  /** The realms' minimum gross stake, in index units (18 dp). */
  minStakeWei: bigint;
  /** The gno config the realms and RPC come from. */
  gno: GnoConfig;
  enabled: boolean;
}

/** The realms' MinStake: 0.1 mUSD (gno/r/pool/pool.gno, gno/r/vs/vs.gno), in index units. */
export const MIN_STAKE_WEI = 100_000_000_000_000_000n;

export function gnoMarketChain(cfg: GnoConfig): MarketChain {
  return {
    id: "gno",
    label: "gno.land",
    name: cfg.chainName,
    network: cfg.chainId === "gnoland-1" ? "mainnet" : "testnet",
    chainId: cfg.chainId,
    rpcUrls: [cfg.rpcUrl],
    rpcUrl: cfg.rpcUrl,
    explorer: cfg.gnoweb,
    explorerName: "gnoweb",
    gas: { symbol: "GNOT", denom: "ugnot", decimals: 6 },
    token: { symbol: "mUSD", decimals: 6, realm: cfg.realms.musd },
    realms: cfg.realms,
    minStakeWei: MIN_STAKE_WEI,
    gno: cfg,
    enabled: true,
  };
}

export interface MarketChains {
  chains: Record<MarketChainId, MarketChain>;
  enabled: MarketChainId[];
  defaultChain: MarketChainId;
}

const fromConfig = (cfg: GnoConfig): MarketChains => ({ chains: { gno: gnoMarketChain(cfg) }, enabled: ["gno"], defaultChain: "gno" });

// Literal `process.env.NEXT_PUBLIC_*` reads: Next inlines only those into the browser bundle.
const PUBLIC_ENV: Record<string, string | undefined> = {
  NEXT_PUBLIC_GNO_CHAIN_ID: process.env.NEXT_PUBLIC_GNO_CHAIN_ID,
  NEXT_PUBLIC_GNO_RPC_URL: process.env.NEXT_PUBLIC_GNO_RPC_URL,
  NEXT_PUBLIC_GNO_NAMESPACE: process.env.NEXT_PUBLIC_GNO_NAMESPACE,
  NEXT_PUBLIC_GNOWEB_URL: process.env.NEXT_PUBLIC_GNOWEB_URL,
};
const pick = (e: Record<string, string | undefined>) => (k: string) => e[k]?.trim() || undefined;

export const MARKET_CHAINS: MarketChains = fromConfig(gnoConfig(pick(PUBLIC_ENV)));

/** The backend's view (Convex jobs, server routes): GNO_* names first, then the public ones. */
export function serverMarketChains(e: Record<string, string | undefined> = process.env): MarketChains {
  const get = pick(e);
  return fromConfig(gnoConfig((k) => get(k.replace(/^NEXT_PUBLIC_/, "")) ?? get(k)));
}

export const isMarketChainId = (v: unknown): v is MarketChainId => v === "gno";

export const marketChain = (id: MarketChainId = "gno"): MarketChain => MARKET_CHAINS.chains[id];

/** Every row is on gno.land. */
export const chainOfRow = (_row: { chain?: string | null }): MarketChainId => "gno";

/** gnoweb links: a transaction, an account (its mUSD balance page) or a realm. */
export function explorerUrl(chain: Pick<MarketChain, "gno">, kind: "tx" | "address" | "realm", id: string): string {
  if (kind === "tx") return txUrl(id, chain.gno);
  if (kind === "address") return realmUrl(chain.gno.realms.musd, `balance/${id}`, chain.gno);
  return realmUrl(id, "", chain.gno);
}

/** The market realm for a kind (a package path). */
export const marketContract = (chain: Pick<MarketChain, "realms">, kind: MarketKind): string => (kind === "vs" ? chain.realms.vs : chain.realms.pool);

/** gnoweb's page for one market. */
export const marketRealmUrl = (chain: Pick<MarketChain, "gno">, kind: MarketKind, id: number) =>
  realmUrl(kind === "vs" ? chain.gno.realms.vs : chain.gno.realms.pool, String(id), chain.gno);
