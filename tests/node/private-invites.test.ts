import assert from "node:assert/strict";
import test from "node:test";

import { kindOfAction, pullOf, type MarketAction } from "../../lib/chains/calls";
import { parseInviteWallets, readClaimInvitation } from "../../lib/chains/invites";
import { MARKET_CHAINS } from "../../lib/chains/registry";
import { sendMarketAction } from "../../lib/chains/send";

const G = (c: string) => `g1${c.repeat(38)}`;
const alice = G("a");
const bob = G("p");
const creator = G("c");

test("wallet batches normalize case and duplicates, reject malformed/EVM/creator wallets and cap unique entries", () => {
  assert.deepEqual(parseInviteWallets(`${alice}, ${bob}\n${alice.toUpperCase().replace("G1", "g1")}`, creator), [alice, bob]);
  for (const text of ["", "alice.gno", "g1123", "0x00000000000000000000000000000000000000a1", creator]) assert.throws(() => parseInviteWallets(text, creator));
  const letters = "023456789acdefghjklmnpqrstuvwxyz";
  const many = Array.from({ length: 101 }, (_, i) => `g1${letters[i % 32]}${letters[Math.floor(i / 32)]}${"q".repeat(36)}`).join("\n");
  assert.throws(() => parseInviteWallets(many), /100/);
});

test("invitation reads ask the VS realm for the exact claim and wallet; an unreadable answer is an error", async () => {
  const real = globalThis.fetch;
  const queries: string[] = [];
  const reply = (data: string | null, error = false) => async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    queries.push(Buffer.from(body.params.data, "base64").toString("utf8"));
    const ResponseBase = error ? { Error: { msg: "x" }, Log: "package not found" } : { Data: data === null ? null : Buffer.from(data).toString("base64") };
    return new Response(JSON.stringify({ result: { response: { ResponseBase } } }));
  };
  try {
    globalThis.fetch = reply("(true bool)") as typeof fetch;
    assert.equal(await readClaimInvitation(7, alice), true);
    assert.equal(queries[0], `${MARKET_CHAINS.chains.gno.realms.vs}.Invited(7, "${alice}")`);
    globalThis.fetch = reply("(false bool)") as typeof fetch;
    assert.equal(await readClaimInvitation(7, alice), false);
    globalThis.fetch = reply(null, true) as typeof fetch;
    await assert.rejects(readClaimInvitation(7, alice), /package not found/);
    await assert.rejects(readClaimInvitation(0, alice), /Invalid/);
    await assert.rejects(readClaimInvitation(7, "0x00000000000000000000000000000000000000a1"), /Invalid/);
  } finally {
    globalThis.fetch = real;
  }
});

test("a grant goes to the VS realm, pulls nothing and needs no approve", async () => {
  const action: MarketAction = { type: "invite", marketId: 7, accounts: [alice, bob], allowed: true };
  assert.equal(kindOfAction(action), "vs");
  assert.equal(pullOf(action), 0n);
  let sent: string[][] = [];
  await sendMarketAction(MARKET_CHAINS.chains.gno, creator, action, {
    allowance: async () => assert.fail("no allowance read for a grant"),
    send: async (messages) => ((sent = messages.map((m) => [m.value.pkg_path, m.value.func, ...m.value.args])), { txHash: "h" }),
  });
  assert.deepEqual(sent, [[MARKET_CHAINS.chains.gno.realms.vs, "SetInvited", "7", `${alice},${bob}`, "true"]]);
});
