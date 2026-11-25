import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { GNO } from "../../lib/gno/config";
import { parseTxResult } from "../../lib/gno/tx";
import { testAccount } from "../helpers/gno-sign";

import { create, CreateBody } from "../../lib/launch/flow";
import { openKey } from "../../lib/launch/byok";
import { isFreshLaunchSig, launchMessage } from "../../lib/launch/auth";
import { verifyWalletSignature } from "../../lib/agents/signature";
import { adminFromRender, GRC20_FACTORY, newTokenMessage } from "../../lib/launch/token-factory";
import { prepareTokenLaunch, recordTokenLaunch, TokenPrepareBody, verifyTokenLaunch, type TokenDeps } from "../../lib/launch/token";
import { launchWalletScope, newSealedWallet, openMnemonic } from "../../lib/server/gno-wallets";
import { addressFromMnemonic } from "../../lib/gno/keys";

process.env.LAUNCH_BYOK_SECRET = "x".repeat(40);
process.env.GNO_WALLET_SECRET = "w".repeat(40);
const OWNER = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
const STRANGER = "g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz";

/** A Convex client that answers the launch functions from one in-memory agent. */
function fakeCx() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let agent: Record<string, any> | null = null;
  const handlers: Record<string, (a: any) => unknown> = {
    "launch:create": (a) => {
      const { secret: _s, ...rest } = a;
      agent = { ...rest, status: "live" };
      return { ok: true, slug: a.slug };
    },
    "launch:forOwner": () => agent && { owner: agent.owner, name: agent.name, ticker: agent.ticker, avatarSeed: agent.avatarSeed, status: agent.status, uid: agent.uid, gno: agent.gno, token: agent.token ?? null },
    "launch:recordToken": (a) => {
      if (agent!.token) return agent!.token.address === a.token.address ? "ok" : "has-token";
      agent!.token = a.token;
      return "ok";
    },
  };
  const run = async (f: any, a: any) => {
    const name = getFunctionName(f);
    calls.push([name, a]);
    return handlers[name](a);
  };
  return { cx: { client: { mutation: run, query: run } as any, secret: "s".repeat(20) }, calls, agent: () => agent };
}

const body = (over: Record<string, unknown> = {}) => CreateBody.parse({
  name: "Njord", ticker: "NJORD", thesis: "Back the favourite.",
  brain: { kind: "mimir" }, markets: { enabled: true }, ...over,
});
const wallets = { gno: (uid: string) => newSealedWallet(launchWalletScope(uid)) };

test("create: free and live at once, with its own sealed gno.land account bound to its uid; no funding step", async () => {
  const f = fakeCx();
  const r = await create(f.cx, { wallets, checkKey: async () => "ok" as const }, OWNER, body());
  assert.ok(r.ok);
  const a = f.agent()!;
  assert.deepEqual(r, { ok: true, id: "njord", gno: a.gno.address });
  assert.match(a.gno.address, /^g1/);
  assert.equal(a.status, "live");
  assert.deepEqual([a.brain.kind, a.markets.enabled, a.markets.rules.chains], ["mimir", true, ["gno"]]);
  assert.equal(a.markets.rules.minEdge, 0.08);
  // The sealed key opens only under the agent's uid, and it is the account's key.
  assert.equal(addressFromMnemonic(openMnemonic(launchWalletScope(a.uid), a.gno)), a.gno.address);
  assert.throws(() => openMnemonic(launchWalletScope("njord"), a.gno));
  assert.ok(!JSON.stringify(a).match(/\b(abandon|zoo)\b/), "no plain mnemonic is stored");
  assert.deepEqual(f.calls.map(([n]) => n), ["launch:create"], "one write, nothing to fund or verify");
  for (const k of ["fundLamports", "trading", "solana", "launch", "allocation", "venue", "arc", "base"]) assert.ok(!(k in a), k);
});

test("create: a wallet that cannot be made stores nothing", async () => {
  const f = fakeCx();
  const r = await create(f.cx, { wallets: { gno: () => { throw new Error("GNO_WALLET_SECRET is not set"); } }, checkKey: async () => "ok" }, OWNER, body());
  assert.equal(r.ok, false);
  assert.deepEqual(f.calls, []);
});

test("create: a BYOK key is checked, then sealed to the agent's uid; a dead key makes no wallet", async () => {
  let made = 0;
  const w = { gno: (uid: string) => (made++, newSealedWallet(launchWalletScope(uid))) };
  const byok = { brain: { kind: "byok", provider: "openai", apiKey: "sk-test-1234567890abcdef" } }; // gitleaks:allow -- deterministic test fixture
  const bad = await create(fakeCx().cx, { wallets: w, checkKey: async () => "bad-key" as const }, OWNER, body(byok));
  assert.equal(bad.ok, false);
  assert.equal(made, 0);
  const f = fakeCx();
  assert.ok((await create(f.cx, { wallets: w, checkKey: async () => "ok" as const }, OWNER, body(byok))).ok);
  const a = f.agent()!;
  assert.equal(a.brain.last4, "cdef");
  assert.ok(!JSON.stringify(a).includes("sk-test"));
  assert.equal(openKey(a.uid, a.brain), "sk-test-1234567890abcdef");
});

test("body: nothing turned on is refused; old token, funding and EVM chain fields are ignored or refused", () => {
  assert.equal(CreateBody.safeParse({ ...body(), markets: { enabled: false } }).success, false);
  const parsed = CreateBody.parse({ ...body(), seedSol: 1, chain: "solana", trading: { enabled: true } });
  assert.ok(!("seedSol" in parsed) && !("chain" in parsed) && !("trading" in parsed));
  assert.equal(CreateBody.safeParse({ ...body(), markets: { enabled: true, chains: ["base", "arc"] } }).success, false);
});

