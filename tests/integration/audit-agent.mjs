/**
 * Live gno.land check of the audit agent against the configured realms (NEXT_PUBLIC_GNO_* or the defaults).
 * Skipped unless AUDIT_AGENT_MNEMONIC and AUDIT_INTEGRATION=1 are set. Evidence and model replies are fixtures.
 *
 *   AUDIT_INTEGRATION=1 node --env-file=.env.audit --import tsx tests/integration/audit-agent.mjs
 *
 * Read-only by default: discovery, the role preflight, an observe-mode review (must sign nothing) and the exact
 * dispute messages the agent would sign. It only broadcasts with --challenge and AUDIT_INTEGRATION_MARKET=<vs|pool>:<id>
 * naming a proposal the audit agent may dispute (a test market whose proposal is deliberately wrong).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GNO } from "../../lib/gno/config.ts";
import { addressFromMnemonic } from "../../lib/gno/keys.ts";
import { gnoSigner } from "../../lib/gno/signer.ts";
import { auditAgentKey } from "../../lib/chains/house.ts";
import { assertAuditRoles, processAuditProposal, reviewProposal } from "../../agents/audit/review.ts";
import { auditDisputeMessages, auditIO, gnoAuditChain, gnoAuditReads, loadAuditProposal, readAuditRoles } from "../../agents/audit/chain.ts";
import { discoverAuditJobs, isMissingRealm } from "../../agents/audit/discover.ts";
import { readAuditState, saveAuditState } from "../../agents/audit/state.ts";

const mnemonic = auditAgentKey(process.env);
if (!mnemonic || process.env.AUDIT_INTEGRATION !== "1") {
  console.log("SKIP audit-agent integration: set AUDIT_AGENT_MNEMONIC and AUDIT_INTEGRATION=1");
  process.exit(0);
}

const cfg = GNO;
const account = addressFromMnemonic(mnemonic);
const reads = gnoAuditReads(cfg);
const fixtureReview = p => reviewProposal(p, {
  fetch: async () => ({ text: "Fixture evidence: the proposed side is wrong.", fetcher: "fixture", url: p.resolutionUrl }),
  llm: async () => ({ text: JSON.stringify({ verdict: p.side === 1 ? "CHALLENGERS_WIN" : "CREATOR_WINS", confidence: 96, explanation: "Fixture disagreement.", knownAt: "" }), provider: "fixture", model: "independent" }),
});

const root = await mkdtemp(join(tmpdir(), "mimir-audit-gno-"));
try {
  for (const kind of ["vs", "pool"]) {
    try { assertAuditRoles(account, await readAuditRoles(reads, kind));console.log(`PASS ${kind}: ${account} is the registered audit agent, separate from privileged roles`); }
    catch (err) { if (isMissingRealm(err)) console.warn(`WARN ${kind} realm not deployed: ${err.message}`);else throw err; }
  }
  const statePath = join(root, "state.json");
  const state = await readAuditState(statePath, "integration");
  await discoverAuditJobs(cfg, state, reads);await saveAuditState(statePath, state);
  console.log(`PASS discovery: ${Object.keys(state.jobs).length} proposal(s) inside their dispute window`);

  const chain = gnoAuditChain(cfg);
  for (const job of Object.values(state.jobs).slice(0, 3)) {
    const io = auditIO(cfg, reads, { ...chain, send: async () => { throw Error("observe mode signed a transaction"); } }, account, "observe", job, async () => saveAuditState(statePath, state));
    io.review = fixtureReview;
    await processAuditProposal(job, io);
    assert.ok(["observed", "agreed", "pending", "closed", "expired", "stale"].includes(job.status));
    assert.equal(job.txHash, undefined);
    const msgs = auditDisputeMessages(cfg, account, job.proposal.kind, job.proposal.marketId, await chain.allowanceWei(account, job.proposal.kind));
    console.log(`PASS observe ${job.proposal.kind} #${job.proposal.marketId}: ${job.status}; would sign ${msgs.map(m => `${m.value.pkg_path}.${m.value.func}(${m.value.args.join(",")})`).join(" + ")}`);
  }

  if (process.argv.includes("--challenge")) {
    const [kind, marketId] = (process.env.AUDIT_INTEGRATION_MARKET ?? "").split(":");
    assert.ok((kind === "vs" || kind === "pool") && /^[1-9]\d*$/.test(marketId ?? ""), "AUDIT_INTEGRATION_MARKET=<vs|pool>:<id> required with --challenge");
    const signer = await gnoSigner(mnemonic, cfg);
    assert.equal(signer.address.toLowerCase(), account);
    const proposal = await loadAuditProposal(cfg, reads, kind, marketId);
    assert.ok(proposal.live && proposal.disputableUntil > proposal.now, "the named market is not a live proposal");
    const job = { proposal, status: "pending" };
    const io = auditIO(cfg, reads, gnoAuditChain(cfg, signer), account, "challenge", job, async () => {});
    io.review = fixtureReview;
    await processAuditProposal(job, io);
    assert.equal(job.status, "submitted");
    await processAuditProposal(job, io);
    assert.equal(job.status, "challenged");
    const after = await loadAuditProposal(cfg, reads, kind, marketId);
    assert.equal(after.live, false, "the proposal is still open after the dispute");
    console.log(`PASS challenge ${kind} #${marketId}: dispute committed in ${job.txHash}`);
  }
} finally { await rm(root, { recursive: true, force: true }); }
