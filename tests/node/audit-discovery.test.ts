import assert from "node:assert/strict";
import test from "node:test";
import { discoverAuditJobs } from "../../agents/audit/discover";
import type { AuditReads } from "../../agents/audit/chain";
import type { AuditState } from "../../agents/audit/state";
import { gnoConfig } from "../../lib/gno/config";
import { GnoQueryError } from "../../lib/gno/rpc";
import type { MarketConfig, PoolMarket, VsClaim } from "../../lib/gno/reads";

const cfg = gnoConfig(() => undefined);
const hash = "1".repeat(64);
const g = "g1v9kxjcm9ta047h6lta047h6lta047h6lzd40gh";
const fresh = (): AuditState => ({ version: 2, deployment: "fixture", seen: {}, jobs: {} });
const conf = (now = 5000): MarketConfig => ({ owner: g, arbiter: g, oracle: g, auditAgent: g, feeRecipient: g, paused: false, disputeWindow: 3600, minStake: 1, disputeBond: 2_000_000, lockSeconds: 0, graceSeconds: 0, maxMarketStake: 0, maxAccountStake: 0, now });

// Realm JSON as ClaimsJSON / MarketsJSON return it (newest first).
const claim = (id: number, state: number, proposedAt: number): VsClaim => ({
  id, creator: g, question: `Claim ${id}?`, creatorPosition: "Yes", counterPosition: "No", resolutionUrl: "https://example.com/c", creatorStake: 1, totalChallengerStake: 1,
  reservedCreatorLiability: 0, eligibleCreator: 0, eligibleChallengers: 0, deadline: 99, state, winnerSide: 0, resolutionSummary: "", confidence: 0, category: "custom",
  parentId: 0, challengerCount: 1, createdAt: 1, marketType: "binary", oddsMode: "pool", challengerPayoutBps: 0, handicapLine: "", settlementRule: "", maxChallengers: 0,
  isPrivate: false, evidenceHash: "", referrer: "", entryFees: 0, settlementCutoff: 50, lockAt: 0,
  proposal: { winnerSide: 2, confidence: 95, proposedAt, disputedAt: 0, disputer: "", bond: 0, evidenceHash: hash, summary: `proposal ${id}` },
});
const market = (id: number, state: number, proposedAt: number): PoolMarket => ({
  id, creator: g, deadline: 99, createdAt: 1, state, outcome: 0, proposed: state === 0 ? 0 : 1, proposedAt, disputedAt: 0, disputer: "", bond: 0, totalA: 1, totalB: 1,
  eligibleA: 1, eligibleB: 1, entryFees: 0, settlementCutoff: 60, lockAt: 0, participants: 2, evidenceHash: hash, question: `Market ${id}?`, labelA: "A", labelB: "B",
  resolutionUrl: "https://example.com/m", category: "custom", summary: `pool proposal ${id}`,
});

function reads(over: Partial<AuditReads> = {}, now = 5000): AuditReads {
  return {
    // VS: 9 proposed (live), 8 active, 7 proposed but its window already closed (proposedAt + 3600 <= now), 6 disputed.
    vsClaims: async offset => (offset === 0 ? [claim(9, 4, 4950), claim(8, 1, 0), claim(7, 4, now - 3600), claim(6, 5, 120)] : []),
    // Pool: 5 proposed (live), 4 open, 3 resolved.
    poolMarkets: async offset => (offset === 0 ? [market(5, 1, 4980), market(4, 0, 0), market(3, 3, 100)] : []),
    vsClaim: async () => { throw Error("discovery must use the paged views"); },
    poolMarket: async () => { throw Error("discovery must use the paged views"); },
    vsConfig: async () => conf(now), poolConfig: async () => conf(now),
    ...over,
  };
}

test("discovery maps proposed realm rows inside their dispute window to jobs, once", async () => {
  const state = fresh();
  await discoverAuditJobs(cfg, state, reads());
  const jobs = Object.values(state.jobs).map(j => j.proposal).sort((a, b) => a.kind.localeCompare(b.kind));
  assert.equal(jobs.length, 2);
  const [pool, vs] = jobs;
  assert.deepEqual(vs, { chainId: cfg.chainId, contract: cfg.realms.vs, kind: "vs", marketId: "9", cutoff: 50, proposedAt: 4950, disputableUntil: 8550, now: 5000, live: true, side: 2, evidenceHash: hash, question: "Claim 9?", labelA: "Yes", labelB: "No", resolutionUrl: "https://example.com/c", category: "custom", deadline: 99, createdAt: 1, summary: "proposal 9" });
  assert.equal(pool.contract, cfg.realms.pool);assert.equal(pool.marketId, "5");assert.equal(pool.side, 1);assert.equal(pool.disputableUntil, 8580);assert.equal(pool.cutoff, 60);assert.equal(pool.summary, "pool proposal 5");
  assert.deepEqual(Object.keys(state.seen).sort(), [`${cfg.chainId}:${cfg.realms.pool}:pool:5:4980`, `${cfg.chainId}:${cfg.realms.vs}:vs:9:4950`]);
  // Replay: the same proposals are not queued twice, and a reviewed job is not reset.
  Object.values(state.jobs)[0].status = "agreed";
  await discoverAuditJobs(cfg, state, reads());
  assert.equal(Object.keys(state.jobs).length, 2);
  assert.ok(Object.values(state.jobs).some(j => j.status === "agreed"));
});

test("a new proposal on the same market (re-proposal after a ruling) is a new job", async () => {
  const state = fresh();
  await discoverAuditJobs(cfg, state, reads());
  await discoverAuditJobs(cfg, state, reads({ vsClaims: async o => (o === 0 ? [claim(9, 4, 4990)] : []) }));
  assert.equal(Object.values(state.jobs).filter(j => j.proposal.kind === "vs").length, 2);
});

test("closed windows are pruned from the checkpoint", async () => {
  const state = fresh();
  await discoverAuditJobs(cfg, state, reads());
  await discoverAuditJobs(cfg, state, reads({}, 9000));
  assert.equal(Object.keys(state.jobs).length, 0);assert.equal(Object.keys(state.seen).length, 0);
});

test("an undeployed realm is skipped with a warning; other read failures block discovery", async () => {
  const state = fresh();const warnings: string[] = [];
  const missing = async () => { throw new GnoQueryError(`package not found: ${cfg.realms.vs}`); };
  await discoverAuditJobs(cfg, state, reads({ vsConfig: missing, vsClaims: missing }), { warn: m => warnings.push(m) });
  assert.equal(warnings.length, 1);assert.match(warnings[0], /vs/);
  assert.deepEqual(Object.values(state.jobs).map(j => j.proposal.kind), ["pool"]);
  const blocked = fresh();
  await assert.rejects(discoverAuditJobs(cfg, blocked, reads({ poolMarkets: async () => { throw Error("RPC failed"); } }), { warn: () => {} }), /RPC failed/);
  assert.equal(Object.keys(blocked.jobs).filter(k => k.includes('"pool"')).length, 0);
});

test("paging reads every page of a realm view", async () => {
  const pages: number[] = [];
  const page = Array.from({ length: 100 }, (_, i) => market(1000 - i, 0, 0));
  const state = fresh();
  await discoverAuditJobs(cfg, state, reads({ poolMarkets: async o => { pages.push(o);return o === 0 ? page : o === 100 ? [market(5, 1, 4980)] : []; } }));
  assert.deepEqual(pages, [0, 100]);
  assert.ok(Object.values(state.jobs).some(j => j.proposal.kind === "pool" && j.proposal.marketId === "5"));
});
