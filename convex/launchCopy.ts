import { assertMarketDeployment } from "./marketDeploymentGuard";
// Mimir Launch copy staking: subscriptions and the per-follower copy jobs (lib/launch/copy-stake.ts). The web server
// (MIMIR_LAUNCH_SECRET) creates and changes subscriptions; the agent ticks fan out jobs (convex/launchCopyJobs.ts).
// Subscriptions are keyed by lib/launch/copy-key.ts ("council:<slug>", "launch:<slug>"), so a launched agent can never
// reach a council persona's followers.
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { secretMatches } from "../lib/internal-secrets";
import { keepStoredWallet } from "../lib/launch/copy-stake";
import { vChain } from "./schema";

/** A follower's copy wallet: address, sealed key (lib/server/gno-wallets.ts), cap and whether copying is on. */
const vCopyWallet = v.object({ address: v.string(), sealed: v.string(), maxPerStakeUsdc: v.number(), on: v.boolean() });

function allowed(secret: string) {
  if (!secretMatches("launch", secret)) throw new Error("not allowed");
}

const sub = (ctx: QueryCtx | MutationCtx, agent: string, follower: string) =>
  ctx.db.query("launchCopies").withIndex("by_agent_follower", (q) => q.eq("agent", agent).eq("follower", follower)).unique();

const job = (ctx: QueryCtx | MutationCtx, key: string) => ctx.db.query("launchCopyJobs").withIndex("by_key", (q) => q.eq("key", key)).unique();

// ---------------- web side ----------------

/** The follower's subscription with its copy wallet (server only: the route never returns the sealed key). `agent` is a copy key. */
export const forFollower = query({
  args: { secret: v.string(), agent: v.string(), follower: v.string() },
  handler: async (ctx, { secret, agent, follower }) => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const s = await sub(ctx, agent, follower);
    if (!s) return null;
    return { gno: s.gno ?? null, active: s.active, pausedReason: s.pausedReason ?? null };
  },
});

/**
 * Start or change a subscription. The copy wallet, once stored, is never replaced: two racing first requests may each
 * make a wallet, but only the first one stored is kept and returned (the other was never handed out, so it is empty).
 * Returns the stored copy wallet address.
 */
export const upsert = mutation({
  args: { secret: v.string(), agent: v.string(), follower: v.string(), gno: v.optional(vCopyWallet), active: v.boolean() },
  handler: async (ctx, { secret, agent, follower, gno, active }): Promise<{ gno: string | null }> => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const s = await sub(ctx, agent, follower);
    const w = keepStoredWallet(s?.gno, gno);
    const patch = { ...(w ? { gno: w } : {}), active, pausedReason: undefined };
    if (s) await ctx.db.patch(s._id, patch);
    else await ctx.db.insert("launchCopies", { agent, follower, ...patch, createdAt: Date.now() });
    return { gno: w?.address ?? null };
  },
});

// ---------------- fan-out (the agent ticks) ----------------

/** Copy subscriptions behind a copy key (launch agent or council persona): active, with copying on. */
export const arcSubs = internalQuery({
  args: { agent: v.string(), chain: v.optional(vChain) },
  handler: async (ctx, { agent }) =>
    {
    await assertMarketDeployment(ctx);
    return (await ctx.db.query("launchCopies").withIndex("by_agent", (q) => q.eq("agent", agent)).collect()).filter((s) => s.active && s.gno?.on).map((s) => ({ id: s._id as string }));
  },
});

// ---------------- one follower's job ----------------

/** One subscription's copy wallet, or null when it has none. */
export const arcSub = internalQuery({
  args: { sub: v.id("launchCopies"), chain: v.optional(vChain) },
  handler: async (ctx, { sub: id }) => {
    await assertMarketDeployment(ctx);
    const s = await ctx.db.get(id);
    const w = s?.gno;
    return s && w ? { id: s._id as string, agent: s.agent, follower: s.follower, sealed: w.sealed, wallet: w.address, maxPerStakeUsdc: w.maxPerStakeUsdc, active: s.active, on: w.on } : null;
  },
});

/** Takes a job's key once. */
export const claim = internalMutation({
  args: { key: v.string(), sub: v.id("launchCopies"), chain: v.optional(vChain) },
  handler: async (ctx, a): Promise<boolean> => {
    await assertMarketDeployment(ctx);
    if (await job(ctx, a.key)) return false;
    await ctx.db.insert("launchCopyJobs", { ...a, status: "running", at: Date.now() });
    return true;
  },
});

export const finish = internalMutation({
  args: { key: v.string(), status: v.union(v.literal("done"), v.literal("failed"), v.literal("unknown"), v.literal("skipped")), note: v.optional(v.string()) },
  handler: async (ctx, { key, status, note }) => {
    await assertMarketDeployment(ctx);
    const j = await job(ctx, key);
    if (j && j.status !== "done") await ctx.db.patch(j._id, { status, ...(note ? { note: note.slice(0, 200) } : {}) });
  },
});
