import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { GnoWallet } from "@gnolang/gno-js-client";

import { GNO } from "../../lib/gno/config";
import { addressFromMnemonic, isMnemonic, newMnemonic } from "../../lib/gno/keys";
import { agentCallPaid, callIdFor, musdTransferPaid, newCallSecret } from "../../lib/gno/payments";
import { normalizeTxHash, parseTxResult, type GnoTx } from "../../lib/gno/tx";
import { newSealedWallet, openMnemonic, sealMnemonic, createdMarketId } from "../../lib/server/gno-wallets";

// gnodev's test1 account: its address is fixed by the chain's genesis.
const TEST1 = "source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast";

test("addresses derive like gnokey and gno-js-client", async () => {
  assert.equal(addressFromMnemonic(TEST1), "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  const m = newMnemonic();
  assert.equal(m.split(" ").length, 24);
  assert.ok(isMnemonic(m));
  assert.equal(addressFromMnemonic(m), await (await GnoWallet.fromMnemonic(m)).getAddress());
  assert.throws(() => addressFromMnemonic("not a mnemonic at all"));
});

test("tx hashes normalize from hex and base64", () => {
  const hex = "ff3f0a74a829d15a2b5c50153673fca01100e3daa9c776f1165b95bd4b1fef66";
  assert.equal(normalizeTxHash(`0x${hex.toUpperCase()}`), hex);
  assert.equal(normalizeTxHash("/z8KdKgp0VorXFAVNnP8oBEA49qpx3bxFluVvUsf72Y="), hex);
  assert.equal(normalizeTxHash("nope"), null);
});

// The shape the `tx` RPC returns on onyx-1.
type RawEvent = ReturnType<typeof ev>;
const raw = (events: RawEvent[], error: unknown = null): Parameters<typeof parseTxResult>[0] => ({
  hash: "/z8KdKgp0VorXFAVNnP8oBEA49qpx3bxFluVvUsf72Y=",
  height: "1354412",
  index: 0,
  tx_result: { ResponseBase: { Error: error, Data: null, Events: events, Log: error ? "msg:0,success:false,log:boom\nmore" : "", Info: "" }, GasWanted: "1", GasUsed: "1" },
});
const ev = (pkg_path: string, type: string, attrs: Record<string, string>) => ({ "@type": "/tm.GnoEvent", type, pkg_path, attrs: Object.entries(attrs).map(([key, value]) => ({ key, value })) });

const payer = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const treasury = "g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz";

test("a failed tx carries no events", () => {
  const tx = parseTxResult(raw([ev(GNO.realms.musd, "Transfer", { from: payer, to: treasury, value: "1" })], { "@type": "/std.InternalError" }));
  assert.equal(tx.ok, false);
  assert.equal(tx.events.length, 0);
  assert.equal(tx.error, "msg:0,success:false,log:boom");
  assert.deepEqual(musdTransferPaid(tx, { musd: GNO.realms.musd, to: treasury, min: 1n }), { ok: false, error: "That transaction failed on chain." });
});

test("mUSD transfers count only from the mUSD realm, to the recipient, from the payer", () => {
  const tx: GnoTx = parseTxResult(raw([
    ev(GNO.realms.musd, "Transfer", { token: "1", from: payer, to: treasury, value: "600000" }),
    ev(GNO.realms.musd, "Transfer", { token: "1", from: payer, to: treasury, value: "400000" }),
    ev("gno.land/r/someone/fake", "Transfer", { from: payer, to: treasury, value: "99000000" }),
    ev(GNO.realms.musd, "Transfer", { from: "g1other", to: treasury, value: "5000000" }),
  ]));
  assert.deepEqual(musdTransferPaid(tx, { musd: GNO.realms.musd, to: treasury, from: [payer], min: 1_000_000n }), { ok: true, units: 1_000_000n, payer });
  const short = musdTransferPaid(tx, { musd: GNO.realms.musd, to: treasury, from: [payer], min: 2_000_000n });
  assert.equal(short.ok, false);
  assert.match((short as { error: string }).error, /1 mUSD; 2 is due/);
  assert.equal(musdTransferPaid(tx, { musd: GNO.realms.musd, to: payer, min: 1n }).ok, false);
});

test("agent calls are paid by an r/agentpay Paid event for the secret's call id", () => {
  const secret = newCallSecret();
  assert.match(secret, /^[0-9a-f]{64}$/);
  const callId = callIdFor(secret);
  assert.equal(callId, createHash("sha256").update(secret).digest("hex"));
  const agent = "g1agent";
  const tx = parseTxResult(raw([
    ev(GNO.realms.musd, "Transfer", { from: payer, to: agent, value: "50000" }),
    ev(GNO.realms.agentpay, "Paid", { callId, agent, payer, amount: "50000" }),
    ev("gno.land/r/x/agentpay", "Paid", { callId, agent, payer, amount: "50000000" }),
  ]));
  assert.deepEqual(agentCallPaid(tx, { agentpay: GNO.realms.agentpay, agent, callId, min: 47_500n }), { ok: true, units: 50_000n, payer });
  assert.equal(agentCallPaid(tx, { agentpay: GNO.realms.agentpay, agent, callId: callIdFor(newCallSecret()), min: 1n }).ok, false);
  assert.equal(agentCallPaid(tx, { agentpay: GNO.realms.agentpay, agent: payer, callId, min: 1n }).ok, false);
  assert.equal(agentCallPaid(tx, { agentpay: GNO.realms.agentpay, agent, callId, min: 60_000n }).ok, false);
});

test("sealed wallets open only in their own scope and with the secret", () => {
  const secret = "s".repeat(40);
  const w = newSealedWallet("launch:alpha", secret);
  assert.match(w.address, /^g1/);
  const m = openMnemonic("launch:alpha", w, secret);
  assert.equal(addressFromMnemonic(m), w.address);
  assert.throws(() => openMnemonic("launch:beta", w, secret));
  assert.throws(() => openMnemonic("launch:alpha", w, "t".repeat(40)));
  assert.throws(() => openMnemonic("launch:alpha", { ...sealMnemonic("launch:alpha", TEST1, secret), address: w.address }, secret));
  assert.throws(() => newSealedWallet("x", "short"));
});

test("the created market id comes from the realm's own event", () => {
  const events = [
    { pkgPath: "gno.land/r/x/pool", type: "MarketCreated", attrs: { id: "99" } },
    { pkgPath: GNO.realms.pool, type: "MarketCreated", attrs: { id: "7" } },
    { pkgPath: GNO.realms.vs, type: "ClaimCreated", attrs: { id: "3" } },
  ];
  assert.equal(createdMarketId({ events }, "pool"), 7);
  assert.equal(createdMarketId({ events }, "vs"), 3);
  assert.equal(createdMarketId({ events: [] }, "pool"), null);
});
