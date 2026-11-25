import assert from "node:assert/strict";
import { test } from "node:test";

import { GNO } from "../../lib/gno/config";
import { agentPayMessages } from "../../lib/gno/msgs";
import { parseTxResult } from "../../lib/gno/tx";
import { callIdFor, minUnits, newAgentCall, parsePayment, priceUnits, quote, verifyAgentPayment } from "../../lib/launch/paid-call";

const NOW = 1_800_000_000_000;
const AGENT = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const PAYER = "g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz";
const HASH = "ab".repeat(32);
const SECRET = "5e".repeat(32);
const CALL_ID = callIdFor(SECRET);

test("a call is priced in mUSD units and offered through r/agentpay only to an agent with an account", () => {
  assert.equal(priceUnits(0.05), 50_000n);
  assert.equal(minUnits(0.05), 47_500n);
  assert.deepEqual(quote(0.05, null), []);
  const call = newAgentCall();
  const [o] = quote(0.05, AGENT, call);
  assert.deepEqual(o, { chain: "gno", asset: "mUSD", amount: "0.05", units: "50000", decimals: 6, payTo: GNO.realms.agentpay, agent: AGENT, callId: call.callId, secret: call.secret });
  assert.equal(callIdFor(o.secret), o.callId);
  assert.match(o.secret, /^[0-9a-f]{64}$/);
  assert.notEqual(newAgentCall().secret, call.secret);
  // What the payer signs: an exact Approve to r/agentpay and Pay with the call id, in one transaction.
  const [approve, pay] = agentPayMessages(PAYER, AGENT, 50_000n * 10n ** 12n, o.callId);
  assert.deepEqual([approve.value.func, pay.value.func, pay.value.args], ["Approve", "Pay", [AGENT, "50000", o.callId]]);
});

test("the payment header is gno:<tx>:<secret>", () => {
  assert.deepEqual(parsePayment(`gno:0x${HASH.toUpperCase()}:${SECRET.toUpperCase()}`), { chain: "gno", tx: HASH, secret: SECRET });
  assert.deepEqual(parsePayment(`GNO:${HASH}:${SECRET}`), { chain: "gno", tx: HASH, secret: SECRET });
  assert.equal(parsePayment(`gno:${HASH}`), null, "a public hash alone buys nothing");
  assert.equal(parsePayment(`gno:${HASH}:0x12`), null);
  assert.equal(parsePayment(`gno:0x12:${SECRET}`), null);
  assert.equal(parsePayment(`base:0x${HASH}:0x${SECRET}`), null);
  assert.equal(parsePayment(null), null);
});

const tx = (events: Array<{ pkg?: string; attrs?: Record<string, string>; type?: string }>, error: unknown = null) =>
  parseTxResult({
    hash: HASH,
    height: "9",
    tx_result: {
      ResponseBase: {
        Error: error,
        Events: events.map((e) => ({
          type: e.type ?? "Paid",
          pkg_path: e.pkg ?? GNO.realms.agentpay,
          attrs: Object.entries({ callId: CALL_ID, agent: AGENT, payer: PAYER, amount: "50000", ...e.attrs }).map(([key, value]) => ({ key, value })),
        })),
      },
    },
  });

test("only a fresh r/agentpay Paid event for the agent and the secret's call id counts", () => {
  const a = { agentpay: GNO.realms.agentpay, agent: AGENT, callId: CALL_ID, min: 47_500n, blockTime: NOW / 1000, now: NOW };
  assert.deepEqual(verifyAgentPayment(tx([{}]), a), { ok: true, units: 50_000n });
  assert.deepEqual(verifyAgentPayment(tx([{ attrs: { amount: "30000" } }, { attrs: { amount: "20000" } }]), a), { ok: true, units: 50_000n });
  assert.match(String((verifyAgentPayment(tx([{ attrs: { amount: "40000" } }]), a) as { error: string }).error), /0.04 mUSD/);
  assert.equal(verifyAgentPayment(tx([{ pkg: "gno.land/r/evil/agentpay" }]), a).ok, false);
  assert.equal(verifyAgentPayment(tx([{ attrs: { agent: PAYER } }]), a).ok, false);
  assert.equal(verifyAgentPayment(tx([{ type: "Transfer" }]), a).ok, false);
  assert.equal(verifyAgentPayment(tx([{}], { "@type": "/std.InternalError" }), a).ok, false);
  assert.equal(verifyAgentPayment(tx([{}]), { ...a, blockTime: NOW / 1000 - 2 * 3600 }).ok, false);
  assert.equal(verifyAgentPayment(tx([{}]), { ...a, blockTime: null }).ok, false);
  assert.equal(verifyAgentPayment(null, a).ok, false);
  // someone else's payment (another call id) in the tx does not count: the tx hash alone buys nothing
  assert.equal(verifyAgentPayment(tx([{ attrs: { callId: callIdFor("77".repeat(32)) } }]), a).ok, false);
  assert.deepEqual(verifyAgentPayment(tx([{ attrs: { callId: "99".repeat(32) } }, {}]), a), { ok: true, units: 50_000n });
});
