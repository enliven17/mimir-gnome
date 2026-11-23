import assert from "node:assert/strict";
import test from "node:test";

import { GNO } from "../../lib/gno/config";
import { normalizeOwner, verifyOwnerSignature } from "../../lib/owner";
import { provenWallet } from "../../lib/server/wallet-proof";
import { formatProofHeader, parseProofHeader, WALLET_HEADER, WALLET_PROOF_HEADER, walletProofMessage } from "../../lib/wallet-proof";
import { testAccount } from "../helpers/gno-sign";

const G = `g1${"q".repeat(38)}`;

test("owner: a lowercase g1 address or null; EVM and Solana keys are not owners", () => {
  assert.equal(normalizeOwner(` ${G.toUpperCase().replace("G1", "g1")} `), G);
  assert.equal(normalizeOwner("0xb05F25Bc2eb9E1f7ad3F2371Eed2DE149Bd26a40"), null);
  assert.equal(normalizeOwner("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), null);
  assert.equal(normalizeOwner("g1short"), null);
  assert.equal(normalizeOwner(42), null);
});

test("verifyOwnerSignature: Adena's SignArbitrary proof passes for its signer, message and chain only", async () => {
  const me = await testAccount();
  const other = await testAccount();
  const message = "Mimir test\nnonce: 1";
  const sig = await me.sign(message, GNO.chainId);
  assert.equal(await verifyOwnerSignature({ address: me.address, message, signature: sig }), true);
  assert.equal(await verifyOwnerSignature({ address: me.address.toUpperCase().replace("G1", "g1"), message, signature: sig }), true);
  // Another account's address, another message, another chain, another account's key, junk.
  assert.equal(await verifyOwnerSignature({ address: other.address, message, signature: sig }), false);
  assert.equal(await verifyOwnerSignature({ address: me.address, message: `${message}!`, signature: sig }), false);
  assert.equal(await verifyOwnerSignature({ address: me.address, message, signature: await me.sign(message, "other-1") }), false);
  assert.equal(await verifyOwnerSignature({ address: me.address, message, signature: await other.sign(message, GNO.chainId, me.address) }), false);
  assert.equal(await verifyOwnerSignature({ address: me.address, message, signature: `0x${"ab".repeat(65)}` }), false);
  assert.equal(await verifyOwnerSignature({ address: me.address, message, signature: "{}" }), false);
});

test("provenWallet: a SignArbitrary proof header proves the address; a forged, stale or malformed one does not", async () => {
  const me = await testAccount();
  const other = await testAccount();
  const signedAt = Date.now();
  const proof = await me.sign(walletProofMessage(me.address, signedAt), GNO.chainId);
  const header = formatProofHeader(signedAt, proof);
  assert.match(header, /^\d+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseProofHeader(header), { signedAt, signature: proof });
  const req = (wallet: string, value: string) => new Request("http://x/api/follows", { headers: { [WALLET_HEADER]: wallet, [WALLET_PROOF_HEADER]: value } });
  assert.equal(await provenWallet(req(me.address, header)), me.address);
  assert.equal(parseProofHeader(`${signedAt - 25 * 3_600_000}.${header.split(".")[1]}`), null);
  assert.equal(parseProofHeader(`${signedAt}.${"3".repeat(88)}`), null);
  const forged = await other.sign(walletProofMessage(me.address, signedAt), GNO.chainId, me.address);
  assert.equal(await provenWallet(req(me.address, formatProofHeader(signedAt, forged))), null);
  assert.equal(await provenWallet(req(other.address, header)), null);
});
