import assert from "node:assert/strict";
import test from "node:test";

import { poolSnapshot, vsSnapshot } from "../../lib/chains/snapshot";
import type { PoolMarket, VsClaim } from "../../lib/gno/reads";

const G = (c: string) => `g1${c.repeat(38)}`;
const E12 = 1_000_000_000_000n;

const claim = (over: Partial<VsClaim> = {}): VsClaim => ({
  id: 4, creator: G("c"), question: "Will it rain?", creatorPosition: "Yes", counterPosition: "No", resolutionUrl: "https://x.example",
  creatorStake: 2_000_000, totalChallengerStake: 1_500_000, reservedCreatorLiability: 0, eligibleCreator: 2_000_000, eligibleChallengers: 1_000_000,
  deadline: 1_000, state: 1, winnerSide: 0, resolutionSummary: "", confidence: 0, category: "weather", parentId: 0, challengerCount: 3,
  createdAt: 900, marketType: "binary", oddsMode: "pool", challengerPayoutBps: 0, handicapLine: "", settlementRule: "", maxChallengers: 0,
  isPrivate: true, evidenceHash: "", referrer: "", entryFees: 0, settlementCutoff: 0, lockAt: 950,
  proposal: { winnerSide: 0, confidence: 0, proposedAt: 0, disputedAt: 0, disputer: "", bond: 0, evidenceHash: "", summary: "" },
  ...over,
});

test("vs snapshot: 6-dp realm amounts become 18-dp rows; challengers are summed per wallet", () => {
  const challengers = [{ address: G("a"), stake: 500_000, at: 1, referrer: "" }, { address: G("p"), stake: 400_000, at: 2, referrer: "" }, { address: G("a"), stake: 600_000, at: 3, referrer: "" }];
  const { market, positions } = vsSnapshot(claim(), challengers, 3_600, 12);
  assert.equal(market.chain, "gno");
  assert.equal(market.status, "active");
  assert.equal(market.stakeA, (2_000_000n * E12).toString());
  assert.equal(market.stakeB, (1_500_000n * E12).toString());
  assert.equal(market.eligibleB, (1_000_000n * E12).toString());
  assert.equal(market.volumeUsd, 3.5);
  assert.equal(market.participants, 3);
  assert.equal(market.isPrivate, true);
  assert.equal(market.lockAt, 950);
  assert.equal(market.updatedBlock, 12);
  assert.equal(market.refundAt, 1_000 + 7 * 86_400);
  assert.deepEqual(positions.map((p) => [p.user, p.side, p.amountUsd]), [[G("c"), 1, 2], [G("a"), 2, 1.1], [G("p"), 2, 0.4]]);
});

test("vs snapshot: a proposal opens a dispute window; a dispute with no disputer is the owner's veto", () => {
  const proposed = vsSnapshot(claim({ state: 4, proposal: { ...claim().proposal, proposedAt: 2_000 } }), [], 3_600).market;
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.disputableUntil, 5_600);
  const veto = vsSnapshot(claim({ state: 5, proposal: { ...claim().proposal, proposedAt: 2_000, disputedAt: 2_100 } }), [], 3_600).market;
  assert.equal(veto.vetoed, true);
  const disputed = vsSnapshot(claim({ state: 5, proposal: { ...claim().proposal, proposedAt: 2_000, disputer: G("d") } }), [], 3_600).market;
  assert.equal(disputed.vetoed, false);
});

const pool = (over: Partial<PoolMarket> = {}): PoolMarket => ({
  id: 9, creator: G("c"), deadline: 1_000, createdAt: 900, state: 0, outcome: 0, proposed: 0, proposedAt: 0, disputedAt: 0, disputer: "", bond: 0,
  totalA: 3_000_000, totalB: 0, eligibleA: 3_000_000, eligibleB: 0, entryFees: 0, settlementCutoff: 0, lockAt: 0, participants: 2, evidenceHash: "",
  question: "Q?", labelA: "A", labelB: "B", resolutionUrl: "https://x.example", category: "crypto", summary: "",
  ...over,
});

test("pool snapshot: positions per side for the wallets asked; an expired refund reads as cancelled", () => {
  const { market, positions } = poolSnapshot(pool(), [{ user: G("a"), position: { a: 1_000_000, b: 0 } }, { user: G("p"), position: { a: 0, b: 0 } }, { user: G("c"), position: { a: 2_000_000, b: 250_000 } }], 600);
  assert.equal(market.status, "open");
  assert.equal(market.participants, 2);
  assert.equal(market.stakeA, (3_000_000n * E12).toString());
  assert.deepEqual(positions.map((p) => [p.user, p.side, p.amount]), [[G("a"), 1, (1_000_000n * E12).toString()], [G("c"), 1, (2_000_000n * E12).toString()], [G("c"), 2, (250_000n * E12).toString()]]);
  assert.equal(poolSnapshot(pool({ state: 3, outcome: 4 }), [], 600).market.status, "cancelled");
  assert.equal(poolSnapshot(pool({ state: 3, outcome: 1 }), [], 600).market.status, "resolved");
  assert.equal(poolSnapshot(pool({ state: 2, proposedAt: 1_100, disputedAt: 1_200 }), [], 600).market.vetoed, true);
});
