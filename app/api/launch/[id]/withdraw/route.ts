/**
 * POST /api/launch/:id/withdraw { amount, chain?: "gno", asset? }: part (or all) of an agent's free funds back to its
 * owner's gno.land account, signed by the owner. Never to an address from the request. Open stakes stay put and settle
 * on their own. Returns the gno tx hash.
 *   asset  "musd" (default; "usdc" is accepted for older clients) or "gnot": the gas money the owner sent it
 * Gas is GNOT, so all its mUSD is free; a GNOT withdrawal leaves enough for its own transfer.
 */
import { z } from "zod";

import { api } from "@/convex/_generated/api";
import { indexToDecimal6 } from "@/lib/chains/amounts";
import { MARKET_CHAINS } from "@/lib/chains/registry";
import { fail, launchCx, readSigned } from "@/lib/launch/request";
import { normalizeOwner } from "@/lib/owner";
import { gnoSendMusd, launchWalletScope, MIN_GAS_UGNOT, sealedSigner, walletGasUgnot, walletMusdWei } from "@/lib/server/gno-wallets";
import { allowRequest } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const G = MARKET_CHAINS.chains.gno.gno;

const Body = z.object({
  amount: z.number().positive().max(1_000_000),
  chain: z.literal("gno").default("gno"),
  asset: z.enum(["musd", "usdc", "gnot"]).default("musd"),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await readSigned(req, "withdraw", id);
  if (!g.ok) return g.res;
  if (!(await allowRequest("launch-withdraw", g.owner, 10, 10 * 60_000))) return fail(429, "Too many withdrawals. Wait a few minutes.");
  const parsed = Body.safeParse(g.body);
  if (!parsed.success) return fail(400, "amount must be a positive number");
  const { amount, asset } = parsed.data;
  const c = launchCx();
  if (!c) return fail(503, "Launch is not configured on this server.");
  const a = await c.client.query(api.launch.forOwner, { secret: c.secret, slug: id });
  if (!a || a.owner !== g.owner) return fail(404, "No such agent.");
  if (!a.gno) return fail(409, "The agent has no gno.land account.");
  const to = normalizeOwner(g.owner);
  if (!to) return fail(409, "Withdrawals go to your gno.land account: connect one.");
  const lease = await c.client.mutation(api.launch.leaseForOwner, { secret: c.secret, slug: id, owner: g.owner });
  if (lease === null) return fail(409, "The agent is busy right now (opening a market or another withdrawal). Try again in a minute.");

  try {
    const gas = await walletGasUgnot(a.gno.address, G);
    const signer = await sealedSigner(launchWalletScope(a.uid), a.gno, G);
    let tx: string;
    if (asset === "gnot") {
      const ugnot = BigInt(Math.floor(amount * 1e6));
      const free = gas > MIN_GAS_UGNOT ? gas - MIN_GAS_UGNOT : 0n;
      if (ugnot > free) return fail(400, `Only ${Number(free) / 1e6} GNOT is free to withdraw (the transfer's own gas stays).`);
      tx = (await signer.sendUgnot(to, ugnot)).txHash;
    } else {
      if (gas < MIN_GAS_UGNOT) return fail(409, `The agent's account ${a.gno.address} needs a little GNOT for gas first.`);
      const wei = BigInt(Math.floor(amount * 1e6)) * 1_000_000_000_000n;
      const free = await walletMusdWei(a.gno.address, G);
      if (wei > free) return fail(400, `Only ${indexToDecimal6(free)} mUSD is free to withdraw.`);
      tx = (await gnoSendMusd(signer, to, wei, G)).txHash;
    }
    const unit = asset === "gnot" ? "GNOT" : "mUSD";
    await c.client.mutation(api.launch.logEvent, { secret: c.secret, slug: id, kind: "rules", text: `owner withdrew ${amount} ${unit} (${tx.slice(0, 10)}…)` });
    return Response.json({ tx, chain: "gno" });
  } catch (e) {
    // A send can land after its confirmation timed out: never tell the owner nothing was sent.
    console.error(`[launch] withdraw ${id} failed:`, e);
    return fail(502, "The withdrawal could not be confirmed. Check the agent's balance before you try again.");
  } finally {
    await c.client.mutation(api.launch.releaseForOwner, { secret: c.secret, slug: id, token: lease }).catch(() => undefined);
  }
}
