import { assertMarketDeployment } from "./marketDeploymentGuard";
// Mimir Launch: hosted agents' records. Writes come only from the web server with MIMIR_LAUNCH_SECRET
// (lib/launch/flow.ts, lib/launch/token.ts); the public views never return a sealed key, a wallet id or the uid.
import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { secretMatches } from "../lib/internal-secrets";
import { reservedLaunchSlug } from "../lib/launch/copy-key";
import { vAgentToken, vChain, vSealedWallet } from "./schema";

function allowed(secret: string) {
  if (!secretMatches("launch", secret)) throw new Error("not allowed");
}

const bySlug = (ctx: QueryCtx | MutationCtx, slug: string) =>
  ctx.db.query("launchAgents").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();

const vBrain = v.union(
  v.object({ kind: v.literal("mimir") }),
  v.object({ kind: v.literal("byok"), provider: v.string(), sealed: v.string(), last4: v.string(), model: v.string() }),
);

const log = (ctx: MutationCtx, agent: Doc<"launchAgents">["_id"], kind: string, text: string, extra: { chain?: "gno"; tx?: string } = {}) =>
  ctx.db.insert("launchEvents", { agent, at: Date.now(), kind, text: text.slice(0, 300), ...extra });

/** A new agent is live at once: creating one is free, staking waits for its owner's mUSD (and GNOT for gas) in its wallet. */
export const create = mutation({
  args: {
    secret: v.string(), slug: v.string(), uid: v.string(), owner: v.string(), name: v.string(), ticker: v.string(), avatarSeed: v.string(), thesis: v.string(),
    brain: vBrain,
    markets: v.object({ enabled: v.boolean(), rules: v.any(), budgetUsdc: v.number(), create: v.optional(v.object({ enabled: v.boolean(), perDay: v.number() })) }),
    /** Its gno.land account: the address and the sealed key (lib/server/gno-wallets.ts). */
    gno: vSealedWallet,
  },
  handler: async (ctx, { secret, ...a }) => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    // Never a persona's or a house name (lib/launch/copy-key.ts), checked again here and for every suffixed try.
    if (reservedLaunchSlug(a.slug)) return { ok: false as const, reason: "reserved" as const };
    // Tickers may repeat; the slug in the URL stays unique: odin, odin-2, ...
    let slug = a.slug;
    for (let n = 2; reservedLaunchSlug(slug) || (await bySlug(ctx, slug)); n++) {
      if (n > 999) return { ok: false as const, reason: "taken" as const };
      slug = `${a.slug}-${n}`;
    }
    const id = await ctx.db.insert("launchAgents", { ...a, slug, status: "live", createdAt: Date.now() });
    await log(ctx, id, "rules", "created: send mUSD and a little GNOT for gas to its gno.land account and it starts staking", { chain: "gno" });
    return { ok: true as const, slug };
  },
});

/** What the owner's routes need (token launch, withdrawals): never the sealed brain. */
export const forOwner = query({
  args: { secret: v.string(), slug: v.string() },
  handler: async (ctx, { secret, slug }) => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const a = await bySlug(ctx, slug);
    return a && {
      owner: a.owner, name: a.name, ticker: a.ticker, avatarSeed: a.avatarSeed, status: a.status, uid: a.uid, gno: a.gno ?? null, token: a.token ?? null,
    };
  },
});

/**
 * The owner's token launch, checked on chain by lib/launch/token.ts. Never replaced once recorded; a token is never
 * recorded on two agents.
 */
export const recordToken = mutation({
  args: { secret: v.string(), slug: v.string(), owner: v.string(), token: vAgentToken },
  handler: async (ctx, { secret, slug, owner, token }): Promise<"ok" | "has-token" | "taken" | "no-agent"> => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const a = await bySlug(ctx, slug);
    if (!a || a.owner !== owner) return "no-agent";
    if (a.token) return a.token.address.toLowerCase() === token.address.toLowerCase() ? "ok" : "has-token";
    if (await ctx.db.query("launchAgents").withIndex("by_token", (q) => q.eq("token.address", token.address)).first()) return "taken";
    await ctx.db.patch(a._id, { token });
    await log(ctx, a._id, "rules", `its owner launched $${a.ticker} as a GRC20 on gno.land; the owner is its admin`, { chain: token.chain, tx: token.launchTx });
    return "ok";
  },
});

