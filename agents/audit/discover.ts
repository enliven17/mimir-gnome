import type { GnoConfig } from "../../lib/gno/config";
import { readPaged } from "../../lib/chains/snapshot";
import { POOL_PROPOSED, VS_PROPOSED, auditRealm, gnoAuditReads, poolAuditProposal, vsAuditProposal, type AuditReads } from "./chain";
import { proposalKey, type AuditProposal } from "./review";
import type { AuditState } from "./state";

/** A realm that is not deployed (yet): skipped with a warning instead of blocking the other one. */
export const isMissingRealm = (err: unknown) => /package not found|invalid package path|unknown package/i.test((err as Error)?.message ?? "");

/**
 * Scan both realms' paged JSON views (newest first, at most `max` rows each) for proposals still inside their dispute
 * window. gno.land has instant finality, so there is no log cursor or reorg overlap: each pass reads the current state
 * and `seen` dedupes a (market, proposal time) pair until its window closes.
 */
export async function discoverAuditJobs(cfg: GnoConfig, state: AuditState, reads: AuditReads = gnoAuditReads(cfg), opts: { max?: number; warn?: (msg: string) => void } = {}): Promise<void> {
  const warn = opts.warn ?? (msg => console.warn(msg));
  for (const kind of ["vs", "pool"] as const) {
    const realm = auditRealm(cfg, kind);
    let proposals: AuditProposal[], now: number;
    try {
      const conf = kind === "vs" ? await reads.vsConfig() : await reads.poolConfig();
      now = conf.now;
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(conf.disputeWindow)) throw Error("Invalid audit realm config");
      proposals = kind === "vs"
        ? (await readPaged((o, l) => reads.vsClaims(o, l), opts.max)).filter(c => c.state === VS_PROPOSED).map(c => vsAuditProposal(cfg, c, conf))
        : (await readPaged((o, l) => reads.poolMarkets(o, l), opts.max)).filter(m => m.state === POOL_PROPOSED).map(m => poolAuditProposal(cfg, m, conf));
    } catch (err) {
      if (!isMissingRealm(err)) throw err;
      warn(`[audit] ${realm} not readable, skipped: ${(err as Error).message}`);
      continue;
    }
    const domain = `${cfg.chainId}:${realm}:${kind}`;
    for (const [key, until] of Object.entries(state.seen)) if (key.startsWith(`${domain}:`) && until < now) delete state.seen[key];
    // Reports are archived separately by the runner; don't retain completed transaction jobs forever.
    for (const [key, job] of Object.entries(state.jobs)) {
      if (job.proposal.kind === kind && job.proposal.disputableUntil < now && (!job.txHash || job.status === "challenged")) delete state.jobs[key];
    }
    for (const p of proposals) {
      if (!Number.isSafeInteger(p.disputableUntil) || p.proposedAt <= 0) throw Error("Invalid audit proposal deadline");
      const event = `${domain}:${p.marketId}:${p.proposedAt}`;
      if (state.seen[event] || p.disputableUntil <= now) continue;
      if (Object.keys(state.jobs).length >= 1000 || Object.keys(state.seen).length >= 10_000) throw Error("Audit queue capacity reached; operator attention required");
      const key = proposalKey(p);
      if (p.live && !state.jobs[key]) state.jobs[key] = { proposal: p, status: "pending" };
      state.seen[event] = p.disputableUntil;
    }
  }
}
