import assert from "node:assert/strict";
import test from "node:test";

import { DISPUTE_BOND_WEI, type GnoMsgCall, type MarketAction } from "../../lib/chains/calls";
import { MARKET_CHAINS } from "../../lib/chains/registry";
import { NoGasError, sendMarketAction, type MarketSendDeps } from "../../lib/chains/send";

const gno = MARKET_CHAINS.chains.gno;
const ME = `g1${"q".repeat(38)}`;
const MUSD = 1_000_000_000_000_000_000n; // 1 mUSD in index units

const stakePool: MarketAction = { type: "stake", kind: "pool", marketId: 5, stake: 2n * MUSD, side: 1 };
const stakeVs: MarketAction = { type: "stake", kind: "vs", marketId: 9, stake: 3n * MUSD, side: 2 };

function deps(over: Partial<MarketSendDeps> & { allowanceWei?: bigint } = {}) {
  const sent: GnoMsgCall[][] = [];
  const asked: string[] = [];
  const d: MarketSendDeps = {
    allowance: async (owner, kind) => (asked.push(`${owner}:${kind}`), over.allowanceWei ?? 0n),
    send: async (messages) => (sent.push(messages), { txHash: "h1", height: 7 }),
    ...over,
  };
  return { d, sent, asked };
}

test("send: the allowance covers the pull → the call alone, one transaction", async () => {
  const { d, sent, asked } = deps({ allowanceWei: 2n * MUSD });
  const r = await sendMarketAction(gno, ME, stakePool, d);
  assert.equal(r.path, "allowance");
  assert.equal(r.txHash, "h1");
  assert.deepEqual(asked, [`${ME}:pool`]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((m) => m.value.func), ["Stake"]);
  assert.equal(sent[0][0].value.caller, ME);
});

test("send: a short allowance puts an exact Approve to the market realm in the SAME transaction", async () => {
  const { d, sent, asked } = deps({ allowanceWei: MUSD });
  const r = await sendMarketAction(gno, ME, stakeVs, d);
  assert.equal(r.path, "approve");
  assert.deepEqual(asked, [`${ME}:vs`]);
  assert.equal(sent.length, 1);
  const [approve, call] = sent[0];
  assert.equal(approve.value.pkg_path, gno.realms.musd);
  assert.equal(approve.value.func, "Approve");
  assert.equal(approve.value.args[1], "3000000");
  assert.equal(call.value.pkg_path, gno.realms.vs);
  assert.equal(call.value.func, "ChallengeClaim");
});

test("send: a dispute approves the bond; calls that pull nothing never read the allowance", async () => {
  const dispute = deps();
  await sendMarketAction(gno, ME, { type: "dispute", kind: "pool", marketId: 3 }, dispute.d);
  assert.equal(dispute.sent[0][0].value.args[1], (DISPUTE_BOND_WEI / 1_000_000_000_000n).toString());
  for (const a of [{ type: "claim", marketId: 3 }, { type: "cancel", marketId: 4 }, { type: "invite", marketId: 7, accounts: [ME], allowed: true }] as MarketAction[]) {
    const { d, sent, asked } = deps();
    await sendMarketAction(gno, ME, a, d);
    assert.deepEqual(asked, []);
    assert.equal(sent[0].length, 1);
  }
});

test("send: no GNOT stops before the wallet opens; an unknown gas balance does not", async () => {
  const empty = deps({ gasBalance: async () => 0n });
  await assert.rejects(sendMarketAction(gno, ME, stakePool, empty.d), NoGasError);
  assert.equal(empty.sent.length, 0);
  const unknown = deps({ gasBalance: async () => { throw new Error("rpc down"); } });
  await sendMarketAction(gno, ME, stakePool, unknown.d);
  assert.equal(unknown.sent.length, 1);
});

test("send: sub-unit dust never reaches the wallet; a wallet refusal propagates", async () => {
  const { d, sent } = deps();
  await assert.rejects(sendMarketAction(gno, ME, { ...stakePool, stake: MUSD + 1n } as MarketAction, d), /precision/);
  assert.equal(sent.length, 0);
  const refused = deps({ send: async () => { throw Object.assign(new Error("rejected"), { code: 4000 }); } });
  await assert.rejects(sendMarketAction(gno, ME, stakePool, refused.d), /rejected/);
});
