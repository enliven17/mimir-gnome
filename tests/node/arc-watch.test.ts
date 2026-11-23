import assert from "node:assert/strict";
import { test } from "node:test";

import { proposalProblem, roleProblems } from "../../lib/arc/watch";

const SAFE = "g1v9kxjcm9ta047h6lta047h6lta047h6lzd40gh";
const ORACLE = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const healthy = { name: "r/vs", address: "gno.land/r/x/vs", owner: SAFE, paused: false, oracle: ORACLE, arbiter: SAFE, feeRecipient: SAFE, pending: { owner: "", oracle: "" } };

test("a healthy realm raises nothing; case and an EVM zero address in pending do not matter", () => {
  assert.deepEqual(roleProblems({ ...healthy, oracle: ORACLE.toUpperCase().replace("G1", "g1") }, ORACLE), []);
  assert.deepEqual(roleProblems({ ...healthy, pending: { owner: `0x${"0".repeat(40)}` } }, ORACLE), []);
});

test("pause, a foreign oracle, a split arbiter and a queued change are each reported", () => {
  const keys = roleProblems({ ...healthy, paused: true, oracle: "g1bad", arbiter: "g1other", pending: { owner: "g1thief" } }, ORACLE).map((p) => p.key.split(":")[0]);
  assert.deepEqual(keys, ["paused", "oracle", "arbiter", "pending"]);
});

test("a proposal matching our verdict is fine; a different or unknown one is an anomaly", () => {
  const p = { kind: "pool", marketId: 7, question: "Q", disputableUntil: 1_800_000_000, verdictSide: 1 };
  assert.equal(proposalProblem(p, 1), null);
  assert.match(proposalProblem(p, 2)!.text, /ORACLE ANOMALY/);
  assert.match(proposalProblem({ ...p, verdictSide: null }, 1)!.text, /recorded nothing/);
});
