import assert from "node:assert/strict";
import test from "node:test";

import { gnoOperatorOf, prepareGnoWrite } from "../../lib/agents/gno-chain";
import { parseWriteParams } from "../../lib/agents/params";
import { realmAddress } from "../../lib/gno/address";
import { GNO } from "../../lib/gno/config";
import { parseTxResult } from "../../lib/gno/tx";
import { verifyDeployPayment, type DeployPaymentDeps } from "../../lib/server/agent-payment";

const op = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const write = (action: string, params: Record<string, unknown>) => ({ action, params });

test("a challenge is one unsigned MsgCall from the operator when the allowance covers it", () => {
  const r = prepareGnoWrite(write("challenge", { claimId: 7n, stakeUnits: 2_500_000n }), {}, op, 10n ** 19n);
  assert.equal(r.chain, "gno");
  assert.equal(r.chainId, GNO.chainId);
  assert.equal(r.messages.length, 1);
  const [m] = r.messages;
  assert.equal(m.type, "/vm.m_call");
  assert.deepEqual(m.value, { caller: op, send: "", max_deposit: "", pkg_path: GNO.realms.vs, func: "ChallengeClaim", args: ["7", "2500000", ""] });
  assert.equal(r.fee.gasFee, `${GNO.gas.fee}ugnot`);
});

test("a short allowance puts an exact mUSD Approve in front, in the same transaction", () => {
  const r = prepareGnoWrite(write("challenge", { claimId: 3n, stakeUnits: 2_000_000n }), { kind: "pool", side: 1 }, op, 0n);
  assert.equal(r.messages.length, 2);
  const [approve, stake] = r.messages;
  assert.equal(approve.value.pkg_path, GNO.realms.musd);
  assert.equal(approve.value.func, "Approve");
  assert.deepEqual(approve.value.args, [realmAddress(GNO.realms.pool), "2000000"]);
  assert.equal(stake.value.func, "Stake");
  assert.deepEqual(stake.value.args, ["3", "1", "", "2000000"]);
  assert.match(r.description, /Approve/);
});

test("dispute carries the 2 mUSD bond; withdraw claims a pool payout; bad input is refused", () => {
  const d = prepareGnoWrite(write("dispute", { claimId: 3n }), {}, op, 0n).messages;
  assert.deepEqual(d[0].value.args, [realmAddress(GNO.realms.vs), "2000000"]);
  assert.equal(d[1].value.func, "DisputeResolution");
  const w = prepareGnoWrite(write("withdraw", { claimId: 4n }), { kind: "pool" }, op).messages;
  assert.deepEqual([w.length, w[0].value.pkg_path, w[0].value.func, w[0].value.args], [1, GNO.realms.pool, "Claim", ["4"]]);
  assert.throws(() => prepareGnoWrite(write("withdraw", { claimId: 4n }), { kind: "vs" }, op), /pay at settlement/);
  assert.throws(() => prepareGnoWrite(write("deposit", {}), {}, op), /not an on-chain write/);
  assert.throws(() => prepareGnoWrite(write("challenge", { claimId: 1n, stakeUnits: 2_000_000n }), { kind: "pool", side: 3 }, op), /side/);
  assert.throws(() => prepareGnoWrite(write("challenge", { claimId: 1n, stakeUnits: 2_000_000n }), { chain: "base" }, op), /chain must be "gno"/);
});

test("createClaim opens a VS claim or a pool with the seed on a side", () => {
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const p = parseWriteParams("createClaim", { question: "Will it rain?", creatorPosition: "Yes", counterPosition: "No", resolutionUrl: "https://example.com", category: "custom", stakeUsdc: 1.5, deadline });
  const vs = prepareGnoWrite(p as never, {}, op, 10n ** 20n).messages[0].value;
  assert.equal(vs.func, "CreateClaim");
  assert.deepEqual(vs.args.slice(0, 6), ["Will it rain?", "Yes", "No", "https://example.com", String(deadline), "1500000"]);
  const pool = prepareGnoWrite(p as never, { kind: "pool", side: 2 }, op, 10n ** 20n).messages[0].value;
  assert.equal(pool.func, "CreateMarket");
  assert.deepEqual(pool.args, ["Will it rain?", "Yes", "No", "https://example.com", "custom", String(deadline), "2", "", "1500000"]);
});

test("operators must be gno.land addresses", () => {
  assert.equal(gnoOperatorOf(op.toUpperCase()), op);
  assert.equal(gnoOperatorOf("0x0c6eea6557fe5c36e34ff8c4dfc0b6035b356fa7"), null);
});

const treasury = "g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz";
const hash = "ab".repeat(32);
const transfer = (from: string, value: string, pkg = GNO.realms.musd) =>
  parseTxResult({ hash, height: "5", tx_result: { ResponseBase: { Error: null, Events: [{ type: "Transfer", pkg_path: pkg, attrs: [{ key: "from", value: from }, { key: "to", value: treasury }, { key: "value", value }] }] } } });
const deps = (tx: ReturnType<typeof transfer> | null, used = false): DeployPaymentDeps => ({ tx: async () => tx, treasury: async () => treasury, used: async () => used, musd: GNO.realms.musd });
const ONE = 10n ** 18n;

test("the deploy fee is an mUSD transfer from the owner to the fee recipient, used once", async () => {
  assert.equal(await verifyDeployPayment(`0x${hash.toUpperCase()}`, ONE, [op], deps(transfer(op, "1000000"))), hash);
  await assert.rejects(() => verifyDeployPayment(undefined, ONE, [op], deps(null)), /paymentTx/);
  await assert.rejects(() => verifyDeployPayment(hash, ONE, [op], deps(null)), /not found yet/);
  await assert.rejects(() => verifyDeployPayment(hash, ONE, [op], deps(transfer(op, "1000000"), true)), /already paid/);
  await assert.rejects(() => verifyDeployPayment(hash, ONE, [op], deps(transfer(op, "999999"))), /0.999999 mUSD; 1 is due/);
  await assert.rejects(() => verifyDeployPayment(hash, ONE, [op], deps(transfer("g1someoneelse", "1000000"))), /no mUSD transfer/);
  await assert.rejects(() => verifyDeployPayment(hash, ONE, [op], deps(transfer(op, "1000000", "gno.land/r/fake/musd"))), /no mUSD transfer/);
});