export const logEvent = mutation({
  args: { secret: v.string(), slug: v.string(), kind: v.union(v.literal("rules"), v.literal("error")), text: v.string() },
  handler: async (ctx, { secret, slug, kind, text }) => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const a = await bySlug(ctx, slug);
    if (a) await log(ctx, a._id, kind, text);
  },
});

/** Only the owner; never out of 'killed'. */
export const setStatus = mutation({
  args: { secret: v.string(), slug: v.string(), owner: v.string(), status: v.union(v.literal("live"), v.literal("paused"), v.literal("killed")) },
  handler: async (ctx, { secret, slug, owner, status }) => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const a = await bySlug(ctx, slug);
    if (!a || a.owner !== owner || a.status === "killed") return false;
    await ctx.db.patch(a._id, { status });
    await log(ctx, a._id, "rules", status === "killed"
      ? "shut down by its owner: no new stakes (open stakes settle on their own; withdraw mUSD any time)"
      : `${status === "live" ? "resumed" : "paused"} by its owner`);
    return true;
  },
});

// ---------------- public views ----------------

const publicView = (a: Doc<"launchAgents">) => ({
  slug: a.slug, owner: a.owner, name: a.name, ticker: a.ticker, avatarSeed: a.avatarSeed, thesis: a.thesis, status: a.status,
  brain: a.brain.kind === "byok" ? { kind: "byok" as const, provider: a.brain.provider, last4: a.brain.last4, model: a.brain.model } : a.brain,
  markets: { enabled: a.markets.enabled, budgetUsdc: a.markets.budgetUsdc, create: a.markets.create?.enabled ?? false },
  gno: a.gno?.address ?? null, createdAt: a.createdAt,
  token: a.token ? { chain: a.token.chain, address: a.token.address, symbol: a.token.symbol, launchTx: a.token.launchTx } : null,
});
export type PublicAgent = ReturnType<typeof publicView>;

/** The agent's card: what anyone may see (its face, wallets, token). */
export const card = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    await assertMarketDeployment(ctx);
    const a = await bySlug(ctx, slug);
    return a ? publicView(a) : null;
  },
});

/** The full agent page (its reasoning log), served by /api/launch/:id/detail with its market record. */
export const detail = query({
  args: { secret: v.string(), slug: v.string() },
  handler: async (ctx, { secret, slug }) => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const a = await bySlug(ctx, slug);
    if (!a) return null;
    const events = await ctx.db.query("launchEvents").withIndex("by_agent", (q) => q.eq("agent", a._id)).order("desc").take(50);
    return { ...publicView(a), events: events.map((e) => ({ at: e.at, kind: e.kind, text: e.text, chain: e.chain ?? null, tx: e.tx ?? null })) };
  },
});

export const byOwner = query({
  args: { owner: v.string() },
  handler: async (ctx, { owner }) =>
    {
    await assertMarketDeployment(ctx);
    return (await ctx.db.query("launchAgents").withIndex("by_owner", (q) => q.eq("owner", owner)).order("desc").take(50)).map(publicView);
  },
});

// ---------------- the market tick (convex/launchArc.ts) ----------------

/**
 * What an agent holds (keys "chain:kind:id") and how much is still out (unsettled, mUSD), from the chain (the indexed
 * positions of its account) and from our own records: a send that timed out can still land, and the index sees it
 * within seconds, so it is never staked twice. Also used by
 * convex/launchMarketsDb.ts for the seed stake of a market it opens.
 */
