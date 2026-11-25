"use node";

// The house market creator on gno.land, as a Convex cron step. Each tick:
//   1. cancel its own VS claims that closed with no challenger (their stake comes back)
//   2. count its joinable markets; at MAX_ACTIVE_CLAIMS, stop
//   3. draft from the same rule-built sources (crypto, $ANSEM, sports, stocks, Polymarket when enabled), gate them on
//      realm limits and the decidability score, drop duplicates of its live markets, optionally council-preflight them
//   4. open each as a two-sided pool (anyone stakes either side) from the house creator's account (signed with
//      GNO_CREATOR_MNEMONIC; an exact mUSD Approve rides in the same transaction); its stake backs side A.
//      A pool nobody joined is refunded by the oracle.
// Budget: CREATOR_DAILY_BUDGET_USDC (mUSD, convex/houseBudget.ts). CREATOR_DAILY_MARKETS counts the house's own drafts.
// Env: GNO_CREATOR_MNEMONIC (and GNO_CREATOR_ADDRESS; the account needs mUSD and GNOT for gas), the CREATOR_* knobs of
//      the old worker, MIMIR_PAUSE_CREATE_MARKET=1, MARKET_CREATOR_DRY_RUN=1.

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { gatherCouncilPreflight, preflightKeeps, preflightPersonas } from "../agents/market-creator/council-preflight";
import { draftProblem, scoreDraft, type DraftClaim } from "../agents/market-creator/draft";
import { draftCryptoClaims } from "../agents/market-creator/crypto";
import { draftSportsClaims } from "../agents/market-creator/sports";
import { draftStockClaims } from "../agents/market-creator/stocks";
import { fetchPolymarketCandidates, isPolymarketEnabled, polymarketDraft } from "../agents/market-creator/polymarket";
import { filterDuplicates, signatureOf } from "../agents/market-creator/dedupe";
import { usdToIndex } from "../lib/chains/amounts";
import { creatorMnemonic, houseCreatorWallet } from "../lib/chains/house";
import { serverMarketChains } from "../lib/chains/registry";
import { gnoSigner } from "../lib/gno/signer";
import { gnoCancelVs, gnoCreatePool, MIN_GAS_UGNOT, walletGasUgnot, walletMusdWei } from "../lib/server/gno-wallets";

const envNum = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== undefined && process.env[name] !== "" ? n : fallback;
};
const SIDE_A = 1;

async function gatherDrafts(): Promise<DraftClaim[]> {
  const polymarketPerRun = envNum("CREATOR_POLYMARKET_PER_RUN", 2);
  const [crypto, sports, polymarket] = await Promise.all([
    draftCryptoClaims(envNum("CREATOR_CRYPTO_PER_RUN", 2), envNum("CREATOR_HORIZON_MIN", 30)).catch(() => []),
    draftSportsClaims(envNum("CREATOR_SPORTS_PER_RUN", 3), envNum("CREATOR_SPORTS_MAX_HOURS", 72)).catch(() => []),
    isPolymarketEnabled() && polymarketPerRun > 0 ? fetchPolymarketCandidates().catch(() => []) : Promise.resolve([]),
  ]);
  const stocks = draftStockClaims(envNum("CREATOR_STOCKS_PER_RUN", 1));
  const borrowed = polymarket.map(polymarketDraft).filter((d): d is DraftClaim => d !== null).slice(0, polymarketPerRun);
  console.log(`[creator] sources: crypto=${crypto.length} sports=${sports.length} stocks=${stocks.length} polymarket=${borrowed.length}`);
  return [...sports, ...borrowed, ...stocks, ...crypto];
}

function gateDrafts(drafts: DraftClaim[]): DraftClaim[] {
  const minQuality = envNum("CREATOR_MIN_QUALITY", 60);
  return drafts.filter((d) => {
    const problem = draftProblem(d);
    if (problem) return console.warn(`[draft] drop (${problem}): ${d.label}`), false;
    const q = scoreDraft(d);
    if (q.score < minQuality) return console.warn(`[draft] drop (quality ${q.score}): ${d.label}`), false;
    return true;
  });
}

async function vetDrafts(drafts: DraftClaim[]): Promise<DraftClaim[]> {
  if (process.env.MARKET_CREATOR_PREFLIGHT !== "1" || !drafts.length) return drafts;
  const personas = preflightPersonas(process.env.MARKET_CREATOR_PREFLIGHT_PERSONAS);
  const minScore = envNum("MARKET_CREATOR_PREFLIGHT_MIN_SCORE", 60);
  const kept: DraftClaim[] = [];
  for (const d of drafts) {
    const result = await gatherCouncilPreflight({
      candidate: {
        question: d.question,
        creatorPosition: d.creatorPosition,
        counterPosition: d.counterPosition,
        resolutionUrl: d.resolutionUrl,
        category: d.category,
        settlementRule: d.settlementRule,
        deadlineHours: Math.max(0, (d.deadline * 1000 - Date.now()) / 3_600_000),
      },
      personas,
      sequentialGapMs: 4_000,
    }).catch(() => null);
    if (!result || preflightKeeps(result, minScore)) kept.push(d);
  }
  return kept;
}

