/**
 * An agent's optional token, launched from its owner's own Adena account through gno.land's GRC20 factory
 * (lib/launch/token.ts). Both steps signed by the owner.
 * POST /api/launch/:id/token { step: "prepare" }
 *      the message to send from the owner's account: { chain: "gno", chainId, messages }.
 * POST /api/launch/:id/token { step: "record", tx }
 *      after it committed: checks the transaction's NewToken event (the agent's ticker) and that the owner is the
 *      token's admin, and keeps the token on the agent.
 */
import { MARKET_CHAINS } from "@/lib/chains/registry";
import { goString, qeval, qrender } from "@/lib/gno/rpc";
import { gnoTx } from "@/lib/gno/tx";
import { fail, launchCx, readSigned } from "@/lib/launch/request";
import { prepareTokenLaunch, recordTokenLaunch, TokenPrepareBody, TokenRecordBody, type TokenDeps } from "@/lib/launch/token";
import { adminFromRender, GRC20_FACTORY } from "@/lib/launch/token-factory";
import { allowRequest } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const G = MARKET_CHAINS.chains.gno.gno;

const deps: TokenDeps = {
  chainId: G.chainId,
  // The factory panics on an unknown symbol: a panic means the ticker is free.
  symbolTaken: (symbol) =>
    qeval(GRC20_FACTORY, `TotalSupply(${goString(symbol)})`, G).then(
      () => true,
      (err: Error) => {
        if (/does not exist/.test(err.message)) return false;
        throw err;
      },
    ),
  tx: (hash) => gnoTx(hash, G),
  admin: async (symbol) => adminFromRender(await qrender(GRC20_FACTORY, symbol, G)),
};

/** A just-committed tx can take a moment to be served: a few short retries. */
async function txSoon(hash: string) {
  for (let i = 0; i < 5; i++) {
    const tx = await gnoTx(hash, G).catch(() => null);
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{2,10}(-\d{1,3})?$/.test(id)) return fail(404, "No such agent.");
  const g = await readSigned(req, "token", id, 16 * 1024);
  if (!g.ok) return g.res;
  if (!(await allowRequest("launch-token", g.owner, 10, 10 * 60_000))) return fail(429, "Too many attempts. Wait a few minutes.");
  const c = launchCx();
  if (!c) return fail(503, "Launch is not configured on this server.");
  const step = (g.body as { step?: unknown } | null)?.step;

  if (step === "prepare") {
    if (!TokenPrepareBody.safeParse(g.body).success) return fail(400, "Invalid token.");
    const r = await prepareTokenLaunch(c, deps, g.owner, id);
    if (!r.ok) return fail(r.status, r.error);
    const { ok: _ok, ...tx } = r;
    return Response.json(tx, { headers: { "cache-control": "no-store" } });
  }

  if (step === "record") {
    const parsed = TokenRecordBody.safeParse(g.body);
    if (!parsed.success) return fail(400, "Send the launch transaction hash.");
    const r = await recordTokenLaunch(c, { ...deps, tx: txSoon }, g.owner, id, parsed.data);
    if (!r.ok) return fail(r.status, r.error);
    return Response.json({ token: r.token });
  }

  return fail(400, 'step must be "prepare" or "record"');
}
