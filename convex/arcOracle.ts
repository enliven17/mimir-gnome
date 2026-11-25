"use node";

// The oracle as a Convex cron step on gno.land. Each tick, from the index (arc.oracleWork):
//   decide   past-deadline markets: agents/oracle/decide.ts (resolver spec, deadline prices, evidence + LLM, tiers),
//            then propose on chain (pool ResolveWithCutoff, vs ResolveClaimWithCutoff with confidence 0-100) with
//            evidenceHash = lowercase hex sha256 of the audit bundle; the bundle is kept in arcVerdicts
//   finalize proposals whose dispute window has closed (Finalize / FinalizeResolution)
//   refund   markets nobody settled within the 7-day grace (RefundExpired)
//   pay      pool winners (and everyone on a refund) with ClaimFor: the money only ever goes to the user
// While a realm is paused (the owner's emergency stop), skip proposals, finalizations and contested winner payouts.
// Expired proposals can refund after their full grace, and pool refunds remain payable while paused.
// A deferred or failed decision is retried with exponential backoff (lib/oracle-queue.ts). Disputes go to the arbiter.
// Env: ORACLE_MNEMONIC (the realms' oracle account; keep it funded with GNOT for gas), the LLM keys lib/llm.ts reads,
// the chain env lib/chains/registry.ts serverMarketChains reads. Realms not deployed yet: the tick does nothing.
import { applyPayoutPolicy } from "../lib/oracle-payout-policy";

import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { decide, fetchEvidence, type SettlementDecision } from "../agents/oracle/decide";
import { outcomeKnownAt } from "../agents/oracle/evaluate";
import { espnResult } from "../lib/espn";
import { lateStakes, lateStakeSummary, settlementCutoff } from "../lib/late-stakes";
import { hashHex, sealBundle, type VerdictBundle } from "../lib/verdict-bundle";
import type { OnchainClaim } from "../lib/market-claim";
import { latestBlockHeight } from "../lib/chains/client";
import { houseAddresses, oracleKey } from "../lib/chains/house";
import { serverMarketChains, type MarketChain } from "../lib/chains/registry";
import type { GnoMsgCall, MarketKind } from "../lib/gno/msgs";
import { claimForMessage, finalizeMessage, refundMessage, resolveMessage } from "../lib/gno/oracle";
import { poolConfig, poolMarket, poolPosition, vsConfig } from "../lib/gno/reads";
import { gnoSigner, type GnoSigner } from "../lib/gno/signer";

const SIDE = { CREATOR_WINS: 1, CHALLENGERS_WIN: 2, DRAW: 3, UNRESOLVABLE: 4 } as const;
/** Longest wait between tries while a sports market waits for the final whistle. */
const SPORTS_RETRY_CAP_MINUTES = 10;
// Decisions fetch evidence and call an LLM (up to a minute each): a few per tick keeps the action well inside 10 min.
const MAX_DECISIONS_PER_TICK = 3;

type Market = Doc<"arcMarkets">;
type Position = Doc<"arcPositions">;

/** Addresses as the oracle and council compare them: lowercase. */
const addr = (a: string) => a.toLowerCase();

/** The indexed market as the claim shape decide() reads. Pools: side A is the "creator" side, B the "challengers". */
function asClaim(cfg: MarketChain, m: Market, positions: Position[]): OnchainClaim {
  const units = (wei: string) => BigInt(wei) / 1_000_000_000_000n; // 18-dp index units → the 6-dp units decide() prints
  return {
    id: BigInt(m.marketId),
    contract: m.kind === "vs" ? cfg.realms.vs : cfg.realms.pool,
    creator: addr(m.creator),
    question: m.question,
    creatorPosition: m.labelA,
    counterPosition: m.labelB,
    resolutionUrl: m.resolutionUrl,
    category: m.category,
    creatorStake: units(m.stakeA),
    totalChallengerStake: units(m.stakeB),
    deadline: m.deadline,
    createdAt: m.createdAt,
    challengers: positions.filter((p) => p.user !== m.creator).map((p) => ({ addr: addr(p.user), stake: units(p.amount), paid: false })),
  } as unknown as OnchainClaim;
}

