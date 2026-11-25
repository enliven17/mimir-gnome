/**
 * POST /api/copy/signals: what this execution agent may copy, and the
 * unsigned transaction to do it.
 *
 * Authenticated as the execution agent with the same signed envelope every
 * agent call uses (`action: "heartbeat"`: asking is a read, and every copy it
 * then places is gated by the follower's permission and the agent's own
 * limits). Three modes, chosen by the envelope body:
 *
 *   {}                                   gated instructions: copy[] and skipped[]
 *   { prepare: { permissionId, claimId } }  re-gates that one copy and returns
 *                                          the unsigned gno.land challenge messages
 *   { report: { permissionId, claimId, executed, signature?, skipReason? } }
 *                                          records the outcome in the ledger
 *
 * Nothing is staked here and no key is held: the agent signs and submits with
 * its gno operator key (all messages as ONE transaction). An executed report
 * is checked against the market index and recorded at the operator's actual
 * stake, so the ledger the caps are derived from cannot be talked down.
 */
import { actionMessages } from "@/lib/chains/calls";
import { musdAllowanceWei } from "@/lib/chains/client";
import { MARKET_CHAINS } from "@/lib/chains/registry";
import { normalizeTxHash } from "@/lib/gno/tx";
import { normalizeOwner } from "@/lib/owner";
import { arcPositions } from "@/lib/server/arc-index";
import { getAgent } from "@/lib/agents/store";

import {
  AgentEnvelopeError,
  validateAgentRequestEnvelope,
  type AgentEnvelope,
} from "@/lib/agents/api";
import { authenticateAgentRequest } from "@/lib/agents/authenticate";
import { unitsToUsdc, usdcLimitUnits } from "@/lib/agents/params";
import { authorizeAction, type AgentRecord } from "@/lib/agents/registry";
import {
  consumeNonce,
  recordRequest,
  requestsLastHour,
  reserveDailyStake,
  stakedLastDayUnits,
} from "@/lib/agents/store";
import { copyStakeUnits, isCopySkipReason, type CopyPermission } from "@/lib/copy-trading";
import type { CopyInstruction } from "@/lib/copy-signals";
import { permissionsForExecutor, recordExecution, releaseCopy, reserveCopy } from "@/lib/copy-trading-store";
import { buildCopyInstructions } from "@/lib/server/copy-signals";
import { isFeatureEnabled } from "@/lib/ops/flags";
import { storeEnabled } from "@/lib/server/store";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/server/rate-limit";
import { basketFail as fail, basketJson as json } from "@/lib/server/basket-http";
import { MAX_BODY_BYTES, readLimitedJson } from "@/lib/server/body-limit";

export const dynamic = "force-dynamic";

function target(raw: unknown): { permissionId: string; claimId: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const permissionId = typeof r.permissionId === "string" ? r.permissionId.trim() : "";
  const claimId = Number(r.claimId);
  if (!permissionId || !Number.isSafeInteger(claimId) || claimId <= 0) return null;
  return { permissionId, claimId };
}

function view(i: CopyInstruction) {
  return {
    permissionId: i.permissionId,
    claimId: i.claimId,
    signalAgentId: i.signalAgentId,
    question: i.question,
    category: i.category,
    layer: i.layer,
    deadline: i.deadline,
    claimQuality: i.claimQuality,
    payoutRatio: i.payoutRatio,
  };
}

