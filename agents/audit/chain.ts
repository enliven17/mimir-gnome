/**
 * The audit agent's gno.land adapter: proposals and roles come from the realms' JSON views (lib/gno/reads.ts), and the
 * only thing it can sign is the fixed dispute (pool `Dispute(id)`, VS `DisputeResolution(id)`), with an mUSD Approve of
 * the bond riding in the same transaction when the allowance is short (lib/gno/msgs.ts actionMessages).
 */
import type { GnoConfig } from "../../lib/gno/config";
import { actionMessages, DISPUTE_BOND_WEI, toMusdUnits, type GnoMsgCall, type MarketKind } from "../../lib/gno/msgs";
import * as gnoReads from "../../lib/gno/reads";
import type { MarketConfig, PoolMarket, VsClaim } from "../../lib/gno/reads";
import type { GnoSigner } from "../../lib/gno/signer";
import { gnoTx } from "../../lib/gno/tx";
import { gasBalanceUgnot, musdAllowanceWei, musdBalanceWei } from "../../lib/chains/client";
import { reviewProposal, type AuditIO, type AuditJob, type AuditProposal, type AuditRoles } from "./review";

/** VS claim state "proposed" (lib/gno/reads.ts VsClaim.state). */
export const VS_PROPOSED = 4;
/** Pool market state "proposed" (lib/gno/reads.ts PoolMarket.state). */
export const POOL_PROPOSED = 1;

/** The realm reads the auditor needs, bound to one network; injectable so tests never touch RPC. */
export interface AuditReads {
  vsClaims(offset: number, limit: number): Promise<VsClaim[] | null>;
  poolMarkets(offset: number, limit: number): Promise<PoolMarket[] | null>;
  vsClaim(id: number): Promise<VsClaim>;
  poolMarket(id: number): Promise<PoolMarket>;
  vsConfig(): Promise<MarketConfig>;
  poolConfig(): Promise<MarketConfig>;
}

export const gnoAuditReads = (cfg: GnoConfig): AuditReads => ({
  vsClaims: (o, l) => gnoReads.vsClaims(o, l, cfg),
  poolMarkets: (o, l) => gnoReads.poolMarkets(o, l, cfg),
  vsClaim: id => gnoReads.vsClaim(id, cfg),
  poolMarket: id => gnoReads.poolMarket(id, cfg),
  vsConfig: () => gnoReads.vsConfig(cfg),
  poolConfig: () => gnoReads.poolConfig(cfg),
});

/** Account reads and the one signer call; injectable for tests. */
export interface AuditChain {
  allowanceWei(owner: string, kind: MarketKind): Promise<bigint>;
  balanceWei(owner: string): Promise<bigint>;
  gasUgnot(owner: string): Promise<bigint>;
  /** Signs the messages as ONE transaction and waits for commit. */
  send(messages: GnoMsgCall[]): Promise<{ txHash: string }>;
  /** The committed transaction's outcome, or null when the node does not know it. */
  tx(hash: string): Promise<{ ok: boolean } | null>;
}

export function gnoAuditChain(cfg: GnoConfig, signer?: GnoSigner): AuditChain {
  return {
    allowanceWei: (owner, kind) => musdAllowanceWei(owner, kind, cfg),
    balanceWei: owner => musdBalanceWei(owner, cfg),
    gasUgnot: owner => gasBalanceUgnot(owner, cfg),
    send: async messages => {
      if (!signer) throw Error("Audit signing key is unavailable");
      return signer.send(messages);
    },
    tx: hash => gnoTx(hash, cfg),
  };
}

export const auditRealm = (cfg: GnoConfig, kind: MarketKind) => (kind === "vs" ? cfg.realms.vs : cfg.realms.pool);
export const auditConfigOf = (reads: AuditReads, kind: MarketKind) => (kind === "vs" ? reads.vsConfig() : reads.poolConfig());

const idOf = (id: string) => {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw Error("Invalid audit market id");
  return Number(id);
};

/** [Approve(bond), Dispute] when the allowance is short, else [Dispute]: always one transaction. */
export function auditDisputeMessages(cfg: GnoConfig, caller: string, kind: MarketKind, marketId: string, allowanceWei: bigint): GnoMsgCall[] {
  return actionMessages(caller, { type: "dispute", kind, marketId: idOf(marketId) }, allowanceWei, cfg);
}

