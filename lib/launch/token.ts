/**
 * An agent's own token, optional, launched and paid for by its owner on gno.land through the GRC20 factory
 * (lib/launch/token-factory.ts). Two steps, both signed by the owner:
 *   1. prepare: the server checks the agent and that its ticker is still free in the factory, and returns the one
 *      MsgCall for the owner's Adena account to send (the owner becomes the token's admin). Nothing is sent.
 *   2. record: after it committed, the server reads the transaction's events and the factory's page and keeps the
 *      token only if the factory emitted NewToken for the agent's ticker and the owner is its admin.
 * Mimir takes no share and holds nothing. Chain access is injected, so the checks run in tests.
 */
import { z } from "zod";

import { api } from "@/convex/_generated/api";
import type { GnoMsgCall } from "@/lib/gno/msgs";
import type { GnoTx } from "@/lib/gno/tx";
import { checkTokenLaunch, newTokenMessage, type TokenCheck } from "./token-factory";
import type { Cx } from "./request";

export type TokenChain = "gno";

export const TokenPrepareBody = z.object({ chain: z.literal("gno").default("gno") }).strip();
export type TokenPrepareInput = z.infer<typeof TokenPrepareBody>;

export const TokenRecordBody = z.object({ chain: z.literal("gno").default("gno"), tx: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/) });

export interface LaunchTx {
  chain: TokenChain;
  chainId: string;
  /** Send them as one transaction from the owner's account. */
  messages: GnoMsgCall[];
}

export interface TokenDeps {
  chainId: string;
  /** Whether the factory already has a token with this symbol. */
  symbolTaken(symbol: string): Promise<boolean>;
  tx(hash: string): Promise<GnoTx | null>;
  /** The admin the factory names for `symbol`, lowercase; null when unknown. */
  admin(symbol: string): Promise<string | null>;
}

type Fail = { ok: false; status: number; error: string };

async function ownedAgent({ client, secret }: Cx, owner: string, id: string) {
  const a = await client.query(api.launch.forOwner, { secret, slug: id });
  if (!a || a.owner.toLowerCase() !== owner.toLowerCase()) return { ok: false as const, status: 404, error: "No such agent." };
  return { ok: true as const, a };
}

export async function prepareTokenLaunch(cx: Cx, deps: TokenDeps, owner: string, id: string): Promise<({ ok: true } & LaunchTx) | Fail> {
  const got = await ownedAgent(cx, owner, id);
  if (!got.ok) return got;
  const a = got.a;
  if (a.token) return { ok: false, status: 409, error: `$${a.ticker} already has a token.` };
  if (a.status === "killed") return { ok: false, status: 409, error: "This agent is shut down." };
  let taken: boolean;
  try {
    taken = await deps.symbolTaken(a.ticker);
  } catch {
    return { ok: false, status: 503, error: "The GRC20 factory could not be read. Try again shortly." };
  }
  if (taken) return { ok: false, status: 409, error: `$${a.ticker} is already a token in the gno.land GRC20 factory.` };
  return { ok: true, chain: "gno", chainId: deps.chainId, messages: [newTokenMessage(owner.toLowerCase(), a.name, a.ticker)] };
}

/** The launch tx, checked from the chain (lib/launch/token-factory.ts checkTokenLaunch). */
export async function verifyTokenLaunch(deps: Pick<TokenDeps, "tx" | "admin">, a: { tx: string; owner: string; ticker: string }): Promise<TokenCheck> {
  const tx = await deps.tx(a.tx).catch(() => null);
  const admin = tx?.ok ? await deps.admin(a.ticker).catch(() => null) : null;
  return checkTokenLaunch(tx, admin, a);
}

/** Step 2: verify the owner's launch tx, then keep the token on the agent. Idempotent for the same token. */
export async function recordTokenLaunch(cx: Cx, deps: Pick<TokenDeps, "tx" | "admin">, owner: string, id: string, body: z.infer<typeof TokenRecordBody>) {
  const got = await ownedAgent(cx, owner, id);
  if (!got.ok) return got;
  const a = got.a;
  const v = await verifyTokenLaunch(deps, { tx: body.tx, owner, ticker: a.ticker });
  if (!v.ok) return v;
  const launchTx = body.tx.replace(/^0x/, "").toLowerCase();
  const token = { ...v.token, launchTx };
  if (a.token) {
    return a.token.address === token.address ? { ok: true as const, token: a.token } : { ok: false as const, status: 409, error: `$${a.ticker} already has a token.` };
  }
  const r = await cx.client.mutation(api.launch.recordToken, { secret: cx.secret, slug: id, owner: a.owner, token });
  if (r !== "ok") return { ok: false as const, status: 409, error: r === "taken" ? "That token already belongs to another agent." : `$${a.ticker} already has a token.` };
  return { ok: true as const, token };
}