export async function POST(req: Request): Promise<Response> {
  if (!isFeatureEnabled("copy_trading")) {
    return fail(404, "feature_disabled", "copy trading is not enabled on this deployment");
  }
  if (!(await allowRequest("copy-signals-ip", clientIp(req), 60, 60_000))) return tooManyRequests(60);
  if (!storeEnabled()) return fail(503, "registry_unavailable", "copy trading needs the backend on this deploy");

  const read = await readLimitedJson(req);
  if (!read.ok) {
    return read.status === 413
      ? fail(413, "payload_too_large", `body is over ${MAX_BODY_BYTES} bytes`)
      : fail(400, "malformed_json", "body is not valid JSON");
  }
  const raw = read.value;

  let env: AgentEnvelope;
  let agent: AgentRecord;
  try {
    env = validateAgentRequestEnvelope(raw, { action: "heartbeat" });
    const auth = await authenticateAgentRequest(env, req.headers.get("authorization"));
    if (auth.nonce && !(await consumeNonce(auth.agent.agentId, auth.nonce))) {
      throw new AgentEnvelopeError("nonce already used", 409, "nonce_replay");
    }
    agent = auth.agent;
  } catch (err) {
    if (err instanceof AgentEnvelopeError) return fail(err.status, err.reason, err.message);
    console.error("[copy/signals] auth failed:", err);
    return fail(503, "registry_unavailable", "the agent registry could not be read");
  }
  if (!(await allowRequest("copy-signals-agent", agent.agentId, 30, 60_000))) return tooManyRequests(60);

  const permissions = await permissionsForExecutor(agent.agentId).catch(() => [] as CopyPermission[]);

  try {
    if (env.body.report !== undefined) return await handleReport(agent, permissions, env.body.report);
    if (env.body.prepare !== undefined) return await handlePrepare(agent, permissions, env.body.prepare);
  } catch (err) {
    if (err instanceof AgentEnvelopeError) return fail(err.status, err.reason, err.message);
    console.error("[copy/signals] failed:", err);
    return fail(503, "chain_unavailable", "the chain could not be read, try again shortly");
  }

  const instructions = await buildCopyInstructions(permissions, executorAddress(agent)).catch(() => []);
  await recordRequest(agent.agentId, "copySignals", true, null).catch(() => undefined);
  return json({
    ok: true,
    executionAgentId: agent.agentId,
    signer: agent.gnoOperator,
    permissions: permissions.length,
    copy: instructions
      .filter((i) => i.decision.allowed)
      .map((i) => ({
        ...view(i),
        stakeUsdc: i.decision.stakeUsdc,
        stakeUnits: copyStakeUnits(i.decision.stakeUsdc).toString(),
      })),
    skipped: instructions
      .filter((i) => !i.decision.allowed)
      .map((i) => ({ ...view(i), reason: i.decision.reason, message: i.decision.message })),
    // Said plainly, because an endpoint returning stake sizes could be read as
    // having already placed them.
    note:
      "Nothing has been staked. For each copy, call again with { prepare: { permissionId, claimId } }, sign the returned messages as one transaction with the operator key, then report { report: { permissionId, claimId, executed: true, signature: <tx hash> } }.",
  });
}

async function handlePrepare(agent: AgentRecord, permissions: CopyPermission[], raw: unknown): Promise<Response> {
  const t = target(raw);
  if (!t) return fail(400, "bad_prepare", "prepare needs permissionId and a positive integer claimId");
  const permission = permissions.find((p) => p.id === t.permissionId);
  if (!permission) {
    return fail(403, "not_your_permission", "no active permission names this agent as its executor under that id");
  }

  // Re-gated at prepare time: the list a moment ago is advice, this is the decision.
  if (!onChain()) return fail(503, "chain_unavailable", "markets are not configured on this deployment");
  const operator = agent.gnoOperator;
  if (!operator) return fail(409, "no_gno_operator", "set a gno operator first (setGnoOperator): copies are sent from it");
  const instructions = await buildCopyInstructions([permission], executorAddress(agent));
  const instruction = instructions.find((i) => i.claimId === t.claimId);
  if (!instruction) {
    return fail(409, "no_signal", "the signal agent holds no open position you can copy on that claim");
  }
  if (!instruction.decision.allowed) {
    return json(
      { ok: false, reason: instruction.decision.reason, message: instruction.decision.message },
      { status: 409 },
    );
  }

  // The agent's own limits still apply on top of the follower's policy.
  const stakeUnits = copyStakeUnits(instruction.decision.stakeUsdc);
  const [used, spentUnits] = await Promise.all([
    requestsLastHour(agent.agentId).catch(() => 0),
    stakedLastDayUnits(agent.agentId).catch(() => 0n),
  ]);
  const decision = authorizeAction({
    agent,
    action: "challenge",
    requestsLastHour: used,
    spentTodayUsdc: unitsToUsdc(spentUnits),
    positionUsdc: unitsToUsdc(stakeUnits),
  });
  if (!decision.allowed) {
    await recordRequest(agent.agentId, "challenge", false, decision.reason ?? null).catch(() => undefined);
    return fail(decision.reason === "rate_limit" ? 429 : 403, decision.reason ?? "denied", decision.message ?? "");
  }

  // The follower's reservation first: it counts toward their caps until this
  // copy is reported or expires, and a live one blocks a duplicate prepare.
  const reserved = await reserveCopy(permission.id, t.claimId, instruction.decision.stakeUsdc, permission);
  if (reserved === "duplicate") {
    return fail(409, "already_prepared", "this copy was already prepared: report it before preparing again");
  }
  if (reserved === "over_cap") {
    return fail(409, "follower_cap", "the follower's daily or weekly copy limit is reached");
  }
  // Then the agent's own daily cap, checked and recorded in one locked step.
  const reservation = await reserveDailyStake(
    agent.agentId,
    "challenge",
    stakeUnits,
    usdcLimitUnits(agent.limits.maxDailyUsdc),
  ).catch(async (err) => {
    await releaseCopy(permission.id, t.claimId).catch(() => undefined);
    throw err;
  });
  if (reservation === null) {
    await releaseCopy(permission.id, t.claimId).catch(() => undefined);
    await recordRequest(agent.agentId, "challenge", false, "daily_cap").catch(() => undefined);
    return fail(403, "daily_cap", `over ${agent.limits.maxDailyUsdc} mUSD at risk today`);
  }

  const cfg = MARKET_CHAINS.chains.gno;
  const referrer = await copyReferrer(permission.signalAgentId).catch(() => "");
  const stake = stakeUnits * 1_000_000_000_000n;
  const allowance = await musdAllowanceWei(operator, "vs", cfg.gno).catch(() => 0n);
  const messages = actionMessages(operator, { type: "stake", kind: "vs", marketId: t.claimId, stake, side: 2, referrer }, allowance, cfg.gno);
  return json({
    ok: true,
    chain: "gno",
    chainId: cfg.chainId,
    permissionId: permission.id,
    claimId: t.claimId,
    stakeUsdc: instruction.decision.stakeUsdc,
    stakeUnits: stakeUnits.toString(),
    signer: operator,
    referrer,
    messages,
    fee: { gasWanted: String(cfg.gno.gas.wanted), gasFee: `${cfg.gno.gas.fee}ugnot` },
    description: `copy: challenge VS #${t.claimId}`,
    submit: `Sign every message as ONE transaction with the operator key (chain id ${cfg.chainId}), broadcast it to ${cfg.rpcUrl}, then report the tx hash.`,
  });
}

