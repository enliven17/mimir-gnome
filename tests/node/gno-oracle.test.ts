import assert from "node:assert/strict";
import test from "node:test";

import { GNO } from "../../lib/gno/config";
import { claimForMessage, evidenceHashArg, finalizeMessage, refundMessage, resolveMessage } from "../../lib/gno/oracle";
import { sealBundle } from "../../lib/verdict-bundle";

const oracle = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const hash = "ab".repeat(32);

test("verdicts go on chain with the realm's exact arguments", () => {
  const vs = resolveMessage(oracle, { kind: "vs", marketId: 3, side: 2, summary: "Challengers win", confidence: 87.4, evidenceHash: hash, cutoff: 1_800_000_000 });
  assert.deepEqual(vs.value, { caller: oracle, send: "", max_deposit: "", pkg_path: GNO.realms.vs, func: "ResolveClaimWithCutoff", args: ["3", "2", "Challengers win", "87", hash, "1800000000"] });
  const pool = resolveMessage(oracle, { kind: "pool", marketId: 4, side: 3, summary: "x".repeat(900), confidence: 100, evidenceHash: null, cutoff: 0 });
  assert.equal(pool.value.func, "ResolveWithCutoff");
  assert.deepEqual([pool.value.args[0], pool.value.args[1], pool.value.args[2].length, pool.value.args[3], pool.value.args[4]], ["4", "3", 500, "", "0"]);
  assert.throws(() => resolveMessage(oracle, { kind: "pool", marketId: 4, side: 5, summary: "", confidence: 0, evidenceHash: null, cutoff: 0 }), /bad side/);
});

test("evidence hashes are lowercase hex sha256, the zero hash is none", () => {
  const sealed = sealBundle({ version: 1 } as never);
  assert.equal(evidenceHashArg(sealed.bytes), sealed.hash);
  assert.equal(evidenceHashArg(`0x${hash.toUpperCase()}`), hash);
  assert.equal(evidenceHashArg(`0x${"0".repeat(64)}`), "");
  assert.equal(evidenceHashArg(""), "");
  assert.throws(() => evidenceHashArg("abc"), /32 bytes/);
});

test("finalize, refund and push payouts name the right realm calls", () => {
  assert.deepEqual([finalizeMessage(oracle, "vs", 3).value.func, finalizeMessage(oracle, "pool", 3).value.func], ["FinalizeResolution", "Finalize"]);
  assert.deepEqual(refundMessage(oracle, "pool", 9).value.args, ["9"]);
  const pay = claimForMessage(oracle, 4, "g1user").value;
  assert.deepEqual([pay.pkg_path, pay.func, pay.args], [GNO.realms.pool, "ClaimFor", ["4", "g1user"]]);
});
