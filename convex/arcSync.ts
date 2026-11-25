// The gno.land market indexer (convex/crons.ts, every 30 s). Two sources, applied together by arc.apply in one
// transaction:
//   1. state   every market of r/vs and r/pool from the realms' paged JSON views (ClaimsJSON / MarketsJSON), mapped by
//              lib/chains/snapshot.ts: realm logic is never re-implemented here. VS challengers are re-read
//              (ChallengersJSON) for claims that are new or whose stakes moved; pool positions are re-read
//              (PositionJSON) for every known staker of a pool whose totals moved.
//   2. events  the blocks after the cursor (Tendermint `block` + `block_results`), filtered to the two realms by
//              lib/gno/indexer.ts: the activity feed, stake times for the late-stake rule, and the pools' stakers
//              (the realm cannot list them). At most GNO_INDEX_MAX_BLOCKS blocks a run (default 60).
// Where the event scan starts on a fresh deployment: GNO_INDEX_FROM_BLOCK (the realms' deploy height), else the head,
// in which case pool stakes made before it are known only by their market totals.
// Finality: Tendermint blocks are final once committed. Realms not deployed yet (a "package not found" query) leave
// the run a no-op that only moves the cursor.
import { internalSecret } from "../lib/internal-secrets";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import { latestBlockHeight } from "../lib/chains/client";
import { serverMarketChains } from "../lib/chains/registry";
import { readAllMarkets, readPool, readVs, type SnapshotPosition } from "../lib/chains/snapshot";
import type { GnoConfig } from "../lib/gno/config";
import { eventRows, touchedMarkets, type IndexedBlock, type Kind } from "../lib/gno/indexer";
import { missingRealm } from "../lib/gno/rpc";
import { gnoBlock, gnoBlockResults } from "../lib/gno/tx";
import { jevEnabled } from "../lib/jev";
import { triageMarket } from "../lib/jev-triage";
import { vChain } from "./schema";

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};
const PARALLEL = 8;

async function readBlocks(from: number, to: number, cfg: GnoConfig): Promise<IndexedBlock[]> {
  const heights = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  const out: IndexedBlock[] = [];
  for (let i = 0; i < heights.length; i += PARALLEL) {
    out.push(
      ...(await Promise.all(
        heights.slice(i, i + PARALLEL).map(async (h) => {
          const b = await gnoBlock(h, cfg);
          return { ...b, results: b.txs.length ? await gnoBlockResults(h, cfg) : [] };
        }),
      )),
    );
  }
  return out;
}

export const sync = internalAction({
  // `chain` is accepted for old schedules (arc.poke); gno.land is the only chain.
  args: { chain: v.optional(vChain) },
  handler: async (ctx) => {
    await ctx.runQuery(internal.marketDeployment.check, {});
    if (process.env.MIMIR_BACKEND_OFF === "1") return; // this deployment is switched off (crons.ts)
    const chain = serverMarketChains().chains.gno;
    if (!chain.enabled) return;
    const cfg = chain.gno;
    await ctx.runMutation(internal.arcAdmin.beat, { name: "gno-sync" });

    // 1. New blocks' events.
    const head = await latestBlockHeight(cfg);
    const cursor = await ctx.runQuery(internal.arc.cursor, { name: "gno" });
    const from = cursor === null ? Math.min(envInt("GNO_INDEX_FROM_BLOCK", head), head) : cursor + 1;
    const to = Math.min(head, from + envInt("GNO_INDEX_MAX_BLOCKS", 60) - 1);
    const blocks = to >= from ? await readBlocks(from, to, cfg) : [];
    const events = eventRows(blocks, cfg);
    const touched = touchedMarkets(events);
    const block = Math.max(to, from - 1);

    // 2. Every market's state from the realms.
    let all: Awaited<ReturnType<typeof readAllMarkets>>;
    try {
      all = await readAllMarkets({ cfg, block: head });
    } catch (err) {
      if (!missingRealm(err)) throw err;
      // The realms are not on chain yet: nothing to index, keep up with the head.
      await ctx.runMutation(internal.arc.apply, { name: "gno", block, markets: [], positions: [], events: [] });
      return;
    }
    const known = new Map((await ctx.runQuery(internal.arc.indexState, {})).map((m) => [`${m.kind}:${m.marketId}`, m]));

    const markets = [];
    const positions: SnapshotPosition[] = [];
    for (const m of all.vs) {
      const k = known.get(`vs:${m.marketId}`);
      if (!k || k.stakeA !== m.stakeA || k.stakeB !== m.stakeB || touched.has(`vs:${m.marketId}`)) {
        const snap = await readVs(m.marketId, { block: head, disputeWindow: all.vsCfg.disputeWindow, cfg });
        markets.push(snap.market);
        positions.push(...snap.positions);
      } else markets.push(m);
    }
    for (const m of all.pool) {
      const key = `pool:${m.marketId}`;
      const k = known.get(key);
      const t = touched.get(key);
      if (!k || k.stakeA !== m.stakeA || k.stakeB !== m.stakeB || t) {
        const stored = k ? await ctx.runQuery(internal.arc.poolUsers, { marketId: m.marketId }) : [];
        const users = new Set<string>([m.creator, ...(t?.users ?? []), ...stored]);
        const snap = await readPool(m.marketId, [...users], { block: head, disputeWindow: all.poolCfg.disputeWindow, cfg });
        markets.push(snap.market);
        positions.push(...snap.positions);
      } else markets.push(m);
    }

    const changes = await ctx.runMutation(internal.arc.apply, { name: "gno", block, markets, positions, events });
    await notifyTelegram(ctx, changes);
    await triageNew(ctx, changes);
  },
});

