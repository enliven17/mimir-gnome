import assert from "node:assert/strict";
import test from "node:test";

import { GNO } from "../../lib/gno/config";
import { eventRows, touchedMarkets, type IndexedBlock } from "../../lib/gno/indexer";

const ev = (pkgPath: string, type: string, attrs: Record<string, string>) => ({ pkgPath, type, attrs });
const alice = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";

const blocks: IndexedBlock[] = [
  {
    height: 100,
    time: 1_800_000_000,
    txs: ["aa", "bb"],
    results: [
      {
        ok: true,
        events: [
          ev(GNO.realms.musd, "Transfer", { from: alice, to: "g1pool", value: "2000000" }),
          ev(GNO.realms.pool, "FeeAccrued", { id: "4", recipient: "g1fees", amount: "10000" }),
          ev(GNO.realms.pool, "Staked", { id: "4", user: alice.toUpperCase(), side: "2", amount: "1990000" }),
        ],
      },
      // A failed tx emits nothing that counts.
      { ok: false, events: [ev(GNO.realms.pool, "Staked", { id: "9", user: alice, side: "1", amount: "1" })] },
    ],
  },
  {
    height: 101,
    time: 1_800_000_005,
    txs: ["cc"],
    results: [
      {
        ok: true,
        events: [
          ev(GNO.realms.vs, "ClaimChallenged", { id: "3", challenger: alice, stake: "500000" }),
          ev(GNO.realms.vs, "ResolutionProposed", { id: "3", winnerSide: "2", confidence: "90", evidenceHash: "", disputableUntil: "1" }),
          ev(GNO.realms.pool, "ResolutionProposed", { id: "4", outcome: "1", evidenceHash: "", disputableUntil: "1" }),
          ev("gno.land/r/other/pool", "Staked", { id: "4", user: alice, side: "1", amount: "1" }),
          ev(GNO.realms.vs, "FeeClaimed", { recipient: alice, to: alice, amount: "1" }),
        ],
      },
    ],
  },
];

test("only the market realms' events become activity rows, amounts in index units", () => {
  const rows = eventRows(blocks, GNO);
  assert.deepEqual(rows.map((r) => [r.kind, r.marketId, r.name, r.txHash, r.logIndex, r.block, r.at]), [
    ["pool", 4, "FeeAccrued", "aa", 1, 100, 1_800_000_000],
    ["pool", 4, "Staked", "aa", 2, 100, 1_800_000_000],
    ["vs", 3, "ClaimChallenged", "cc", 0, 101, 1_800_000_005],
    ["vs", 3, "ResolutionProposed", "cc", 1, 101, 1_800_000_005],
    ["pool", 4, "ResolutionProposed", "cc", 2, 101, 1_800_000_005],
  ]);
  const staked = rows[1];
  assert.equal(staked.user, alice);
  assert.equal(staked.side, 2);
  assert.equal(staked.amount, (1_990_000n * 10n ** 12n).toString());
  assert.equal(rows[3].side, 2, "r/vs names the side winnerSide");
  assert.equal(rows[4].side, 1, "r/pool names it outcome");
  assert.equal(rows[2].amount, (500_000n * 10n ** 12n).toString());
});

test("touched markets carry the pool stakers to re-read", () => {
  const t = touchedMarkets(eventRows(blocks, GNO));
  assert.deepEqual([...t.keys()].sort(), ["pool:4", "vs:3"]);
  assert.deepEqual([...t.get("pool:4")!.users], [alice]);
});
