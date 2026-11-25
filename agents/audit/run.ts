/** Run separately with audit credentials only. Never imports the proposer worker or its verdict cache. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { writeFile, mkdir, rename } from "node:fs/promises";
import { GNO, isGnoAddress } from "../../lib/gno/config";
import { addressFromMnemonic } from "../../lib/gno/keys";
import { gnoSigner } from "../../lib/gno/signer";
import { auditAgentKey } from "../../lib/chains/house";
import { providerChain } from "../../lib/llm";
import { auditConfigOf, auditIO, auditRealm, gnoAuditChain, gnoAuditReads, readAuditRoles } from "./chain";
import { assertAuditRoles, processAuditProposal, proposalKey, auditQueue, isAuditReceiptJob, type AuditJob } from "./review";
import { discoverAuditJobs, isMissingRealm } from "./discover";
import { lockAuditState, readAuditState, saveAuditState } from "./state";
import { auditOpenAIConfig } from "./openai-compat";

const KINDS = ["vs", "pool"] as const;

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Audit worker: node --env-file=.env.audit --import tsx agents/audit/run.ts [--once|--print-setup]. AUDIT_MODE=observe (default) or challenge; AUDIT_AGENT_MNEMONIC signs disputes (challenge mode), AUDIT_AGENT_ADDRESS (g1…) for observe/setup; AUDIT_STATE_FILE required.");return;
  }
  const cfg = GNO;
  if (process.env.AUDIT_AGENT_MNEMONIC?.trim() && !auditAgentKey(process.env)) throw Error("AUDIT_AGENT_MNEMONIC must be a 12 to 24 word mnemonic");
  const mnemonic = auditAgentKey(process.env) ?? undefined;
  const account = mnemonic ? addressFromMnemonic(mnemonic) : undefined;
  const configured = process.env.AUDIT_AGENT_ADDRESS?.trim();
  if (configured && !isGnoAddress(configured)) throw Error("AUDIT_AGENT_ADDRESS must be a g1 address");
  const address = configured?.toLowerCase() ?? account;
  if (configured && account && configured.toLowerCase() !== account) throw Error("Audit mnemonic/address mismatch");
  if (process.argv.includes("--print-setup")) {
    if (!address) throw Error("Configure the public AUDIT_AGENT_ADDRESS");
    // The realms' owner signs these (e.g. gnokey maketx call); caller is left for the owner's key to fill.
    console.log(JSON.stringify({ broadcast: false, chainId: cfg.chainId, auditAgent: address, messages: KINDS.map(kind => ({ type: "/vm.m_call", value: { caller: "", send: "", max_deposit: "", pkg_path: auditRealm(cfg, kind), func: "SetAuditAgent", args: [address] } })) }, null, 2));return;
  }
  const mode = process.env.AUDIT_MODE?.trim() || "observe";
  if (mode !== "observe" && mode !== "challenge") throw Error("AUDIT_MODE must be observe or challenge");
  if (mode === "challenge" && !mnemonic) throw Error("AUDIT_AGENT_MNEMONIC required for challenge mode");
  if (!auditOpenAIConfig() && providerChain({ role: "audit", settlement: true, noFreeRouter: true }).length === 0) throw Error("No dedicated audit model credentials/allowed model; proposer/shared keys are never used");
  const statePath = process.env.AUDIT_STATE_FILE?.trim();
  if (!statePath) throw Error("Set a private AUDIT_STATE_FILE path");
  const path = resolve(statePath);
  const identity = createHash("sha256").update(JSON.stringify({ address: address ?? "observe", chainId: cfg.chainId, realms: [cfg.realms.vs, cfg.realms.pool] })).digest("hex");
  const release = await lockAuditState(path);
  try {
    const state = await readAuditState(path, identity);
    const reads = gnoAuditReads(cfg);
    const signer = mnemonic ? await gnoSigner(mnemonic, cfg) : undefined;
    if (signer && signer.address.toLowerCase() !== account) throw Error("Audit signer must retain its matching mnemonic account");
    const chain = gnoAuditChain(cfg, signer);
    if (mode === "challenge") for (const kind of KINDS) {
      try {
        assertAuditRoles(account, await readAuditRoles(reads, kind));
        if ((await auditConfigOf(reads, kind)).disputeWindow === 0) throw Error("A zero-window deployment cannot be protected by a post-proposal auditor");
      } catch (err) {
        if (!isMissingRealm(err)) throw err;
        console.warn(`[audit] ${auditRealm(cfg, kind)} not deployed, skipped preflight: ${(err as Error).message}`);
      }
    }
    const save = async (job?: AuditJob) => {
      if (job?.review) {
        const dir = `${path}.reports`;await mkdir(dir, { recursive: true, mode: 0o700 });
        const name = createHash("sha256").update(proposalKey(job.proposal)).digest("hex");
        const target = `${dir}/${name}.json`, temp = `${target}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(job, null, 2), { mode: 0o600 });await rename(temp, target);
      }
      await saveAuditState(path, state);
    };
    let stop = false;
    const stopping = () => { stop = true; };
    process.once("SIGINT", stopping);process.once("SIGTERM", stopping);
    try {
      do {
        try { await discoverAuditJobs(cfg, state, reads);await save(); }
        catch (err) { console.error(`[audit] ${cfg.chainId} discovery blocked: ${(err as Error).message}`);await save(); }
        const now = Math.floor(Date.now() / 1000);
        const pending = auditQueue(Object.values(state.jobs), mode, now);
        // Receipt polls cannot consume all review slots when an old transaction is stuck.
        const isReceipt = isAuditReceiptJob;
        const batch = [...pending.filter(isReceipt).slice(0, 1), ...pending.filter(j => !isReceipt(j)).slice(0, 2)];
        for (const job of batch) {
          try {
            const unsettledTransaction = Object.values(state.jobs).some(j => j !== job && j.status === "submitted");
            // Continue reviewing while one signer transaction is unresolved, but don't create competing sequence intents.
            const effectiveMode = mode === "challenge" && unsettledTransaction && !job.txHash ? "observe" : mode;
            await processAuditProposal(job, auditIO(cfg, reads, chain, account, effectiveMode, job, async j => save(j)));
            delete job.error;
          } catch (err) { job.error = (err as Error).message.slice(0, 300); }
          job.nextTry = now + (isReceipt(job) ? 15 : job.review ? 60 : 120);
          await save(job);
          console.log(JSON.stringify({ worker: "audit", chainId: job.proposal.chainId, realm: job.proposal.contract, marketId: job.proposal.marketId, status: job.status, txHash: job.txHash, error: job.error }));
        }
        console.log(JSON.stringify({ worker: "audit", heartbeat: new Date().toISOString(), mode, queued: pending.length, processingLimit: 3 }));
        if (stop || process.argv.includes("--once")) break;
        await new Promise(r => setTimeout(r, 15_000));
      } while (!stop);
    } finally { process.removeListener("SIGINT", stopping);process.removeListener("SIGTERM", stopping); }
  } finally { await release(); }
}

main().catch(err => { console.error(`[audit] startup/run failed: ${(err as Error).message}`);process.exitCode = 1; });