async function setup(cfg: MarketChain) {
  const e = process.env;
  const key = oracleKey(e);
  if (!key) return null;
  const signer = await gnoSigner(key, cfg.gno);
  // Operator addresses: markets they hold a position in settle on firm verdicts only (decide.ts). The council's and
  // the market creator's accounts are ours too, so a market baiting them is held to the same bar.
  const house = new Set(
    [signer.address, ...houseAddresses(e), ...(e.GNO_HOUSE_ADDRESSES ?? "").split(",")].map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  // Mainnet: only results resting on something the creator cannot edit pay out (lib/oracle-payout-policy.ts).
  const mainnet = cfg.network === "mainnet";
  const extraHosts = (e.ORACLE_SOURCE_ALLOWLIST ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return { cfg, signer, house, mainnet, extraHosts };
}

type Setup = NonNullable<Awaited<ReturnType<typeof setup>>>;

/** One transaction, waited until committed; a realm panic throws with its message. */
const write = (s: { signer: GnoSigner }, msg: GnoMsgCall) => s.signer.send([msg]).then((r) => r.txHash);

const errText = (e: unknown) => {
  const x = e as { message?: string };
  return (x?.message ?? String(e)).split("\n")[0];
};

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runQuery(internal.marketDeployment.check, {});
    if (process.env.MIMIR_BACKEND_OFF === "1") return; // this deployment is switched off (crons.ts)
    await ctx.runMutation(internal.arcAdmin.beat, { name: "gno-oracle" });
    if (process.env.MIMIR_PAUSE_ORACLE_SETTLEMENT === "1") return;
    const chain = serverMarketChains().chains.gno;
    if (!chain.enabled) return;
    const s = await setup(chain);
    if (!s) {
      console.warn("[oracle] no oracle key (ORACLE_MNEMONIC); skipped");
      return;
    }
    try {
      await settle(ctx, s);
    } catch (err) {
      console.warn(`[oracle] ${errText(err)}`);
    }
  },
});

