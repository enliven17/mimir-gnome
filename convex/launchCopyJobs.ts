"use node";

// Mimir Launch copy staking, one follower at a time (lib/launch/copy-stake.ts). The agent ticks (launchArc, arcCouncil)
// only schedule these, one per follower and agent stake, so a slow follower never holds up the agent or the others
// and a long fan-out never runs past an action's time limit. Each job runs once (its key).
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { indexToUsd, usdToIndex } from "../lib/chains/amounts";
import { serverMarketChains } from "../lib/chains/registry";
import { runArcCopy } from "../lib/launch/copy-stake";
import { createConsoleLogger } from "../lib/launch/log";
import { copyWalletScope, gnoStake, MIN_GAS_UGNOT, sealedSigner, walletGasUgnot, walletMusdWei } from "../lib/server/gno-wallets";
import { vChain } from "./schema";

const log = createConsoleLogger({ level: process.env.LOG_LEVEL, base: { svc: "launch-copy" } });
const gated = () => process.env.MIMIR_BACKEND_OFF === "1";

/** One follower's copy of a leader's pool stake, from the follower's copy wallet. */
export const arcOne = internalAction({
  args: { key: v.string(), sub: v.id("launchCopies"), chain: v.optional(vChain), marketId: v.number(), side: v.number() },
  handler: async (ctx, a): Promise<string> => {
    await ctx.runQuery(internal.marketDeployment.check, {});
    if (gated()) return "gated";
    const chain = "gno" as const;
    const cfg = serverMarketChains().chains.gno;
    if (!cfg.enabled) return "chain off";
    try {
      return await runArcCopy(
        {
          store: {
            claim: (key, sub) => ctx.runMutation(internal.launchCopy.claim, { key, sub: sub as typeof a.sub, chain }),
            finish: async (key, status, note) => void (await ctx.runMutation(internal.launchCopy.finish, { key, status, ...(note ? { note } : {}) })),
            arcSub: (id) => ctx.runQuery(internal.launchCopy.arcSub, { sub: id as typeof a.sub, chain }),
          },
          // A copy wallet without GNOT cannot pay gas: it counts as empty (skipped, "copy wallet short").
          balanceUsdc: async (wallet) =>
            (await walletGasUgnot(wallet, cfg.gno)) < MIN_GAS_UGNOT ? 0 : indexToUsd(await walletMusdWei(wallet, cfg.gno)),
          stake: async ({ sub, marketId, side, amountUsdc }) => {
            const signer = await sealedSigner(copyWalletScope(sub.agent, sub.follower), { address: sub.wallet, sealed: sub.sealed }, cfg.gno);
            return (await gnoStake(signer, { kind: "pool", marketId, side, wei: usdToIndex(amountUsdc) }, cfg.gno)).txHash;
          },
          log,
          minStakeUsdc: indexToUsd(cfg.minStakeWei),
        },
        a,
      );
    } catch (err) {
      log.error("copy job failed", { key: a.key, err });
      return "failed";
    }
  },
});
