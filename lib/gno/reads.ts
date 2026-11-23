/**
 * Typed reads of Mimir's realms: the JSON views the realms export (MarketsJSON, ClaimJSON, ...) and mUSD balances.
 * Amounts come back as mUSD units (6 dp) exactly as the chain holds them; callers scale with fromMusdUnits.
 */
import { realmAddress } from "./address";
import { GNO, type GnoConfig } from "./config";
import { goString, qevalBool, qevalInts, qevalJSON } from "./rpc";

export interface PoolMarket {
  id: number;
  creator: string;
  deadline: number;
  createdAt: number;
  /** 0 open, 1 proposed, 2 disputed, 3 resolved */
  state: number;
  outcome: number;
  proposed: number;
  proposedAt: number;
  disputedAt: number;
  disputer: string;
  bond: number;
  totalA: number;
  totalB: number;
  eligibleA: number;
  eligibleB: number;
  entryFees: number;
  settlementCutoff: number;
  lockAt: number;
  participants: number;
  evidenceHash: string;
  question: string;
  labelA: string;
  labelB: string;
  resolutionUrl: string;
  category: string;
  summary: string;
}

export interface PoolPosition {
  a: number;
  b: number;
  copyA: number;
  copyB: number;
  referrer: string;
  claimed: boolean;
  claimable: number;
  claimFee: number;
}

export interface VsProposal {
  winnerSide: number;
  confidence: number;
  proposedAt: number;
  disputedAt: number;
  disputer: string;
  bond: number;
  evidenceHash: string;
  summary: string;
}

export interface VsClaim {
  id: number;
  creator: string;
  question: string;
  creatorPosition: string;
  counterPosition: string;
  resolutionUrl: string;
  creatorStake: number;
  totalChallengerStake: number;
  reservedCreatorLiability: number;
  eligibleCreator: number;
  eligibleChallengers: number;
  deadline: number;
  /** 0 open, 1 active, 2 resolved, 3 cancelled, 4 proposed, 5 disputed */
  state: number;
  winnerSide: number;
  resolutionSummary: string;
  confidence: number;
  category: string;
  parentId: number;
  challengerCount: number;
  createdAt: number;
  marketType: string;
  oddsMode: "pool" | "fixed";
  challengerPayoutBps: number;
  handicapLine: string;
  settlementRule: string;
  maxChallengers: number;
  isPrivate: boolean;
  evidenceHash: string;
  referrer: string;
  entryFees: number;
  settlementCutoff: number;
  lockAt: number;
  proposal: VsProposal;
}

export interface VsChallenger {
  address: string;
  stake: number;
  at: number;
  referrer: string;
}

export interface MarketConfig {
  owner: string;
  arbiter: string;
  oracle: string;
  auditAgent: string;
  feeRecipient: string;
  paused: boolean;
  disputeWindow: number;
  minStake: number;
  disputeBond: number;
  lockSeconds: number;
  graceSeconds: number;
  maxMarketStake: number;
  maxAccountStake: number;
  now: number;
  marketCount?: number;
  claimCount?: number;
}

const q = (realm: string, expr: string, cfg: GnoConfig) => qevalJSON(realm, expr, cfg);

export const poolMarkets = (offset = 0, limit = 100, cfg: GnoConfig = GNO) =>
  q(cfg.realms.pool, `MarketsJSON(${offset}, ${limit})`, cfg) as Promise<PoolMarket[]>;
export const poolMarket = (id: number, cfg: GnoConfig = GNO) => q(cfg.realms.pool, `MarketJSON(${id})`, cfg) as Promise<PoolMarket>;
export const poolPosition = (id: number, user: string, cfg: GnoConfig = GNO) =>
  q(cfg.realms.pool, `PositionJSON(${id}, ${goString(user)})`, cfg) as Promise<PoolPosition>;
export const poolConfig = (cfg: GnoConfig = GNO) => q(cfg.realms.pool, "ConfigJSON()", cfg) as Promise<MarketConfig>;

export const vsClaims = (offset = 0, limit = 100, cfg: GnoConfig = GNO) =>
  q(cfg.realms.vs, `ClaimsJSON(${offset}, ${limit})`, cfg) as Promise<VsClaim[]>;
export const vsClaim = (id: number, cfg: GnoConfig = GNO) => q(cfg.realms.vs, `ClaimJSON(${id})`, cfg) as Promise<VsClaim>;
export const vsChallengers = (id: number, cfg: GnoConfig = GNO) =>
  q(cfg.realms.vs, `ChallengersJSON(${id})`, cfg) as Promise<VsChallenger[]>;
export const vsConfig = (cfg: GnoConfig = GNO) => q(cfg.realms.vs, "ConfigJSON()", cfg) as Promise<MarketConfig>;
export async function vsUserStats(user: string, cfg: GnoConfig = GNO): Promise<{ wins: number; losses: number }> {
  const [w, l] = await qevalInts(cfg.realms.vs, `UserStats(${goString(user)})`, cfg);
  return { wins: Number(w ?? 0n), losses: Number(l ?? 0n) };
}
export const vsHasChallenged = (id: number, user: string, cfg: GnoConfig = GNO) =>
  qevalBool(cfg.realms.vs, `HasChallenged(${id}, ${goString(user)})`, cfg);
export const vsInvited = (id: number, user: string, cfg: GnoConfig = GNO) =>
  qevalBool(cfg.realms.vs, `Invited(${id}, ${goString(user)})`, cfg);

/** mUSD balance, mUSD units. */
export async function musdBalance(owner: string, cfg: GnoConfig = GNO): Promise<bigint> {
  const [v] = await qevalInts(cfg.realms.musd, `BalanceOf(${goString(owner)})`, cfg);
  return v ?? 0n;
}

/** mUSD allowance owner -> a market realm, mUSD units. */
export async function musdAllowance(owner: string, spenderRealm: string, cfg: GnoConfig = GNO): Promise<bigint> {
  const [v] = await qevalInts(cfg.realms.musd, `Allowance(${goString(owner)}, ${goString(realmAddress(spenderRealm))})`, cfg);
  return v ?? 0n;
}

/** Unix seconds from which `addr` may use the mUSD faucet again (0 = now). */
export async function musdNextDrip(addr: string, cfg: GnoConfig = GNO): Promise<number> {
  const [v] = await qevalInts(cfg.realms.musd, `NextDrip(${goString(addr)})`, cfg);
  return Number(v ?? 0n);
}

/** The account's entry fee in basis points (r/fees). */
export async function entryBps(account: string, cfg: GnoConfig = GNO): Promise<number> {
  const [v] = await qevalInts(cfg.realms.fees, `EntryBps(${goString(account)})`, cfg);
  return Number(v ?? 50n);
}