async function settle(ctx: ActionCtx, s: Setup): Promise<void> {
  const c = "gno" as const;
  const g = s.cfg.gno;
  const now = Math.floor(Date.now() / 1000);
  // Unreadable counts as paused (and covers realms not deployed yet): a panic would only burn the retry budget.
  const [vsPaused, poolPaused] = await Promise.all([vsConfig(g).then((x) => x.paused, () => true), poolConfig(g).then((x) => x.paused, () => true)]);
  const work = await ctx.runQuery(internal.arc.oracleWork, { chain: c, now, vsPaused, poolPaused });
  const paused = (kind: MarketKind) => (kind === "vs" ? vsPaused : poolPaused);
  let changed = false;

  for (const m of work.decide.filter((d) => !paused(d.kind)).slice(0, MAX_DECISIONS_PER_TICK)) {
    const tag = `[oracle] ${m.kind} #${m.marketId}`;
    try {
      // An uncontested pool refunds every stake whatever the outcome: propose DRAW without spending a model call,
      // so markets nobody took the other side of cost the backend nothing to close.
      if (m.kind === "pool" && (BigInt(m.stakeA) === 0n || BigInt(m.stakeB) === 0n)) {
        const summary = "Only one side was staked, so every stake is refunded.";
        const tx = await write(s, resolveMessage(s.signer.address, { kind: "pool", marketId: m.marketId, side: SIDE.DRAW, summary, confidence: 100, evidenceHash: null, cutoff: 0 }, g));
        await ctx.runMutation(internal.arc.saveVerdict, { chain: c, kind: m.kind, marketId: m.marketId, side: SIDE.DRAW, confidence: 100, summary, evidenceHash: "", bundle: "{}", txHash: tx });
        changed = true;
        continue;
      }
      const full = await ctx.runQuery(internal.arc.marketWithPositions, { chain: c, kind: m.kind, marketId: m.marketId });
      const raw: SettlementDecision | null = await decide(
        { oracle: addr(s.signer.address), house: s.house, houseHeld: false, jury: null },
        asClaim(s.cfg, m, full?.positions ?? []),
      );
      if (!raw) {
        // A game in progress ends within a couple of hours: look again every few minutes, not after a 2-hour backoff.
        const capMinutes = m.category === "sports" ? SPORTS_RETRY_CAP_MINUTES : undefined;
        await ctx.runMutation(internal.arc.deferMarket, { chain: c, kind: m.kind, marketId: m.marketId, capMinutes });
        continue;
      }
      const decision = applyPayoutPolicy(raw, s.mainnet, s.extraHosts);
      if (!decision.policy.pay) console.warn(`${tag}: payout policy → refund (${decision.policy.reason})`);
      const side: number = SIDE[decision.verdict.verdict];
      const confidence = decision.verdict.confidence;
      let summary = decision.verdict.explanation.slice(0, 500);
      let hash = hashHex(decision.evidenceHash);
      let bundle: unknown = decision.bundle;
      const decidedSummary = summary;
      // Commit eligibility with the verdict. On-chain deposit histories determine refund amounts.
      let cutoff = 0;
      if (side === SIDE.CREATOR_WINS || side === SIDE.CHALLENGERS_WIN) {
        // An ESPN game was known from kickoff (lib/espn.ts); anything else asks the model.
        const espn = await espnResult(m.resolutionUrl);
        const knownAt =
          espn && Number.isFinite(espn.startAt)
            ? espn.startAt
            : await outcomeKnownAt({ question: m.question, resolutionUrl: m.resolutionUrl, deadline: m.deadline }, (await fetchEvidence(m.resolutionUrl)).text);
        cutoff = settlementCutoff(knownAt, now);
        const late = lateStakes(knownAt, await ctx.runQuery(internal.arc.stakeTimes, { chain: c, kind: m.kind, marketId: m.marketId }));
        if (late.length) summary = `${summary} ${lateStakeSummary(cutoff, late, true)}`;
        bundle = { ...(bundle as object), lateDepositPolicy: { cutoff, comparison: "deposit.at < cutoff", lateStakes: late, witnessesOnly: true, decidedVerdict: decision.verdict.verdict } };
        hash = sealBundle(bundle as VerdictBundle).hash;
      }

      const tx = await write(s, resolveMessage(s.signer.address, { kind: m.kind, marketId: m.marketId, side, summary, confidence, evidenceHash: hash, cutoff }, g));
      await ctx.runMutation(internal.arc.saveVerdict, {
        chain: c,
        kind: m.kind,
        marketId: m.marketId,
        side,
        decided: side,
        ...(decidedSummary !== summary ? { decidedSummary } : {}),
        confidence,
        summary,
        evidenceHash: hash,
        bundle: JSON.stringify(bundle),
        txHash: tx,
      });
      changed = true;
    } catch (err) {
      console.warn(`${tag}: ${errText(err)}`);
      await ctx.runMutation(internal.arc.deferMarket, { chain: c, kind: m.kind, marketId: m.marketId, error: errText(err) });
    }
  }

  for (const m of work.finalize.filter((f) => !paused(f.kind))) {
    try {
      await write(s, finalizeMessage(s.signer.address, m.kind, m.marketId, g));
      changed = true;
    } catch (err) {
      console.warn(`[oracle] finalize ${m.kind} #${m.marketId}: ${errText(err)}`);
    }
  }

  for (const m of work.refund) {
    try {
      await write(s, refundMessage(s.signer.address, m.kind, m.marketId, g));
      changed = true;
    } catch (err) {
      console.warn(`[oracle] refund ${m.kind} #${m.marketId}: ${errText(err)}`);
    }
  }

  let payoutChecks = 0;
  payouts: for (const p of work.pay) {
    for (const user of p.users) {
      if (payoutChecks++ >= 100) break payouts;
      try {
        const position = await poolPosition(p.marketId, user, g);
        if (position.claimable === 0) {
          // Claimable is also zero before resolution: record progress only for a final market, at the height the
          // realm was read at, so a newer snapshot (a later ruling) makes it payable again.
          const market = await poolMarket(p.marketId, g);
          const confirmed = await poolPosition(p.marketId, user, g);
          if (market.state === 3 && confirmed.claimable === 0) {
            const block = await latestBlockHeight(g);
            await ctx.runMutation(internal.arc.recordZeroPoolPayout, { chain: c, marketId: p.marketId, user, block, outcome: market.outcome, cutoff: market.settlementCutoff });
          }
          continue;
        }
        await write(s, claimForMessage(s.signer.address, p.marketId, user, g));
        changed = true;
      } catch (err) {
        console.warn(`[oracle] pay pool #${p.marketId} ${user}: ${errText(err)}`);
        await ctx.runMutation(internal.arc.deferPoolPayout, { chain: c, marketId: p.marketId, user });
      }
    }
  }

  if (changed) await ctx.scheduler.runAfter(0, internal.arcSync.sync, {});
}
