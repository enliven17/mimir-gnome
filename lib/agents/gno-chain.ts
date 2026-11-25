/**
 * The agent API on gno.land. Writes come back as unsigned MsgCall messages for the agent's operator (a g1 account it
 * holds the key to) to sign as ONE transaction and broadcast itself: the API never holds a key. Reads come from the
 * Convex index (positions, markets) and the realms (balances, live limits).
 *
 *   createClaim  open a VS market (default) or a pool (kind: "pool", side)
 *   challenge    take side B of a VS market, or a side of a pool (kind: "pool", side)
 *   dispute      escalate a proposed result with the 2 mUSD bond
 *   withdraw     collect a pool payout (Claim on r/pool, `claimId`); VS pays at settlement, nothing to collect
 *
 * mUSD is a GRC20 the market realm pulls: an exact mUSD Approve rides in front of the call, in the same transaction,
 * whenever the operator's allowance is short. Gas is GNOT. Entry fees apply as for anyone (lib/arc/fees.ts).
 */
import { AgentEnvelopeError } from "./api";
import { readStakeLimits, stakeLimitBlocker, type ArcMarketKind } from "@/lib/arc/markets";
import { gasBalanceUgnot, musdAllowanceWei, musdBalanceWei } from "@/lib/chains/client";
import { MARKET_CHAINS, type MarketChain } from "@/lib/chains/registry";
import { isGnoAddress } from "@/lib/gno/config";
import { actionMessages, kindOfAction, pullOf, type GnoMsgCall, type MarketAction } from "@/lib/gno/msgs";
import { arcMarketDetail, arcMarketList, arcPositions } from "@/lib/server/arc-index";

/** Agents can trade when the gno.land chain is configured. */
export const agentsEnabled = () => MARKET_CHAINS.enabled.length > 0;

const units6ToWei = (units: bigint) => units * 1_000_000_000_000n;

/** The chain a request names (`chain`, only "gno"), else gno.land. */
export function chainOf(body: Record<string, unknown>): MarketChain {
  const raw = body.chain;
  if (raw !== undefined && raw !== "gno") throw new AgentEnvelopeError('chain must be "gno"', 400, "bad_params");
  const c = MARKET_CHAINS.chains.gno;
  if (!c.enabled) throw new AgentEnvelopeError("markets are not configured on this deployment", 503, "chain_unavailable");
  return c;
}

function kindOf(body: Record<string, unknown>): ArcMarketKind {
  const k = body.kind ?? "vs";
  if (k !== "vs" && k !== "pool") throw new AgentEnvelopeError('kind must be "vs" or "pool"', 400, "bad_params");
  return k;
}

function sideOf(body: Record<string, unknown>, fallback: 1 | 2): 1 | 2 {
  const s = body.side ?? fallback;
  if (s !== 1 && s !== 2) throw new AgentEnvelopeError("side must be 1 (A) or 2 (B)", 400, "bad_params");
  return s;
}

/** A gno.land operator address (lowercase g1…), or null. */
export function gnoOperatorOf(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isGnoAddress(v) ? v : null;
}

/** The parsed write (lib/agents/params.ts) as the market action it is; `body` carries kind and side. */
export function writeAction(write: { action: string; params: Record<string, unknown> }, body: Record<string, unknown>): MarketAction {
  const p = write.params;
  switch (write.action) {
    case "createClaim": {
      const kind = kindOf(body);
      return {
        type: "create",
        market: {
          kind,
          question: String(p.question),
          labelA: String(p.creatorPosition),
          labelB: String(p.counterPosition),
          resolutionUrl: String(p.resolutionUrl),
          category: String(p.category),
          deadline: Number(p.deadline),
          stake: units6ToWei(p.stakeUnits as bigint),
          side: kind === "pool" ? sideOf(body, 1) : undefined,
          maxChallengers: kind === "vs" && p.maxChallengers !== undefined ? Number(p.maxChallengers) : undefined,
        },
      };
    }
    case "challenge": {
      const kind = kindOf(body);
      return { type: "stake", kind, marketId: Number(p.claimId), stake: units6ToWei(p.stakeUnits as bigint), side: kind === "vs" ? 2 : sideOf(body, 2) };
    }
    case "dispute":
      return { type: "dispute", kind: kindOf(body), marketId: Number(p.claimId as bigint | number) };
    case "withdraw":
      if (kindOf({ kind: body.kind ?? "pool" }) !== "pool") {
        throw new AgentEnvelopeError('VS markets pay at settlement: withdraw collects a pool payout (kind: "pool")', 400, "bad_params");
      }
      return { type: "claim", marketId: Number(p.claimId as bigint | number) };
    default:
      throw new AgentEnvelopeError(`${write.action} is not an on-chain write`, 400, "bad_params");
  }
}