test("create: a council persona's ticker is refused before anything is made", async () => {
  let made = 0;
  const r = await create(fakeCx().cx, { wallets: { gno: (uid) => (made++, newSealedWallet(uid)) }, checkKey: async () => "ok" as const }, OWNER, body({ ticker: "SOCRATES" }));
  assert.equal(r.ok, false);
  assert.equal(made, 0);
});

test("auth: the signed message binds action, agent and body; stale signatures are refused", async () => {
  const acct = await testAccount();
  const m = { action: "token" as const, owner: acct.address, agent: "njord", bodySha256: "ab", signedAt: Date.now() };
  const signature = await acct.sign(launchMessage(m), GNO.chainId);
  assert.ok(await verifyWalletSignature({ address: acct.address, message: launchMessage(m), signature }));
  assert.ok(!(await verifyWalletSignature({ address: acct.address, message: launchMessage({ ...m, agent: "odin" }), signature })));
  assert.ok(!(await verifyWalletSignature({ address: acct.address, message: launchMessage({ ...m, action: "status" }), signature })));
  assert.ok(!isFreshLaunchSig(Date.now() - 6 * 60_000));
});

// ───────────────────────────── the owner's token launch (GRC20 factory)

const TX = "ab".repeat(32);
const launchTx = (symbol = "NJORD", pkg = GRC20_FACTORY, error: unknown = null) =>
  parseTxResult({
    hash: TX,
    height: "12",
    tx_result: { ResponseBase: { Error: error, Events: [{ type: "NewToken", pkg_path: pkg, attrs: [{ key: "token", value: `${pkg}.${symbol}.1` }, { key: "name", value: "Njord" }, { key: "symbol", value: symbol }, { key: "decimals", value: "6" }] }] } },
  });
const deps = (o: { tx?: ReturnType<typeof launchTx> | null; admin?: string | null; taken?: boolean } = {}): TokenDeps => ({
  chainId: GNO.chainId,
  symbolTaken: async () => o.taken ?? false,
  tx: async () => (o.tx === undefined ? launchTx() : o.tx),
  admin: async () => (o.admin === undefined ? OWNER : o.admin),
});

test("the factory's page names the token's admin", () => {
  assert.equal(adminFromRender(`# Njord ($NJORD)\n\n* **Decimals**: 6\n- **Admin**: ${OWNER.toUpperCase()}`), OWNER);
  assert.equal(adminFromRender("# nothing"), null);
});

test("verify: a factory NewToken for the agent's ticker, administered by the owner, is the agent's token", async () => {
  const ok = await verifyTokenLaunch(deps(), { tx: TX, owner: OWNER, ticker: "NJORD" });
  assert.deepEqual(ok, { ok: true, token: { chain: "gno", address: `${GRC20_FACTORY}:NJORD`, symbol: "NJORD" } });
  const v = (d: TokenDeps) => verifyTokenLaunch(d, { tx: TX, owner: OWNER, ticker: "NJORD" });
  assert.equal((await v(deps({ tx: null }))).ok, false, "not committed yet");
  assert.equal((await v(deps({ tx: launchTx("NJORD", GRC20_FACTORY, { "@type": "/std.InternalError" }) }))).ok, false, "failed");
  assert.equal((await v(deps({ tx: launchTx("ODIN") }))).ok, false, "another ticker");
  assert.equal((await v(deps({ tx: launchTx("NJORD", "gno.land/r/evil/grc20factory") }))).ok, false, "a look-alike factory");
  assert.equal((await v(deps({ admin: STRANGER }))).ok, false, "someone else is admin");
});

test("record: only the owner, verified on chain, once; the same token again is fine", async () => {
  const f = fakeCx();
  await create(f.cx, { wallets, checkKey: async () => "ok" as const }, OWNER, body());
  assert.equal((await recordTokenLaunch(f.cx, deps(), STRANGER, "njord", { chain: "gno", tx: TX })).ok, false);
  const r = await recordTokenLaunch(f.cx, deps(), OWNER, "njord", { chain: "gno", tx: `0x${TX.toUpperCase()}` });
  assert.ok(r.ok);
  assert.deepEqual(f.agent()!.token, { chain: "gno", address: `${GRC20_FACTORY}:NJORD`, symbol: "NJORD", launchTx: TX });
  assert.ok((await recordTokenLaunch(f.cx, deps(), OWNER, "njord", { chain: "gno", tx: TX })).ok);
});

test("prepare: the owner's one MsgCall to the factory, refused for a taken ticker or a stranger", async () => {
  assert.ok(TokenPrepareBody.safeParse({}).success);
  assert.equal(TokenPrepareBody.safeParse({ chain: "base" }).success, false);
  const f = fakeCx();
  await create(f.cx, { wallets, checkKey: async () => "ok" as const }, OWNER, body());
  const r = await prepareTokenLaunch(f.cx, deps(), OWNER, "njord");
  assert.ok(r.ok);
  assert.deepEqual(r.ok && [r.chain, r.chainId, r.messages], ["gno", GNO.chainId, [newTokenMessage(OWNER, "Njord", "NJORD")]]);
  assert.deepEqual(newTokenMessage(OWNER, "Njord", "NJORD").value, { caller: OWNER, send: "", max_deposit: "", pkg_path: GRC20_FACTORY, func: "New", args: ["Njord", "NJORD", "6", "0", "0"] });
  assert.equal((await prepareTokenLaunch(f.cx, deps({ taken: true }), OWNER, "njord")).ok, false);
  assert.equal((await prepareTokenLaunch(f.cx, deps(), STRANGER, "njord")).ok, false);
});
