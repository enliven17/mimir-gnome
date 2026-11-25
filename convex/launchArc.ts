"use node";

// Mimir Launch, the market side of an agent's tick on gno.land: pick the open pools its rules allow, let its brain
// (Mimir AI or the owner's key) give P(side A), stake the best edge at a fraction of Kelly from its own account (a key
// Mimir generated and keeps sealed, lib/server/gno-wallets.ts). At most one stake per agent per tick. The account pays
// gas in GNOT: without GNOT it does not stake. The budget (markets.budgetUsdc) counts what is out.
// Env: LAUNCH_AGENTS=1 to run, LAUNCH_AGENTS_DRY_RUN=1 to decide without staking, GNO_WALLET_SECRET to open the sealed
// keys, plus the LLM keys the council uses.
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { indexToUsd, usdToIndex } from "../lib/chains/amounts";
import { serverMarketChains } from "../lib/chains/registry";
import { LOCK_SECONDS } from "../lib/arc/markets";
import { byokRouter, type SealedKey } from "../lib/launch/byok";
import { platformRouter } from "../lib/launch/llm";
import { judgeMarkets, marketCandidates, pickStake, playsChain, type MarketRules, type MarketView } from "../lib/launch/markets";
import { gnoStake, launchWalletScope, MIN_GAS_UGNOT, sealedSigner, walletGasUgnot, walletMusdWei } from "../lib/server/gno-wallets";
import { copyArcStake } from "../lib/launch/arc-copy";
import { launchCopyKey } from "../lib/launch/copy-key";
import { createConsoleLogger } from "../lib/launch/log";

const copyLog = createConsoleLogger({ level: process.env.LOG_LEVEL, base: { svc: "launch-copy" } });

const EVERY_MS = 10 * 60_000;
const AGENTS_PER_TICK = 10;
const usdc = (wei: string | bigint) => Number(BigInt(wei)) / 1e18;

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runQuery(internal.marketDeployment.check, {});
    const e = process.env;
    if (e.MIMIR_BACKEND_OFF === "1" || e.LAUNCH_AGENTS !== "1") return;
    const cfg = serverMarketChains(e).chains.gno;
    if (!cfg.enabled) return;
    const agents = await ctx.runMutation(internal.launch.claimMarketAgents, { now: Date.now(), everyMs: EVERY_MS, max: AGENTS_PER_TICK });
    if (!agents.length) return;
    const nowS = Math.floor(Date.now() / 1000);
    const markets: MarketView[] = (await ctx.runQuery(internal.arc.openMarkets, { closesAfter: nowS + LOCK_SECONDS, chain: "gno" })).map((m) => ({
      chain: "gno", kind: m.kind, marketId: m.marketId, question: m.question, labelA: m.labelA, labelB: m.labelB, category: m.category,
      deadline: m.deadline, lockAt: m.lockAt ?? 0, usdcA: usdc(m.stakeA), usdcB: usdc(m.stakeB), status: "open",
    }));
    let staked = false;

    for (const a of agents) {
      const say = (kind: string, text: string, pause?: boolean) => ctx.runMutation(internal.launch.note, { agent: a.id, kind, text, pause });
      const rules = a.markets.rules as MarketRules;
      if (!a.gno || !playsChain(rules, "gno")) continue;
      try {
        const candidates = marketCandidates(markets, rules, new Set(a.held), nowS);
        if (!candidates.length) continue;
        const [musdWei, gas] = await Promise.all([walletMusdWei(a.gno.address, cfg.gno), walletGasUgnot(a.gno.address, cfg.gno)]);
        if (gas < MIN_GAS_UGNOT) continue; // no GNOT for gas yet
        const budget = Math.min(a.markets.budgetUsdc - a.openUsdc, indexToUsd(musdWei));
        if (budget < 0.1) continue;
        // Mimir's keys never stand in for an owner's key. A key the provider refuses (401/403) pauses the agent; any
        // other failure (rate limit, timeout) is just no stake this tick.
        let keyError: string | null = null;
        const brain = a.brain.kind === "byok" ? byokRouter(a.uid, a.brain as SealedKey) : platformRouter;
        const router: typeof brain = {
          completeJson: (o, parse) => brain.completeJson(o, parse).catch((err: unknown) => {
            keyError = err instanceof Error ? err.message : String(err);
            throw err;
          }),
        };
        const judged = await judgeMarkets(router, a.thesis, candidates, nowS);
        if (!judged.size) {
          if (a.brain.kind === "byok" && keyError !== null && / (401|403)/.test(keyError)) {
            await say("error", "your API key was refused: agent paused. Check the key, then resume.", true);
          }
          continue;
        }
        const pick = pickStake(judged, candidates, rules, budget, indexToUsd(cfg.minStakeWei));
        if (!pick) {
          await say("hold", `read ${judged.size} market${judged.size > 1 ? "s" : ""}, no edge worth a stake`);
          continue;
        }
        const label = pick.side === 1 ? pick.market.labelA : pick.market.labelB;
        const amount = pick.stakeUsdc.toFixed(2);
        const why = `${Math.round(pick.p * 100)}% vs pool ${Math.round((pick.p - pick.edge) * 100)}%: ${pick.why}`.slice(0, 200);
        if (e.LAUNCH_AGENTS_DRY_RUN === "1") {
          await say("hold", `[dry run] would stake ${amount} mUSD on "${label}" in pool #${pick.market.marketId}. ${why}`);
          continue;
        }
        const signer = await sealedSigner(launchWalletScope(a.uid), a.gno, cfg.gno);
        const { txHash: tx } = await gnoStake(signer, { kind: "pool", marketId: pick.market.marketId, side: pick.side, wei: usdToIndex(Number(amount)) }, cfg.gno);
        staked = true;
        await ctx.runMutation(internal.launch.recordStake, {
          agent: a.id, chain: "gno", kind: pick.market.kind, marketId: pick.market.marketId, side: pick.side, usdc: Number(amount), p: pick.p, edge: pick.edge, why: pick.why, tx,
          text: `staked ${amount} mUSD on "${label}" (${pick.market.question.slice(0, 80)}). ${why}`,
        });
        // Counted at once so the next agent sees the moved pool.
        pick.market[pick.side === 1 ? "usdcA" : "usdcB"] += Number(amount);
        // Followers copying its stakes do the same from their own copy wallets.
        await copyArcStake(ctx, copyLog, launchCopyKey(a.slug), pick.market, pick.side, tx);
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
        console.warn(`[launch] ${a.id}: ${msg}`);
        await say("error", `market step failed: ${msg}`).catch(() => undefined);
      }
    }
    if (staked) await ctx.scheduler.runAfter(0, internal.arcSync.sync, {});
  },
});
