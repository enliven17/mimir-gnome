/**
 * Copying an agent's market stakes (lib/launch/copy-stake.ts).
 * GET  /api/launch/:id/copy?follower=<g1...>  the follower's subscription: on or off, the copy wallet to fund and its
 *                                             balances (public chain data; never the sealed key).
 * POST /api/launch/:id/copy                    signed by the follower: { gno?: {on, maxPerStakeUsdc}, active }.
 *                                             Makes the copy wallet (a gno.land key Mimir keeps sealed) the first time
 *                                             copying is turned on. The follower funds it with mUSD and a little GNOT.
 */
import { z } from "zod";

import { api } from "@/convex/_generated/api";
import { normalizeOwner } from "@/lib/owner";
import { COUNCIL_AGENTS } from "@/lib/launch/council-view";
import { copyKeyFor } from "@/lib/launch/copy-key";
import { fail, launchCx, readSigned } from "@/lib/launch/request";
import { indexToUsd } from "@/lib/chains/amounts";
import { MARKET_CHAINS } from "@/lib/chains/registry";
import { copyWalletScope, newSealedWallet, walletGasUgnot, walletMusdWei, walletsEnabled } from "@/lib/server/gno-wallets";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const G = MARKET_CHAINS.chains.gno.gno;
const Settings = z.object({ on: z.boolean(), maxPerStakeUsdc: z.number().min(0.1).max(50) });
const Body = z.object({ gno: Settings.optional(), active: z.boolean() });

/** Council personas always stake; a launched agent when its owner turned staking on. */
async function copyable(c: NonNullable<ReturnType<typeof launchCx>>, id: string) {
  if (COUNCIL_AGENTS[id]) return true;
  const card = await c.client.query(api.launch.card, { slug: id });
  return card ? card.markets.enabled : null;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await allowRequest("launch-copy-read", clientIp(req), 60, 60_000))) return tooManyRequests(60);
  const { id } = await ctx.params;
  const follower = normalizeOwner(new URL(req.url).searchParams.get("follower"));
  if (!follower) return fail(400, "follower must be a gno.land (g1) address");
  const c = launchCx();
  if (!c) return fail(503, "Launch is not configured on this server.");
  const can = await copyable(c, id);
  if (can === null) return fail(404, "No such agent.");
  const s = await c.client.query(api.launchCopy.forFollower, { secret: c.secret, agent: copyKeyFor(id), follower });
  const w = s?.gno ?? null;
  const [balanceUsdc, balanceGnot] = w
    ? await Promise.all([
        walletMusdWei(w.address, G).then(indexToUsd).catch(() => null),
        walletGasUgnot(w.address, G).then((u) => Number(u) / 1e6).catch(() => null),
      ])
    : [null, null];
  return Response.json(
    {
      can,
      sub: s && {
        active: s.active,
        pausedReason: s.pausedReason,
        gno: w && { address: w.address, on: w.on, maxPerStakeUsdc: w.maxPerStakeUsdc, balanceUsdc, balanceGnot },
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await readSigned(req, "copy", id);
  if (!g.ok) return g.res;
  if (!(await allowRequest("launch-copy", g.owner, 20, 10 * 60_000))) return fail(429, "Too many changes. Wait a few minutes.");
  const parsed = Body.safeParse(g.body);
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid copy settings.");
  const c = launchCx();
  if (!c) return fail(503, "Launch is not configured on this server.");
  const can = await copyable(c, id);
  if (can === null) return fail(404, "No such agent.");
  const { gno, active } = parsed.data;
  if (gno?.on && !can) return fail(400, "This agent does not stake on markets.");
  const key = copyKeyFor(id);
  try {
    const cur = await c.client.query(api.launchCopy.forFollower, { secret: c.secret, agent: key, follower: g.owner });
    let w = cur?.gno ?? undefined;
    if (gno) {
      if (!w && gno.on) {
        if (!walletsEnabled()) return fail(503, "Copy wallets are not configured on this server.");
        w = { ...newSealedWallet(copyWalletScope(key, g.owner)), maxPerStakeUsdc: 0, on: false };
      }
      if (w) w = { ...w, on: gno.on, maxPerStakeUsdc: gno.maxPerStakeUsdc };
    }
    // The stored wallet wins: a racing request's fresh wallet is dropped here, never handed out.
    const stored = await c.client.mutation(api.launchCopy.upsert, { secret: c.secret, agent: key, follower: g.owner, ...(w ? { gno: w } : {}), active });
    return Response.json({ ok: true, gno: stored.gno });
  } catch (e) {
    console.error(`[launch] copy ${id} failed:`, e);
    return fail(502, "Could not set up the copy wallet. Try again.");
  }
}
