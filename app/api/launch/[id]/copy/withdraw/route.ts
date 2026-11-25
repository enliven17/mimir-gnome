/**
 * POST /api/launch/:id/copy/withdraw { amount }: part (or all) of a copy wallet's mUSD back to the follower's own
 * gno.land account, signed by the follower. Copied stakes stay put and settle on their own. Returns the gno tx hash.
 */
import { z } from "zod";

import { api } from "@/convex/_generated/api";
import { indexToDecimal6 } from "@/lib/chains/amounts";
import { MARKET_CHAINS } from "@/lib/chains/registry";
import { copyKeyFor } from "@/lib/launch/copy-key";
import { fail, launchCx, readSigned } from "@/lib/launch/request";
import { normalizeOwner } from "@/lib/owner";
import { copyWalletScope, gnoSendMusd, MIN_GAS_UGNOT, sealedSigner, walletGasUgnot, walletMusdWei } from "@/lib/server/gno-wallets";
import { allowRequest } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const G = MARKET_CHAINS.chains.gno.gno;
const Body = z.object({ amount: z.number().positive().max(1_000_000), chain: z.literal("gno").default("gno") });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await readSigned(req, "copy-withdraw", id);
  if (!g.ok) return g.res;
  if (!(await allowRequest("launch-copy-withdraw", g.owner, 10, 10 * 60_000))) return fail(429, "Too many withdrawals. Wait a few minutes.");
  const parsed = Body.safeParse(g.body);
  if (!parsed.success) return fail(400, "amount must be a positive number of mUSD");
  const c = launchCx();
  if (!c) return fail(503, "Launch is not configured on this server.");
  const key = copyKeyFor(id);
  const s = await c.client.query(api.launchCopy.forFollower, { secret: c.secret, agent: key, follower: g.owner });
  if (!s?.gno) return fail(404, "You have no copy wallet for this agent.");
  const to = normalizeOwner(g.owner);
  if (!to) return fail(409, "Withdrawals go to your gno.land account: connect one.");
  const wei = BigInt(Math.floor(parsed.data.amount * 1e6)) * 1_000_000_000_000n;
  try {
    const [free, gas] = await Promise.all([walletMusdWei(s.gno.address, G), walletGasUgnot(s.gno.address, G)]);
    if (wei > free) return fail(400, `Only ${indexToDecimal6(free)} mUSD is free to withdraw.`);
    if (gas < MIN_GAS_UGNOT) return fail(409, `The copy wallet ${s.gno.address} needs a little GNOT for gas first.`);
    const signer = await sealedSigner(copyWalletScope(key, g.owner), s.gno, G);
    const { txHash } = await gnoSendMusd(signer, to, wei, G);
    return Response.json({ tx: txHash, chain: "gno" });
  } catch (e) {
    // A send can land after its confirmation timed out: never tell the follower nothing was sent.
    console.error(`[launch] copy withdraw ${id} failed:`, e);
    return fail(502, "The withdrawal could not be confirmed. Check the copy wallet's balance before you try again.");
  }
}
