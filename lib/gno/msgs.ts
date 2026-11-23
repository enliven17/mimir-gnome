/**
 * Market actions as gno.land MsgCall messages. Every message is plain data, so the browser (Adena DoContract), the
 * agents (lib/gno/signer.ts) and the tests share it.
 *
 * A call that pulls mUSD (create, stake/challenge, dispute) needs an allowance for the market realm on mUSD;
 * actionMessages puts an exact Approve in front when the allowance falls short, and both go in ONE transaction.
 * Amounts arrive in index units (18 dp) and leave in mUSD units (6 dp): sub-unit dust is refused.
 */
import { realmAddress } from "./address";
import { GNO, type GnoConfig } from "./config";

export type MarketKind = "vs" | "pool";

/** Two-sided pool: 1 = A, 2 = B. VS: 1 = creator, 2 = challengers. */
export type Side = 1 | 2;

export interface NewMarketInput {
  kind: MarketKind;
  question: string;
  labelA: string;
  labelB: string;
  resolutionUrl: string;
  category: string;
  /** Unix seconds. */
  deadline: number;
  /** Gross, index units: what leaves the account; the entry fee comes off it. */
  stake: bigint;
  /** Pool only: the side the opening stake backs. */
  side?: Side;
  referrer?: string;
  /** VS only. */
  isPrivate?: boolean;
  marketType?: string;
  oddsMode?: "pool" | "fixed";
  challengerPayoutBps?: number;
  handicapLine?: string;
  settlementRule?: string;
  maxChallengers?: number;
  parentId?: number;
}

export type MarketAction =
  | { type: "create"; market: NewMarketInput }
  /** VS: challenge. Pool: stake on `side`. `stake` gross, index units. */
  | { type: "stake"; kind: MarketKind; marketId: number; stake: bigint; side: Side; referrer?: string }
  | { type: "dispute"; kind: MarketKind; marketId: number }
  | { type: "finalize"; kind: MarketKind; marketId: number }
  | { type: "refund"; kind: MarketKind; marketId: number }
  | { type: "cancel"; marketId: number }
  | { type: "invite"; marketId: number; accounts: readonly string[]; allowed: boolean }
  | { type: "claim"; marketId: number }
  | { type: "claimFees"; kind: MarketKind }
  | { type: "rematch"; parentId: number; deadline: number; stake: bigint };

export interface GnoMsgCall {
  type: "/vm.m_call";
  value: { caller: string; send: string; max_deposit: string; pkg_path: string; func: string; args: string[] };
}

/** The dispute bond, index units (2 mUSD). */
export const DISPUTE_BOND_WEI = 2_000_000_000_000_000_000n;
const SCALE = 1_000_000_000_000n; // 1e18 / 1e6

/** Index units (18 dp) to mUSD units (6 dp), refusing dust below one unit. */
export function toMusdUnits(wei: bigint): bigint {
  if (wei < 0n) throw new Error("negative amount");
  if (wei % SCALE !== 0n) throw new Error("amount has more precision than mUSD (6 decimals)");
  return wei / SCALE;
}

export const fromMusdUnits = (units: bigint | number | string) => BigInt(units) * SCALE;

export const kindOfAction = (a: MarketAction): MarketKind =>
  a.type === "create" ? a.market.kind
    : a.type === "cancel" || a.type === "invite" || a.type === "rematch" ? "vs"
    : a.type === "claim" ? "pool"
    : a.kind;

export const realmOf = (kind: MarketKind, cfg: GnoConfig = GNO) => (kind === "vs" ? cfg.realms.vs : cfg.realms.pool);

/** What the action pulls from the sender, index units; 0 when nothing. */
export function pullOf(a: MarketAction): bigint {
  if (a.type === "create" || a.type === "stake" || a.type === "rematch") return a.type === "create" ? a.market.stake : a.stake;
  if (a.type === "dispute") return DISPUTE_BOND_WEI;
  return 0n;
}

const call = (caller: string, pkg: string, func: string, args: (string | number | bigint | boolean)[]): GnoMsgCall => ({
  type: "/vm.m_call",
  value: { caller, send: "", max_deposit: "", pkg_path: pkg, func, args: args.map(String) },
});

const id = (n: number) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid market id");
  return n;
};