export async function holdings(ctx: QueryCtx | MutationCtx, a: Doc<"launchAgents">): Promise<{ held: string[]; openUsdc: number }> {
  const recorded = await ctx.db.query("launchStakes").withIndex("by_agent", (q) => q.eq("agent", a._id)).collect();
  const out = new Map<string, number>();
  const wallets = a.gno ? [a.gno.address.toLowerCase()] : [];
  for (const w of wallets) {
    for (const p of await ctx.db.query("arcPositions").withIndex("by_user", (q) => q.eq("user", w)).collect()) {
      const k = `${p.chain ?? "gno"}:${p.kind}:${p.marketId}`;
      out.set(k, (out.get(k) ?? 0) + Number(BigInt(p.amount)) / 1e18);
    }
  }
  for (const s of recorded) {
    const k = `${s.chain ?? "gno"}:${s.kind}:${s.marketId}`;
    if (!out.has(k)) out.set(k, s.usdc);
  }
  let openUsdc = 0;
  for (const [key, usdc] of out) {
    const [chain, kind, id] = key.split(":") as ["gno", "vs" | "pool", string];
    const m = await ctx.db.query("arcMarkets").withIndex("by_market", (q) => q.eq("chain", chain).eq("kind", kind).eq("marketId", Number(id))).unique();
    if (!m || !["resolved", "cancelled"].includes(m.status)) openUsdc += usdc;
  }
  return { held: [...out.keys()], openUsdc };
}

/**
 * Live agents with markets on whose turn it is, claimed for this tick: lastTickAt moves first, so an overlapping
 * run skips them (one worker per agent). The sealed brain goes only to the internal action.
 */
export const claimMarketAgents = internalMutation({
  args: { now: v.number(), everyMs: v.number(), max: v.number() },
  handler: async (ctx, { now, everyMs, max }) => {
    await assertMarketDeployment(ctx);
    const live = await ctx.db.query("launchAgents").withIndex("by_status", (q) => q.eq("status", "live")).take(500);
    const due = live.filter((a) => a.markets.enabled && (a.lastTickAt ?? 0) <= now - everyMs).sort((a, b) => (a.lastTickAt ?? 0) - (b.lastTickAt ?? 0)).slice(0, max);
    for (const a of due) await ctx.db.patch(a._id, { lastTickAt: now });
    return Promise.all(due.map(async (a) => {
      const { held, openUsdc } = await holdings(ctx, a);
      return { id: a._id, slug: a.slug, uid: a.uid, thesis: a.thesis, brain: a.brain, markets: a.markets, gno: a.gno ?? null, house: a.house ?? null, held, openUsdc };
    }));
  },
});

export const recordStake = internalMutation({
  args: { agent: v.id("launchAgents"), chain: vChain, kind: v.union(v.literal("vs"), v.literal("pool")), marketId: v.number(), side: v.number(), usdc: v.number(), p: v.number(), edge: v.number(), why: v.string(), tx: v.string(), text: v.string() },
  handler: async (ctx, { text, ...s }) => {
    await assertMarketDeployment(ctx);
    await ctx.db.insert("launchStakes", { ...s, at: Date.now() });
    await log(ctx, s.agent, "stake", text, { chain: s.chain, tx: s.tx });
    const [a, m] = await Promise.all([ctx.db.get(s.agent), ctx.db.query("arcMarkets").withIndex("by_market", (q) => q.eq("chain", s.chain).eq("kind", s.kind).eq("marketId", s.marketId)).unique()]);
    if (a && m && !m.isPrivate) await ctx.db.insert("discoverySignals", { marketChain: s.chain, marketKind: s.kind, marketId: s.marketId, category: m.category, slug: a.slug,
      type: "agent_stake", text: `${a.name} staked on ${s.side === 1 ? m.labelA : m.labelB}: ${m.question}`, at: Date.now() });
  },
});

export const note = internalMutation({
  args: { agent: v.id("launchAgents"), kind: v.string(), text: v.string(), pause: v.optional(v.boolean()) },
  handler: async (ctx, { agent, kind, text, pause }) => {
    await assertMarketDeployment(ctx);
    await log(ctx, agent, kind, text);
    const a = await ctx.db.get(agent);
    if (pause && a?.status === "live") await ctx.db.patch(agent, { status: "paused" });
  },
});