/** A VS claim as an audit proposal (pure). `live` only while the claim is in the proposed state. */
export function vsAuditProposal(cfg: GnoConfig, c: VsClaim, conf: Pick<MarketConfig, "disputeWindow" | "now">): AuditProposal {
  const p = c.proposal;
  return {
    chainId: cfg.chainId, contract: cfg.realms.vs, kind: "vs", marketId: String(c.id),
    cutoff: c.settlementCutoff, proposedAt: p.proposedAt, disputableUntil: p.proposedAt + conf.disputeWindow, now: conf.now,
    live: c.state === VS_PROPOSED, side: p.winnerSide, evidenceHash: p.evidenceHash,
    question: c.question, labelA: c.creatorPosition, labelB: c.counterPosition, resolutionUrl: c.resolutionUrl,
    category: c.category, deadline: c.deadline, createdAt: c.createdAt, summary: p.summary,
  };
}

/** A pool market as an audit proposal (pure). */
export function poolAuditProposal(cfg: GnoConfig, m: PoolMarket, conf: Pick<MarketConfig, "disputeWindow" | "now">): AuditProposal {
  return {
    chainId: cfg.chainId, contract: cfg.realms.pool, kind: "pool", marketId: String(m.id),
    cutoff: m.settlementCutoff, proposedAt: m.proposedAt, disputableUntil: m.proposedAt + conf.disputeWindow, now: conf.now,
    live: m.state === POOL_PROPOSED, side: m.proposed, evidenceHash: m.evidenceHash,
    question: m.question, labelA: m.labelA, labelB: m.labelB, resolutionUrl: m.resolutionUrl,
    category: m.category, deadline: m.deadline, createdAt: m.createdAt, summary: m.summary,
  };
}

/** Read the proposal and immutable question from the configured realm, not the proposer's DB. */
export async function loadAuditProposal(cfg: GnoConfig, reads: AuditReads, kind: MarketKind, marketId: string): Promise<AuditProposal> {
  const id = idOf(marketId);
  if (kind === "vs") {
    const [c, conf] = await Promise.all([reads.vsClaim(id), reads.vsConfig()]);
    if (c.id !== id) throw Error("Audit realm returned a different claim");
    return vsAuditProposal(cfg, c, conf);
  }
  const [m, conf] = await Promise.all([reads.poolMarket(id), reads.poolConfig()]);
  if (m.id !== id) throw Error("Audit realm returned a different market");
  return poolAuditProposal(cfg, m, conf);
}

export async function readAuditRoles(reads: AuditReads, kind: MarketKind): Promise<AuditRoles> {
  const c = await auditConfigOf(reads, kind);
  return { auditAgent: c.auditAgent, owner: c.owner, arbiter: c.arbiter, oracle: c.oracle, feeRecipient: c.feeRecipient };
}

/** Only the dispute (with its bond approval in the same transaction) can be signed by this adapter. */
export function auditIO(cfg: GnoConfig, reads: AuditReads, chain: AuditChain, account: string | undefined, mode: "observe" | "challenge", job: AuditJob, save: AuditIO["save"]): AuditIO {
  const kind = job.proposal.kind;
  if (job.proposal.chainId !== cfg.chainId || job.proposal.contract !== auditRealm(cfg, kind)) throw Error("Audit job does not belong to this deployment");
  return {
    account, mode, save,
    load: () => loadAuditProposal(cfg, reads, kind, job.proposal.marketId),
    roles: () => readAuditRoles(reads, kind),
    review: p => reviewProposal(p),
    receipt: async hash => {
      const tx = await chain.tx(hash);
      return tx ? (tx.ok ? "success" : "reverted") : null;
    },
    prepareBond: async () => {
      if (!account) throw Error("Audit signing key is unavailable");
      const conf = await auditConfigOf(reads, kind);
      if (BigInt(conf.disputeBond) !== toMusdUnits(DISPUTE_BOND_WEI)) throw Error("Unsupported audit dispute bond");
      if (conf.paused) throw Error("Audit realm is paused");
      const [balance, gas] = await Promise.all([chain.balanceWei(account), chain.gasUgnot(account)]);
      if (balance < DISPUTE_BOND_WEI || gas === 0n) throw Error("Audit account needs the mUSD bond and GNOT gas");
    },
    submit: async () => {
      if (!account) throw Error("Audit signing key is unavailable");
      // Read the allowance right before signing: the Approve, if needed, lands in the same transaction as the dispute.
      const allowance = await chain.allowanceWei(account, kind);
      const { txHash } = await chain.send(auditDisputeMessages(cfg, account, kind, job.proposal.marketId, allowance));
      return txHash;
    },
  };
}