function createMessage(caller: string, m: NewMarketInput, cfg: GnoConfig): GnoMsgCall {
  const amount = toMusdUnits(m.stake);
  if (m.kind === "pool") {
    return call(caller, cfg.realms.pool, "CreateMarket", [
      m.question, m.labelA, m.labelB, m.resolutionUrl, m.category, m.deadline, m.side ?? 1, m.referrer ?? "", amount,
    ]);
  }
  return call(caller, cfg.realms.vs, "CreateClaim", [
    m.question, m.labelA, m.labelB, m.resolutionUrl, m.deadline, amount, m.category, m.parentId ?? 0,
    m.marketType ?? "binary", m.oddsMode ?? "pool", m.challengerPayoutBps ?? 0, m.handicapLine ?? "",
    m.settlementRule ?? "", m.maxChallengers ?? 0, Boolean(m.isPrivate), m.referrer ?? "",
  ]);
}

/** The action itself as one message (no approve). */
export function actionMessage(caller: string, a: MarketAction, cfg: GnoConfig = GNO): GnoMsgCall {
  const realm = realmOf(kindOfAction(a), cfg);
  const vs = kindOfAction(a) === "vs";
  switch (a.type) {
    case "create":
      return createMessage(caller, a.market, cfg);
    case "stake":
      return vs
        ? call(caller, realm, "ChallengeClaim", [id(a.marketId), toMusdUnits(a.stake), a.referrer ?? ""])
        : call(caller, realm, "Stake", [id(a.marketId), a.side, a.referrer ?? "", toMusdUnits(a.stake)]);
    case "dispute":
      return call(caller, realm, vs ? "DisputeResolution" : "Dispute", [id(a.marketId)]);
    case "finalize":
      return call(caller, realm, vs ? "FinalizeResolution" : "Finalize", [id(a.marketId)]);
    case "refund":
      return call(caller, realm, "RefundExpired", [id(a.marketId)]);
    case "cancel":
      return call(caller, realm, "CancelClaim", [id(a.marketId)]);
    case "invite": {
      if (a.accounts.length === 0 || a.accounts.length > 100) throw new Error("Invite 1 to 100 wallets per transaction");
      return call(caller, realm, "SetInvited", [id(a.marketId), a.accounts.join(","), a.allowed]);
    }
    case "claim":
      return call(caller, realm, "Claim", [id(a.marketId)]);
    case "claimFees":
      return call(caller, realm, "ClaimFees", []);
    case "rematch":
      return call(caller, realm, "CreateRematch", [id(a.parentId), a.deadline, toMusdUnits(a.stake)]);
  }
}

/** mUSD Approve of exactly `wei` (index units) to a market realm. */
export function approveMessage(caller: string, kind: MarketKind, wei: bigint, cfg: GnoConfig = GNO): GnoMsgCall {
  return call(caller, cfg.realms.musd, "Approve", [realmAddress(realmOf(kind, cfg)), toMusdUnits(wei)]);
}

export const needsApproval = (a: MarketAction, allowanceWei: bigint) => pullOf(a) > 0n && allowanceWei < pullOf(a);

/** [Approve(exact pull), action] when the allowance falls short, else [action]: always one transaction. */
export function actionMessages(caller: string, a: MarketAction, allowanceWei: bigint, cfg: GnoConfig = GNO): GnoMsgCall[] {
  const msg = actionMessage(caller, a, cfg);
  return needsApproval(a, allowanceWei) ? [approveMessage(caller, kindOfAction(a), pullOf(a), cfg), msg] : [msg];
}

/** The mUSD faucet: 1,000 mUSD once a day per address. */
export const faucetMessage = (caller: string, cfg: GnoConfig = GNO): GnoMsgCall => call(caller, cfg.realms.musd, "Faucet", []);

/** Pay an agent for one API call (r/agentpay): approve + Pay in one transaction. */
export function agentPayMessages(caller: string, agent: string, wei: bigint, callId: string, cfg: GnoConfig = GNO): GnoMsgCall[] {
  const amount = toMusdUnits(wei);
  return [
    call(caller, cfg.realms.musd, "Approve", [realmAddress(cfg.realms.agentpay), amount]),
    call(caller, cfg.realms.agentpay, "Pay", [agent, amount, callId]),
  ];
}