/** The launch page's directory: every agent but the council's, newest first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await assertMarketDeployment(ctx);
    const out = [];
    for (const status of ["live", "paused", "killed"] as const) {
      out.push(...(await ctx.db.query("launchAgents").withIndex("by_status", (q) => q.eq("status", status)).order("desc").take(100)));
    }
    return out.filter((a) => !a.house).sort((a, b) => b.createdAt - a.createdAt).map(publicView);
  },
});

/** Public market participation evidence; final outcomes and collected payouts remain distinct. */
export const publicMarketRecord = query({
  args: { address: v.string() },
  handler: async (ctx, { address }) => {
    await assertMarketDeployment(ctx);
    if (!/^g1[02-9ac-hj-np-z]{38}$/i.test(address)) return null;
    const rows = await ctx.db.query("arcPositions").withIndex("by_user", (q) => q.eq("user", address.toLowerCase())).take(301);
    const records = [];
    for (const p of rows.slice(0, 300)) {
      const chain = p.chain ?? "gno";
      const m = await ctx.db.query("arcMarkets").withIndex("by_market", (q) => q.eq("chain", chain).eq("kind", p.kind).eq("marketId", p.marketId)).unique();
      if (!m || m.isPrivate) continue;
      const outcome = m.status === "cancelled" || (m.status === "resolved" && m.winner > 2) ? "refunded" : m.status !== "resolved" ? "open" : m.winner === p.side ? "won" : "lost";
      records.push({ chain, kind: p.kind, marketId: p.marketId, question: m.question, outcome, netStake: p.amount, claimed: p.claimed ?? null });
    }
    return { records, limited: rows.length > 300 };
  },
});

/**
 * Any gno.land account's record on Mimir markets, from the index: every position with its market and outcome. `pnl` is
 * the pari-mutuel result before fees (won: its share of the losing side; lost: minus the stake; open or refunded: 0).
 */
export const arcRecord = query({
  args: { secret: v.string(), address: v.string() },
  handler: async (ctx, { secret, address }) => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const user = address.toLowerCase();
    const positions = await ctx.db.query("arcPositions").withIndex("by_user", (q) => q.eq("user", user)).order("desc").take(300);
    const bets = [];
    for (const p of positions) {
      const chain = p.chain ?? "gno";
      const m = await ctx.db.query("arcMarkets").withIndex("by_market", (q) => q.eq("chain", chain).eq("kind", p.kind).eq("marketId", p.marketId)).unique();
      if (!m) continue;
      const usdc = Number(BigInt(p.amount)) / 1e18;
      const same = Number(BigInt(p.side === 1 ? m.stakeA : m.stakeB)) / 1e18, other = Number(BigInt(p.side === 1 ? m.stakeB : m.stakeA)) / 1e18;
      const outcome = m.status === "cancelled" || (m.status === "resolved" && m.winner > 2) ? "refunded" : m.status !== "resolved" ? "open" : m.winner === p.side ? "won" : "lost";
      const pnl = outcome === "won" ? (same > 0 ? (usdc / same) * other : 0) : outcome === "lost" ? -usdc : 0;
      bets.push({ chain, kind: p.kind, marketId: p.marketId, side: p.side, label: p.side === 1 ? m.labelA : m.labelB, question: m.question, usdc, outcome, pnl, deadline: m.deadline });
    }
    return bets;
  },
});

/**
 * The owner's withdrawal takes the agent's lease like a tick does (one spender per wallet at a time). Returns the
 * lease token, or null while a tick or another withdrawal holds it.
 */
export const leaseForOwner = mutation({
  args: { secret: v.string(), slug: v.string(), owner: v.string() },
  handler: async (ctx, { secret, slug, owner }): Promise<number | null> => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const a = await bySlug(ctx, slug);
    const now = Date.now();
    if (!a || a.owner !== owner || (a.leaseUntil !== undefined && a.leaseUntil > now)) return null;
    const until = now + 3 * 60_000;
    await ctx.db.patch(a._id, { leaseUntil: until });
    return until;
  },
});

export const releaseForOwner = mutation({
  args: { secret: v.string(), slug: v.string(), token: v.number() },
  handler: async (ctx, { secret, slug, token }) => {
    await assertMarketDeployment(ctx);
    allowed(secret);
    const a = await bySlug(ctx, slug);
    if (a?.leaseUntil === token) await ctx.db.patch(a._id, { leaseUntil: undefined });
  },
});
