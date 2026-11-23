import assert from "node:assert/strict";
import test from "node:test";

import { gnoConfig } from "../../lib/gno/config";
import { actionMessages, agentPayMessages, DISPUTE_BOND_WEI, fromMusdUnits, toMusdUnits, transferMessage, type MarketAction } from "../../lib/gno/msgs";
import { qevalValues, unquoteGo } from "../../lib/gno/rpc";

const cfg = gnoConfig(() => undefined);
const me = "g1v9kxjcm9ta047h6lta047h6lta047h6lzd40gh";
const usd = (n: number) => fromMusdUnits(n * 1_000_000);

test("index units convert to mUSD units and refuse dust", () => {
  assert.equal(toMusdUnits(usd(2)), 2_000_000n);
  assert.throws(() => toMusdUnits(1n), /precision/);
  assert.equal(fromMusdUnits(1n), 1_000_000_000_000n);
});

test("a pool stake approves the exact pull in the same transaction when the allowance is short", () => {
  const a: MarketAction = { type: "stake", kind: "pool", marketId: 7, stake: usd(5), side: 2 };
  const [approve, stake] = actionMessages(me, a, 0n, cfg);
  assert.equal(approve.value.pkg_path, cfg.realms.musd);
  assert.equal(approve.value.func, "Approve");
  assert.deepEqual(approve.value.args, ["g15s5wce4jrntmlvwww3ct84xfxdavtvfrm3sz6x", "5000000"]);
  assert.equal(stake.value.pkg_path, cfg.realms.pool);
  assert.deepEqual([stake.value.func, ...stake.value.args], ["Stake", "7", "2", "", "5000000"]);
  assert.equal(actionMessages(me, a, usd(5), cfg).length, 1);
});

test("VS calls map to the VS realm", () => {
  const msgs = actionMessages(me, { type: "stake", kind: "vs", marketId: 3, stake: usd(1), side: 2, referrer: me }, usd(10), cfg);
  assert.deepEqual([msgs[0].value.func, ...msgs[0].value.args], ["ChallengeClaim", "3", "1000000", me]);
  const [approve, dispute] = actionMessages(me, { type: "dispute", kind: "vs", marketId: 3 }, 0n, cfg);
  assert.equal(approve.value.args[1], toMusdUnits(DISPUTE_BOND_WEI).toString());
  assert.equal(dispute.value.func, "DisputeResolution");
  const create = actionMessages(me, {
    type: "create",
    market: { kind: "vs", question: "Q", labelA: "Yes", labelB: "No", resolutionUrl: "u", category: "Crypto", deadline: 100, stake: usd(1), isPrivate: true },
  }, usd(1), cfg)[0];
  assert.equal(create.value.func, "CreateClaim");
  assert.equal(create.value.args.length, 16);
  assert.equal(create.value.args[14], "true");
});

test("agent pay approves the agentpay realm and pays in one transaction", () => {
  const [approve, pay] = agentPayMessages(me, me, usd(1), "ab".repeat(32), cfg);
  assert.equal(approve.value.args[0], "g186afur36qzagt3tp969lsnx0rzlfhm4egqyktf");
  assert.deepEqual(pay.value.args, [me, "1000000", "ab".repeat(32)]);
});

test("qeval output parses, including Go string escapes", () => {
  const out = '("a\\"b\\x41" string)\n(42 int64)';
  const [s, n] = qevalValues(out);
  assert.equal(unquoteGo(s.value), 'a"bA');
  assert.deepEqual(n, { value: "42", type: "int64" });
});

test("an mUSD transfer sends whole mUSD units to the recipient and refuses zero or dust", () => {
  const m = transferMessage(me, "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5", usd(2.5), cfg);
  assert.equal(m.value.pkg_path, cfg.realms.musd);
  assert.deepEqual([m.value.func, ...m.value.args], ["Transfer", "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5", "2500000"]);
  assert.throws(() => transferMessage(me, me, 0n, cfg), /Invalid amount/);
  assert.throws(() => transferMessage(me, me, 1n, cfg), /precision/);
});
