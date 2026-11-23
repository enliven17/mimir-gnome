import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import { oracleRole, sameOracleAs } from "../../scripts/lib/oracle-role.mjs";

const KEY_A = `0x${"1".repeat(64)}` as const;
const KEY_B = `0x${"2".repeat(64)}` as const;
const ADDR_A = privateKeyToAccount(KEY_A).address;
const ADDR_B = privateKeyToAccount(KEY_B).address;

test("deploy scripts: the oracle role is ORACLE_KEY's address on every chain", () => {
  // From the key alone, for either chain's script.
  assert.equal(oracleRole({ ORACLE_KEY: KEY_A }, "BASE_ORACLE").address, ADDR_A);
  assert.equal(oracleRole({ ORACLE_KEY: KEY_A }, "ARC_ORACLE").address, ADDR_A);
  // The shared address, or the chain's own name for it, without the key on the deploy machine.
  assert.equal(oracleRole({ ORACLE_ADDRESS: ADDR_B.toLowerCase() }, "BASE_ORACLE").address, ADDR_B);
  assert.equal(oracleRole({ ARC_ORACLE: ADDR_B }, "ARC_ORACLE").address, ADDR_B);
  // A named address that is not the key's is refused: the chains would get different oracles.
  assert.throws(() => oracleRole({ ORACLE_KEY: KEY_A, BASE_ORACLE: ADDR_B }, "BASE_ORACLE"), /same address on every chain/);
  assert.equal(oracleRole({ ORACLE_KEY: KEY_A, BASE_ORACLE: ADDR_A }, "BASE_ORACLE").address, ADDR_A);
  assert.throws(() => oracleRole({}, "BASE_ORACLE"), /oracle is required/);
  assert.match(oracleRole({ ORACLE_KEY: KEY_A, BASE_ORACLE_KEY: KEY_B }, "BASE_ORACLE").warnings.join(), /ignored/);
});

test("deploy scripts: the other chain's deployed oracle must match (or be pending)", () => {
  assert.match(sameOracleAs(ADDR_A, { oracle: ADDR_A, pending: "0x0000000000000000000000000000000000000000" }, "Arc"), /same oracle/);
  assert.match(sameOracleAs(ADDR_A, { oracle: ADDR_B, pending: ADDR_A }, "Arc"), /pending/);
  assert.match(sameOracleAs(ADDR_A, null, "Arc"), /not checked/);
  assert.throws(() => sameOracleAs(ADDR_A, { oracle: ADDR_B, pending: ADDR_B }, "Base"), /one oracle key/);
});
