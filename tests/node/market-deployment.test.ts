import assert from "node:assert/strict";
import test from "node:test";
import { assertSameDeployment, marketDeployment } from "../../lib/chains/deployment";
import { serverMarketChains } from "../../lib/chains/registry";

const onyx = marketDeployment(serverMarketChains({}).chains.gno);

test("deployment binding refuses unbound reads and writes", () => {
  assert.throws(() => assertSameDeployment(null, onyx), /not bound/);
});

test("testnet and mainnet cannot share a market index, even under the same namespace", () => {
  const mainnet = marketDeployment(serverMarketChains({ GNO_CHAIN_ID: "gnoland-1" }).chains.gno);
  assert.throws(() => assertSameDeployment(onyx, mainnet), /deployment mismatch/);
  assert.throws(() => assertSameDeployment(mainnet, onyx), /deployment mismatch/);
});

test("changing a realm path or the chain cannot silently reuse market IDs", () => {
  for (const field of ["vs", "pool", "fees", "musd", "chainId", "network"] as const) {
    assert.throws(() => assertSameDeployment(onyx, { ...onyx, [field]: "changed" }), /deployment mismatch/);
  }
  const moved = marketDeployment(serverMarketChains({ GNO_NAMESPACE: `g1${"q".repeat(38)}` }).chains.gno);
  assert.throws(() => assertSameDeployment(onyx, moved), /deployment mismatch/);
  assert.doesNotThrow(() => assertSameDeployment({ ...onyx }, onyx));
});