async function handleReport(agent: AgentRecord, permissions: CopyPermission[], raw: unknown): Promise<Response> {
  const t = target(raw);
  if (!t) return fail(400, "bad_report", "report needs permissionId and a positive integer claimId");
  const r = raw as Record<string, unknown>;
  if (!permissions.some((p) => p.id === t.permissionId)) {
    return fail(403, "not_your_permission", "no active permission names this agent as its executor under that id");
  }

  if (r.executed !== true) {
    await releaseCopy(t.permissionId, t.claimId).catch(() => undefined);
    await recordExecution({
      permissionId: t.permissionId,
      claimId: t.claimId,
      executed: false,
      skipReason: isCopySkipReason(r.skipReason) ? r.skipReason : null,
    }).catch(() => undefined);
    return json({ ok: true, recorded: { ...t, executed: false } });
  }

  const signature = typeof r.signature === "string" ? r.signature.trim() : "";
  if (!onChain()) return fail(503, "chain_unavailable", "markets are not configured on this deployment");
  const txHash = signature ? normalizeTxHash(signature) : null;
  if (signature && !txHash) return fail(400, "bad_report", "signature must be the gno.land tx hash");
  // The index is the source of truth for whether the copy landed and for how much.
  const legs = agent.gnoOperator ? await arcPositions(agent.gnoOperator).catch(() => []) : [];
  const leg = legs.find((p) => p.kind === "vs" && p.marketId === t.claimId && p.side === 2);
  if (!leg) return fail(409, "not_on_chain", "the gno operator holds no challenge on that market yet (the index updates within seconds)");
  const stakeUsdc = unitsToUsdc(BigInt(leg.amount) / 1_000_000_000_000n);
  const recorded = await recordExecution({ permissionId: t.permissionId, claimId: t.claimId, executed: true, stakeUsdc, txSignature: txHash });
  await releaseCopy(t.permissionId, t.claimId).catch(() => undefined);
  return json({ ok: true, recorded: { ...t, executed: true, stakeUsdc }, duplicate: !recorded });
}

/** Copies run once the gno.land realms and the index are configured. */
function onChain(): boolean {
  return Boolean(MARKET_CHAINS.chains.gno.enabled && process.env.NEXT_PUBLIC_CONVEX_URL);
}

/** Where the executing agent stakes from: its gno operator. */
function executorAddress(agent: AgentRecord): string {
  return (agent.gnoOperator ?? "").toLowerCase();
}

/**
 * Who earns the 1% referrer share of a winning copy: the copied agent's owner (else the agent's gno operator). House
 * personas have no owner to pay, so their copies carry no referrer and no copy fee ("" is no referrer).
 */
async function copyReferrer(signalAgentId: string): Promise<string> {
  const signal = await getAgent(signalAgentId).catch(() => null);
  if (!signal) return "";
  return normalizeOwner(signal.ownerWallet) ?? signal.gnoOperator ?? "";
}