export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    await ctx.runQuery(internal.marketDeployment.check, {});
    if (process.env.MIMIR_BACKEND_OFF === "1") return; // this deployment is switched off (crons.ts)
    await ctx.runMutation(internal.arcAdmin.beat, { name: "arc-creator" });
    const e = process.env;
    const cfg = serverMarketChains(e).chains.gno;
    const wallet = houseCreatorWallet(e);
    const key = creatorMnemonic(e);
    if (!cfg.enabled || !wallet || !key) return;
    const signer = await gnoSigner(key, cfg.gno);
    if (signer.address !== wallet.address) {
      console.warn(`[creator] GNO_CREATOR_MNEMONIC signs as ${signer.address}, not GNO_CREATOR_ADDRESS ${wallet.address}; skipped`);
      return;
    }
    const own: Array<Doc<"arcMarkets"> & { chain: "gno" }> = await ctx.runQuery(internal.arc.marketsBy, { creator: wallet.address, chain: "gno" });
    const dryRun = e.MARKET_CREATOR_DRY_RUN === "1";
    const now = Math.floor(Date.now() / 1000);

    // 1. Its own VS claims that closed with nobody on the other side: cancel, the stake comes back.
    for (const m of own.filter((m) => m.kind === "vs" && m.status === "open" && m.deadline <= now)) {
      if (dryRun) continue;
      try {
        await gnoCancelVs(signer, m.marketId, cfg.gno);
      } catch (err) {
        console.warn(`[creator] cancel VS #${m.marketId}:`, err instanceof Error ? err.message : err);
      }
    }

    if (e.MIMIR_PAUSE_CREATE_MARKET === "1") return;
    const live = own.filter((m) => (m.status === "open" || m.status === "active") && m.deadline > now);
    const headroom = envNum("MAX_ACTIVE_CLAIMS", 30) - live.length;
    if (headroom <= 0) {
      console.log(`[creator] inventory at cap (${live.length})`);
      return;
    }

    const signatures = live.map((m) => signatureOf({ category: m.category, question: m.question, resolutionUrl: m.resolutionUrl }, `${m.kind} #${m.marketId}`));
    const unique = filterDuplicates(gateDrafts(await gatherDrafts()), signatures, (d, why) => console.warn(`[draft] drop (duplicate, ${why}): ${d.label}`));
    const drafts = (await vetDrafts(unique)).slice(0, headroom);
    if (!drafts.length) {
      console.log("[creator] no drafts this cycle");
      return;
    }

    const stakeUsdc = envNum("CREATOR_STAKE_USDC", 0.1);
    // The daily house budget (convex/houseBudget.ts): each open reserves its seed there first.
    const dayStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000);
    const seed = usdToIndex(stakeUsdc);
    // How many markets it can still open today (daily count, mUSD and GNOT in the account); the budget is checked per open.
    const draftsToday = own.filter((m) => m.createdAt >= dayStart).length;
    let room = Math.min(Math.max(0, envNum("CREATOR_DAILY_MARKETS", 2) - draftsToday), drafts.length);
    if (room > 0) {
      const [musd, gas] = await Promise.all([walletMusdWei(wallet.address, cfg.gno), walletGasUgnot(wallet.address, cfg.gno)]);
      if (musd < seed * BigInt(room)) {
        console.warn(`[creator] not enough mUSD on ${wallet.address} for ${room} markets; top it up`);
        room = Number(musd / seed);
      }
      if (gas < MIN_GAS_UGNOT) {
        console.warn(`[creator] no GNOT for gas on ${wallet.address}; top it up`);
        room = 0;
      }
    }
    if (room <= 0) {
      console.log("[creator] daily count used, or no funds");
      return;
    }

    let opened = false;
    for (const d of drafts.slice(0, room)) {
      if (dryRun) {
        console.log(`[creator] (dry run) would open [${d.category}] "${d.question}" closing ${new Date(d.deadline * 1000).toISOString()}`);
        continue;
      }
      const hold = await ctx.runMutation(internal.houseBudget.reserve, { chain: "gno", wei: seed.toString(), ref: `creator:${d.question.slice(0, 60)}` });
      if (hold === null) {
        console.log("[creator] daily house budget used");
        break;
      }
      try {
        await gnoCreatePool(signer, {
          question: d.question, labelA: d.creatorPosition, labelB: d.counterPosition, resolutionUrl: d.resolutionUrl, category: d.category, deadline: d.deadline, side: SIDE_A,
        }, seed, cfg.gno);
        opened = true;
      } catch (err) {
        await ctx.runMutation(internal.houseBudget.release, { id: hold });
        console.error(`[creator] failed (${d.label}):`, err instanceof Error ? err.message : err);
      }
    }
    if (opened) await ctx.scheduler.runAfter(0, internal.arcSync.sync, {});
  },
});
