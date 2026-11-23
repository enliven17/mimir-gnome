import assert from "node:assert/strict";
import test from "node:test";

import { ADMIN_TTL_MS, adminWallet, adminWallets, issueAdminNonce, startAdminSession } from "../../lib/server/admin";
import { useMemoryStore } from "../../lib/server/store";
import { GNO } from "../../lib/gno/config";
import { testAccount, type TestAccount } from "../helpers/gno-sign";

useMemoryStore();

const newKey = () => testAccount();
const sign = (kp: TestAccount, message: string) => kp.sign(message, GNO.chainId);
const bearer = (token: string) => new Request("https://mimirmarkets.xyz/api/admin/overview", { headers: { authorization: `Bearer ${token}` } });

test("there is no built-in admin: only ADMIN_WALLETS", async () => {
  assert.deepEqual([...adminWallets({})], []);
  assert.deepEqual([...adminWallets({ ADMIN_WALLETS: "a, b" })], ["a", "b"]);
  // g1 entries are normalized to lowercase, so a differently cased one still matches.
  const w = (await newKey()).address;
  assert.deepEqual([...adminWallets({ ADMIN_WALLETS: w.toUpperCase().replace("G1", "g1") })], [w]);
});

test("a signed, fresh, same-domain challenge opens a 10-minute session", async () => {
  const admin = await newKey();
  const w = admin.address;
  const env = { ADMIN_WALLETS: w };
  const now = 1_000_000;
  const c = await issueAdminNonce(w, "mimirmarkets.xyz", now, env);
  assert.ok(c);
  const s = await startAdminSession({ wallet: w, nonce: c.nonce, signature: await sign(admin, c.message), origin: "https://mimirmarkets.xyz" }, now + 1000, env);
  assert.ok(s);
  assert.equal(await adminWallet(bearer(s.token), now + 2000, env), w);
  assert.equal(await adminWallet(bearer(s.token), now + 1000 + ADMIN_TTL_MS + 1, env), null, "the session expires");
  // Single use: the same signed challenge cannot open a second session.
  assert.equal(await startAdminSession({ wallet: w, nonce: c.nonce, signature: await sign(admin, c.message), origin: "https://mimirmarkets.xyz" }, now + 3000, env), null);
});

test("strangers, other domains, stale challenges and wrong signatures get nothing", async () => {
  const admin = await newKey();
  const w = admin.address;
  const env = { ADMIN_WALLETS: w };
  assert.equal(await issueAdminNonce((await newKey()).address, "mimirmarkets.xyz", 0, env), null);

  const fresh = async () => (await issueAdminNonce(w, "mimirmarkets.xyz", 0, env))!;
  let c = await fresh();
  assert.equal(await startAdminSession({ wallet: w, nonce: c.nonce, signature: await sign(admin, c.message), origin: "https://evil.example" }, 1, env), null, "other origin");
  c = await fresh();
  assert.equal(await startAdminSession({ wallet: w, nonce: c.nonce, signature: await sign(admin, c.message), origin: "https://mimirmarkets.xyz" }, ADMIN_TTL_MS + 1, env), null, "stale");
  c = await fresh();
  assert.equal(await startAdminSession({ wallet: w, nonce: c.nonce, signature: await sign(await newKey(), c.message), origin: "https://mimirmarkets.xyz" }, 1, env), null, "wrong key");
  assert.equal(await adminWallet(bearer("f".repeat(48)), 1, env), null, "unknown token");
  assert.equal(await adminWallet(new Request("https://x"), 1, env), null, "no token");
});

test("the overview route answers 404 without a session", async () => {
  process.env.ADMIN_WALLETS = (await newKey()).address;
  const { GET } = await import("../../app/api/admin/overview/route");
  for (const req of [new Request("http://x/api/admin/overview"), bearer("0".repeat(48))]) {
    const res = await GET(req);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  }
});