function describe(a: MarketAction, approve: boolean): string {
  const with_ = approve ? " (an exact mUSD Approve rides in front, same transaction)" : "";
  switch (a.type) {
    case "create":
      return `open a ${a.market.kind === "vs" ? "VS" : "pool"} market staking ${Number(a.market.stake / 1_000_000_000_000n) / 1e6} mUSD; the entry fee comes off it${with_}`;
    case "stake":
      return `${a.kind === "vs" ? "challenge VS" : `stake side ${a.side} of pool`} #${a.marketId}${with_}`;
    case "dispute":
      return `dispute ${a.kind} #${a.marketId} with the 2 mUSD bond${with_}`;
    case "claim":
      return `collect your payout from pool #${a.marketId}`;
    default:
      return a.type;
  }
}

export interface PreparedWrite {
  chain: "gno";
  chainId: string;
  rpcUrl: string;
  /** Sign all of them as ONE transaction, in order. */
  messages: GnoMsgCall[];
  fee: { gasWanted: string; gasFee: string };
  description: string;
}

/**
 * The write as unsigned MsgCalls from `operator`. `allowanceWei` is the operator's current mUSD allowance to the
 * market realm (index units): an Approve is included unless it covers the pull. Unknown = 0.
 */
export function prepareGnoWrite(
  write: { action: string; params: Record<string, unknown> },
  body: Record<string, unknown>,
  operator: string,
  allowanceWei = 0n,
): PreparedWrite {
  const chain = chainOf(body);
  const action = writeAction(write, body);
  const messages = actionMessages(operator, action, allowanceWei, chain.gno);
  return {
    chain: "gno",
    chainId: chain.chainId,
    rpcUrl: chain.rpcUrl,
    messages,
    fee: { gasWanted: String(chain.gno.gas.wanted), gasFee: `${chain.gno.gas.fee}ugnot` },
    description: describe(action, messages.length > 1),
  };
}

/** prepareGnoWrite with the operator's live allowance read first, so an Approve is only sent when needed. */
export async function prepareChainWrite(write: { action: string; params: Record<string, unknown> }, body: Record<string, unknown>, operator: string) {
  const chain = chainOf(body);
  const action = writeAction(write, body);
  const allowance = pullOf(action) > 0n ? await musdAllowanceWei(operator, kindOfAction(action), chain.gno) : 0n;
  return prepareGnoWrite(write, body, operator, allowance);
}

/** The operator's mUSD (index units, 18 dp) and GNOT for gas (ugnot). */
export async function operatorBalance(operator: string, body: Record<string, unknown> = {}): Promise<{ chain: "gno"; musdWei: string; gasUgnot: string }> {
  const chain = chainOf(body);
  const [musd, gas] = await Promise.all([musdBalanceWei(operator, chain.gno), gasBalanceUgnot(operator, chain.gno)]);
  return { chain: "gno", musdWei: musd.toString(), gasUgnot: gas.toString() };
}

const fmt = (wei: bigint) => `${Number(wei / 10n ** 12n) / 1e6} mUSD`;

/**
 * The realm's live limits for an agent stake (pause, early lock, launch caps), checked before messages are prepared,
 * so an agent gets the same plain reason the site shows instead of a bare panic. Throws a 409
 * AgentEnvelopeError("stake_limit"). Agents pay the standard entry fee (no holder ticket), so 50 bps is assumed.
 */
export async function assertStakeAllowed(write: { action: string; params: Record<string, unknown> }, body: Record<string, unknown>, operator: string): Promise<void> {
  if (write.action !== "challenge") return;
  const chain = chainOf(body);
  const kind = kindOf(body);
  const gross = units6ToWei(write.params.stakeUnits as bigint);
  const id = Number(write.params.claimId);
  const limits = await readStakeLimits(kind, id, chain.gno);
  const m = (await arcMarketDetail(kind, id, "gno").catch(() => null)) as { stakeA: string; stakeB: string } | null;
  const total = m ? BigInt(m.stakeA) + BigInt(m.stakeB) : 0n;
  let mine = 0n;
  if (kind === "pool") {
    const legs = (await arcPositions(operator).catch(() => [])) as Array<{ kind: string; marketId: number; amount: string }>;
    mine = legs.filter((p) => p.kind === "pool" && p.marketId === id).reduce((a, p) => a + BigInt(p.amount), 0n);
  }
  const blocker = stakeLimitBlocker(limits, { kind, gross, entryBps: 50, mine, total, now: Math.floor(Date.now() / 1000) }, fmt);
  if (blocker) throw new AgentEnvelopeError(blocker, 409, "stake_limit");
}

export const operatorPositions = (operator: string) => arcPositions(operator);

// r/vs numbering: 0 open … 5 disputed.
const STATUS_OF = ["open", "active", "resolved", "cancelled", "proposed", "disputed"] as const;

/** Public markets from the index, filtered by state numbers and category, newest first. */
export async function listMarkets(f: { states?: number[]; category?: string; limit: number; kind?: unknown }) {
  const wanted = f.states ? new Set(f.states.map((s) => STATUS_OF[s])) : null;
  const kind = f.kind === "vs" || f.kind === "pool" ? f.kind : undefined;
  return (await arcMarketList(kind, "gno")).filter((m) => (!wanted || wanted.has(m.status)) && (!f.category || m.category === f.category)).slice(0, f.limit);
}

export const getMarket = (kind: ArcMarketKind, marketId: number) => arcMarketDetail(kind, marketId, "gno");
