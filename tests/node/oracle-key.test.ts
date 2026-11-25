import assert from "node:assert/strict";
import test from "node:test";

import { auditAgentKey, councilMnemonics, councilWallets, creatorMnemonic, houseAddresses, houseCreatorWallet, houseKeyWarnings, oracleAddress, oracleKey, oracleKeyWarnings } from "../../lib/chains/house";

// gnodev's test1 account and another fixed mnemonic: their addresses are what gnokey derives.
const TEST1 = "source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast";
const TEST1_ADDR = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const OTHER = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("the oracle signs with ORACLE_MNEMONIC; its address is derived, EVM keys are flagged", () => {
  assert.equal(oracleKey({ ORACLE_MNEMONIC: `  ${TEST1.replace(/ /g, "  ")} ` }), TEST1);
  assert.equal(oracleAddress({ ORACLE_MNEMONIC: TEST1 }), TEST1_ADDR);
  assert.equal(oracleKey({ ORACLE_MNEMONIC: `0x${"1".repeat(64)}` }), null);
  assert.equal(oracleAddress({}), null);
  assert.match(oracleKeyWarnings({ ORACLE_KEY: `0x${"1".repeat(64)}` }).join(), /no longer read/);
  assert.match(oracleKeyWarnings({ ORACLE_MNEMONIC: "one two" }).join(), /not a 12 to 24 word mnemonic/);
  assert.deepEqual(oracleKeyWarnings({ ORACLE_MNEMONIC: TEST1 }), []);
});

test("house and council accounts: addresses from env or derived from their mnemonics, and they must agree", () => {
  const env = {
    GNO_CREATOR_MNEMONIC: TEST1,
    GNO_COUNCIL_MNEMONICS: JSON.stringify({ socrates: OTHER, bad: "nope" }),
    GNO_COUNCIL_WALLETS: JSON.stringify({ optimist: "g1lla0fveljx953zky47hpuu0zguzp5cassl28vh", junk: "0x12" }),
    AUDIT_AGENT_MNEMONIC: OTHER,
  };
  assert.equal(creatorMnemonic(env), TEST1);
  assert.deepEqual(houseCreatorWallet(env), { address: TEST1_ADDR });
  assert.deepEqual(Object.keys(councilMnemonics(env)), ["socrates"]);
  const council = councilWallets(env);
  assert.deepEqual(Object.keys(council).sort(), ["optimist", "socrates"]);
  assert.match(council.socrates.address, /^g1/);
  assert.equal(houseAddresses(env).length, 3);
  assert.equal(auditAgentKey(env), OTHER);
  assert.deepEqual(houseKeyWarnings(env), []);

  const mismatch = { GNO_CREATOR_MNEMONIC: TEST1, GNO_CREATOR_ADDRESS: council.socrates.address, GNO_COUNCIL_MNEMONICS: JSON.stringify({ socrates: OTHER }), GNO_COUNCIL_WALLETS: JSON.stringify({ socrates: TEST1_ADDR }), CIRCLE_API_KEY: "x" };
  const w = houseKeyWarnings(mismatch).join("\n");
  assert.match(w, /GNO_CREATOR_MNEMONIC does not derive GNO_CREATOR_ADDRESS/);
  assert.match(w, /GNO_COUNCIL_MNEMONICS.socrates does not derive/);
  assert.match(w, /CIRCLE_API_KEY is from the EVM deployment/);
  // The listed address wins for display; the warning says the key is wrong.
  assert.equal(houseCreatorWallet(mismatch)?.address, council.socrates.address);
});
