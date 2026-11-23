import assert from "node:assert/strict";
import test from "node:test";

import { indexToDecimal6, floorToChain, SubUnitAmountError, toChainUnits, toIndexUnits, unitScale, usdToIndex } from "../../lib/chains/amounts";
import { chainOfRow, explorerUrl, isMarketChainId, MARKET_CHAINS, marketContract, marketRealmUrl, MIN_STAKE_WEI, serverMarketChains } from "../../lib/chains/registry";
import { budgetDay, councilWallets, fitsBudget, houseAddresses, houseCreatorWallet, oracleKey, oracleKeyWarnings } from "../../lib/chains/house";
import { marketPath, marketRef } from "../../lib/chains/links";
import { DEFAULT_NAMESPACE } from "../../lib/gno/config";

const G = (c: string) => `g1${c.repeat(38)}`;
const WORDS = "abandon ".repeat(11) + "about";

test("registry: one gno.land chain, enabled, mUSD at 6 dp and GNOT for gas", () => {
  const gno = MARKET_CHAINS.chains.gno;
  assert.deepEqual(MARKET_CHAINS.enabled, ["gno"]);
  assert.equal(MARKET_CHAINS.defaultChain, "gno");
  assert.equal(gno.token.symbol, "mUSD");
  assert.equal(gno.token.decimals, 6);
  assert.equal(gno.gas.symbol, "GNOT");
  assert.equal(gno.minStakeWei, MIN_STAKE_WEI);
  assert.equal(marketContract(gno, "pool"), `gno.land/r/${DEFAULT_NAMESPACE}/pool`);
  assert.equal(marketContract(gno, "vs"), `gno.land/r/${DEFAULT_NAMESPACE}/vs`);
  assert.equal(isMarketChainId("gno"), true);
  assert.equal(isMarketChainId("base"), false);
  assert.equal(chainOfRow({ chain: null }), "gno");
});

test("registry: the backend reads GNO_* first, then the public names", () => {
  const r = serverMarketChains({ GNO_CHAIN_ID: "test-9", NEXT_PUBLIC_GNO_RPC_URL: "https://rpc.example", GNO_NAMESPACE: G("q") });
  const gno = r.chains.gno;
  assert.equal(gno.chainId, "test-9");
  assert.equal(gno.rpcUrl, "https://rpc.example");
  assert.equal(gno.realms.pool, `gno.land/r/${G("q")}/pool`);
  assert.equal(gno.network, "testnet");
  assert.equal(serverMarketChains({ GNO_CHAIN_ID: "gnoland-1" }).chains.gno.network, "mainnet");
});

test("registry: gnoweb links for transactions, accounts and markets", () => {
  const gno = serverMarketChains({ GNOWEB_URL: "https://gno.example" }).chains.gno;
  assert.equal(explorerUrl(gno, "tx", "abc="), "https://gno.example/tx/abc%3D");
  assert.equal(explorerUrl(gno, "address", G("q")), `https://gno.example/r/${DEFAULT_NAMESPACE}/musd:balance/${G("q")}`);
  assert.equal(marketRealmUrl(gno, "pool", 3), `https://gno.example/r/${DEFAULT_NAMESPACE}/pool:3`);
});

test("amounts: mUSD scales by 1e12 both ways, exactly; dust is refused or floored on purpose", () => {
  const musd = { token: { decimals: 6 as const } };
  assert.equal(unitScale(musd), 1_000_000_000_000n);
  assert.equal(toIndexUnits(musd, 2_500_000n), 2_500_000_000_000_000_000n);
  assert.equal(toChainUnits(musd, 2_500_000_000_000_000_000n), 2_500_000n);
  assert.throws(() => toChainUnits(musd, 2_500_000_000_000_000_001n), SubUnitAmountError);
  assert.equal(floorToChain(musd, 2_500_000_999_999_999_999n), 2_500_000_000_000_000_000n);
  assert.equal(usdToIndex(0.1), 100_000_000_000_000_000n);
  assert.equal(usdToIndex(-1), 0n);
  assert.equal(indexToDecimal6(2_500_000_000_000_000_000n), "2.5");
  assert.equal(indexToDecimal6(3_000_000_000_000_000_000n), "3");
});

test("house accounts and the oracle mnemonic", () => {
  const env = {
    GNO_CREATOR_ADDRESS: ` ${G("q")} `,
    GNO_COUNCIL_WALLETS: JSON.stringify({ socrates: G("p"), broken: "0x12" }),
    ORACLE_MNEMONIC: `  ${WORDS.replace(/ /g, "  ")} `,
  };
  assert.equal(houseCreatorWallet(env)?.address, G("q"));
  assert.deepEqual(councilWallets(env), { socrates: { address: G("p") } });
  assert.deepEqual(houseAddresses(env).sort(), [G("p"), G("q")].sort());
  assert.equal(houseCreatorWallet({ GNO_CREATOR_ADDRESS: "0x0000000000000000000000000000000000000001" }), null);
  assert.equal(oracleKey(env), WORDS);
  assert.equal(oracleKey({ ORACLE_MNEMONIC: "too short" }), null);
  assert.deepEqual(oracleKeyWarnings(env), []);
  assert.match(oracleKeyWarnings({ ORACLE_KEY: `0x${"1".repeat(64)}` }).join(), /no longer read/);
  assert.match(oracleKeyWarnings({ ORACLE_MNEMONIC: "nope" }).join(), /mnemonic/);
});

test("links: /arena/gno/<kind>/<id>", () => {
  assert.equal(marketPath("gno", "pool", 3), "/arena/gno/pool/3");
  assert.equal(marketPath(undefined, "vs", 7), "/arena/gno/vs/7");
  assert.equal(marketRef("gno", "vs", 7), "vs-7");
  assert.equal(marketRef("gno", "pool", 3), "pool-3");
});

test("one house budget per UTC day", () => {
  const USD = 1_000_000_000_000_000_000n;
  assert.equal(fitsBudget(USD, 0n, MIN_STAKE_WEI), true);
  assert.equal(fitsBudget(USD, USD - MIN_STAKE_WEI, MIN_STAKE_WEI), true);
  assert.equal(fitsBudget(USD, USD - MIN_STAKE_WEI + 1n, MIN_STAKE_WEI), false);
  assert.equal(fitsBudget(USD, 0n, 0n), false);
  assert.equal(budgetDay(Date.UTC(2026, 10, 1, 23, 59)), "2026-11-01");
});
