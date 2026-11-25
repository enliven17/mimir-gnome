import test from "node:test";
import assert from "node:assert/strict";
import { testAccount } from "../helpers/gno-sign";

import { agentRequestMessage, operatorProofMessage, type AgentEnvelope } from "../../lib/agents/api";
import { normalizeWallet, verifyWalletSignature } from "../../lib/agents/signature";
import { parseWriteParams, stakeOf, usdcToUnits } from "../../lib/agents/params";
import { AgentEnvelopeError } from "../../lib/agents/api";

const NOW_SEC = 1_700_000_000;

function envelope(over: Partial<AgentEnvelope> = {}): AgentEnvelope {
  return {
    version: "v1",
    agentId: "my-agent",
    action: "heartbeat",
    nonce: "n-1",
    signedAt: 1_700_000_000_000,
    body: { status: "ok" },
    ...over,
  };
}

test("an ADR-036 SignArbitrary proof over the envelope message round-trips", async () => {
  const acct = await testAccount();
  const message = agentRequestMessage(envelope());
  assert.ok(message.startsWith("Mimir Agent API request\n"));
  const signature = await acct.sign(message);
  assert.equal(await verifyWalletSignature({ address: acct.address, message, signature }), true);
});

test("the operator proof names the agent and the operator", async () => {
  const acct = await testAccount();
  const message = operatorProofMessage("my-agent", acct.address);
  assert.equal(message, `Mimir agent operator proof\nagent: my-agent\noperator: ${acct.address}`);
  assert.equal(await verifyWalletSignature({ address: acct.address, message, signature: await acct.sign(message) }), true);
});

test("a signature does not verify for another key or a tampered body", async () => {
  const acct = await testAccount();
  const other = await testAccount();
  const env = envelope();
  const signature = await acct.sign(agentRequestMessage(env));
  assert.equal(await verifyWalletSignature({ address: other.address, message: agentRequestMessage(env), signature }), false);
  const tampered = agentRequestMessage({ ...env, body: { status: "evil" } });
  assert.equal(await verifyWalletSignature({ address: acct.address, message: tampered, signature }), false);
});

test("only gno.land addresses own or operate an agent", () => {
  const g1 = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
  assert.equal(normalizeWallet(g1.toUpperCase()), g1);
  assert.equal(normalizeWallet("0x1111111111111111111111111111111111111111"), null, "an EVM address is refused");
  assert.equal(normalizeWallet("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), null, "a base58 key is refused");
  assert.equal(normalizeWallet(42), null);
});

test("write params are validated before anything touches the chain", () => {
  const ok = parseWriteParams(
    "createClaim",
    {
      question: "Will ETH close above $4000 on Friday?",
      creatorPosition: "Yes",
      counterPosition: "No",
      resolutionUrl: "https://www.coingecko.com/en/coins/ethereum",
      category: "crypto",
      stakeUsdc: 2.5,
      deadline: NOW_SEC + 86_400,
    },
    NOW_SEC,
  );
  assert.equal(ok.action, "createClaim");
  assert.equal(stakeOf(ok), 2_500_000n);

  const cases: Array<[Parameters<typeof parseWriteParams>[0], Record<string, unknown>]> = [
    ["challenge", { claimId: 0, stakeUsdc: 2 }],
    ["challenge", { claimId: 1, stakeUsdc: 0.05 }],
    ["challenge", { claimId: "1e3", stakeUsdc: 2 }],
    ["withdraw", {}],
    ["withdraw", { claimId: -1 }],
    ["createClaim", { question: "x", creatorPosition: "a", counterPosition: "b", resolutionUrl: "http://a.b", stakeUsdc: 2, deadline: NOW_SEC + 86_400 }],
    ["createClaim", { question: "x".repeat(201), creatorPosition: "a", counterPosition: "b", resolutionUrl: "https://a.b", stakeUsdc: 2, deadline: NOW_SEC + 86_400 }],
    ["createClaim", { question: "x", creatorPosition: "a", counterPosition: "b", resolutionUrl: "https://a.b", stakeUsdc: 2, deadline: NOW_SEC + 60 }],
  ];
  for (const [action, body] of cases) {
    assert.throws(
      () => parseWriteParams(action, body, NOW_SEC),
      (err: unknown) => err instanceof AgentEnvelopeError && err.reason === "bad_params",
      JSON.stringify(body),
    );
  }
});

test("usdc amounts convert to exact base units", () => {
  assert.equal(usdcToUnits(2, "x"), 2_000_000n);
  assert.equal(usdcToUnits(0.000001, "x"), 1n);
  assert.equal(usdcToUnits(12.345678, "x"), 12_345_678n);
});
