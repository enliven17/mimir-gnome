"use node";

// Mimir Launch: one agent opens one market, if its owner turned that on (convex/launchMarketsDb.ts schedules it).
// The brain drafts it; lib/launch/agent-markets.ts holds it to the house creator's bar; the pool opens from the agent's
// own gno.land account (its sealed key) with its seed stake. Under the agent lease, so it never overlaps a tick
// spending from the same agent. LAUNCH_AGENTS_DRY_RUN=1 drafts and checks without opening.
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { signatureOf } from "../agents/market-creator/dedupe";
import { indexToUsd } from "../lib/chains/amounts";
import { serverMarketChains } from "../lib/chains/registry";
import { gnoCreatePool, launchWalletScope, MIN_GAS_UGNOT, sealedSigner, walletGasUgnot, walletMusdWei } from "../lib/server/gno-wallets";
import { espnResult } from "../lib/espn";
import { agentDraftProblem, buildAgentMarketPrompt, parseAgentDraft } from "../lib/launch/agent-markets";
import { byokRouter, type SealedKey } from "../lib/launch/byok";
import { platformRouter } from "../lib/launch/llm";

export const createOne = internalAction({
  args: { id: v.id("launchAgents") },
  handler: async (ctx, { id }) => {
    await ctx.runQuery(internal.marketDeployment.check, {});
    const e = process.env;
    if (e.MIMIR_BACKEND_OFF === "1" || e.LAUNCH_AGENTS !== "1" || e.LAUNCH_AGENT_MARKETS !== "1") return;
    const cfg = serverMarketChains(e).chains.gno;
    if (!cfg.enabled) return;
    const lease = await ctx.runMutation(internal.launchAgentsDb.acquire, { id });
    if (lease === null) return;
    const say = (kind: string, text: string, pause?: boolean) => ctx.runMutation(internal.launch.note, { agent: id, kind, text, pause });
    try {
      const a = await ctx.runQuery(internal.launchMarketsDb.forCreate, { id });
      if (!a) return;
      const nowS = Math.floor(Date.now() / 1000);
      const open = await ctx.runQuery(internal.arc.openMarkets, { closesAfter: nowS });

      // Mimir's keys never stand in for an owner's key; a refused key pauses the agent, anything else waits an hour.
      let keyError: string | null = null;
      const router = a.brain.kind === "byok" ? byokRouter(a.uid, a.brain as SealedKey) : platformRouter;
      const reply = await router
        .completeJson(buildAgentMarketPrompt(a.thesis, a.categories, open.map((m) => m.question), nowS), (x) => x)
        .catch((err: unknown) => ((keyError = err instanceof Error ? err.message : String(err)), null));
      if (!reply) {
        if (a.brain.kind === "byok" && keyError !== null && / (401|403)/.test(keyError)) await say("error", "your API key was refused: agent paused. Check the key, then resume.", true);
        return;
      }
      const draft = parseAgentDraft(reply.data);
      if (!draft) return void (await say("hold", "drafted a market the checks could not read; not opened"));

      let kickoff: number | null | undefined;
      if (draft.category === "sports") {
        const r = await espnResult(draft.resolutionUrl);
        kickoff = r && !r.completed && Number.isFinite(r.startAt) ? r.startAt : null;
      }
      const problem = agentDraftProblem(draft, {
        nowS,
        categories: a.categories,
        open: open.map((m) => signatureOf({ category: m.category, question: m.question, resolutionUrl: m.resolutionUrl }, `${m.kind} #${m.marketId}`)),
        kickoff,
      });
      if (problem) return void (await say("hold", `drafted "${draft.question.slice(0, 90)}" but did not open it: ${problem}`));

      // Its seed stake is the pool minimum, inside its budget; gas is GNOT from the same account.
      const seedWei = cfg.minStakeWei;
      const seed = indexToUsd(seedWei);
      const [musd, gas] = await Promise.all([walletMusdWei(a.gno.address, cfg.gno), walletGasUgnot(a.gno.address, cfg.gno)]);
      if (gas < MIN_GAS_UGNOT || a.budgetUsdc - a.openUsdc < seed || indexToUsd(musd) < seed) {
        return void (await say("hold", `wanted to open "${draft.question.slice(0, 90)}" but its account cannot fund the seed stake (mUSD, and GNOT for gas)`));
      }
      if (e.LAUNCH_AGENTS_DRY_RUN === "1") return void (await say("hold", `[dry run] would open "${draft.question.slice(0, 120)}" (${draft.category}), closing ${new Date(draft.deadline * 1000).toISOString()}`));

      try {
        const signer = await sealedSigner(launchWalletScope(a.uid), a.gno, cfg.gno);
        const { txHash: tx } = await gnoCreatePool(signer, draft, seedWei, cfg.gno);
        await ctx.runMutation(internal.launchMarketsDb.record, {
          agent: id, chain: "gno", question: draft.question, category: draft.category, resolutionUrl: draft.resolutionUrl, deadline: draft.deadline,
          side: draft.side, seedUsdc: seed, tx, why: draft.why,
        });
        await ctx.scheduler.runAfter(0, internal.arcSync.sync, {});
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
        await say("error", `opening the market failed: ${msg}`).catch(() => undefined);
      }
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
      console.warn(`[launch-markets] ${id}: ${msg}`);
      await say("error", `opening a market failed: ${msg}`).catch(() => undefined);
    } finally {
      await ctx.runMutation(internal.launchAgentsDb.release, { id, token: lease });
    }
  },
});