type Change = { type: "new" | "proposed" | "resolved" | "cancelled"; chain: "gno"; kind: Kind; marketId: number };

/** Jev's triage of each new market (lib/jev-triage.ts). Off without TYPESAFE_API_KEY: no call, no row. */
async function triageNew(ctx: ActionCtx, changes: Change[]): Promise<void> {
  if (!jevEnabled()) return;
  for (const c of changes) {
    if (c.type !== "new") continue;
    const m = await ctx.runQuery(internal.arc.marketWithPositions, { chain: c.chain, kind: c.kind, marketId: c.marketId });
    if (!m) continue;
    const t = await triageMarket(m);
    if (t) await ctx.runMutation(internal.arcTriage.save, { chain: c.chain, kind: c.kind, marketId: c.marketId, ...t });
  }
}

/**
 * Post what changed to the site's Telegram route (app/api/telegram/arc-events), which messages the chats. Off unless
 * TELEGRAM_EVENTS_URL and the events secret (MIMIR_EVENTS_SECRET) are set; a failed post is logged, never retried (alerts are best effort).
 * "New" only for markets opened in the last hour, so a re-index does not announce old markets again.
 * No message on a proposal: people hear once, when the result is final (resolved), not while it can still change.
 */
async function notifyTelegram(ctx: ActionCtx, allChanges: Change[]): Promise<void> {
  const url = process.env.TELEGRAM_EVENTS_URL?.trim();
  const secret = internalSecret("events");
  const changes = allChanges.filter((c) => c.type !== "proposed");
  if (!url || !secret || !changes.length) return;
  const recent = Math.floor(Date.now() / 1000) - 3600;
  const events = [];
  for (const c of changes) {
    const m = await ctx.runQuery(internal.arc.marketWithPositions, { chain: c.chain, kind: c.kind, marketId: c.marketId });
    if (!m || m.isPrivate || (c.type === "new" && m.createdAt < recent)) continue;
    const holders = c.type === "cancelled" ? [{ user: m.creator, side: 1 }] : m.positions.map((p) => ({ user: p.user, side: p.side }));
    events.push({
      type: c.type,
      chain: c.chain,
      kind: m.kind,
      marketId: m.marketId,
      question: m.question,
      labelA: m.labelA,
      labelB: m.labelB,
      stakeA: m.stakeA,
      stakeB: m.stakeB,
      settlementCutoff: m.settlementCutoff,
      eligibleA: m.eligibleA,
      eligibleB: m.eligibleB,
      deadline: m.deadline,
      winner: m.winner,
      summary: m.summary,
      disputableUntil: m.disputableUntil,
      holders,
    });
  }
  if (!events.length) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(50_000),
    });
    if (!res.ok) console.warn(`[telegram] arc-events ${res.status}`);
  } catch (err) {
    console.warn("[telegram] arc-events post failed:", err instanceof Error ? err.message : err);
  }
}
