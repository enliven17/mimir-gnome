import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getFunctionName } from "convex/server";

import { GNO } from "../../lib/gno/config";
import { callIdFor } from "../../lib/gno/payments";

/** Real public route, backend payment checks and claim/retry ledger; only the RPC and config boundaries are fixtures. */
test("paid API calls redeem an r/agentpay payment once, only with its private secret", async (t) => {
  const root = resolve(import.meta.dirname, "../..");
  const temp = await mkdtemp(join(tmpdir(), "mimir-paid-api-"));
  const agent = "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5";
  const payer = "g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz";
  const secret = "5e".repeat(32);
  const tx = "ab".repeat(32);
  const paid = (over: Record<string, string> = {}, pkgPath = GNO.realms.agentpay) => ({
    type: "Paid", pkgPath, attrs: { callId: callIdFor(secret), agent, payer, amount: "50000", ...over },
  });
  const f: any = {
    enabled: true,
    agent: { name: "Fixture", ticker: "FIX", thesis: "fixture", uid: "", id: null, gno: agent, brain: { kind: "mimir" }, recent: [] },
    events: [paid()], ok: true, reads: 0, blockTime: () => Math.floor(Date.now() / 1000), failedAnswer: false,
  };
  f.router = { completeJson: async () => { if (f.failedAnswer) throw Error("unavailable"); return { data: "fixture answer" }; } };
  const globals = globalThis as typeof globalThis & { __mimirPaidApi?: any };
  const previous = globals.__mimirPaidApi;
  globals.__mimirPaidApi = f;
  const remotes: Record<string, string> = {
    "lib/chains/registry": `const f=globalThis.__mimirPaidApi;const gno=${JSON.stringify({ id: "gno", name: "gno.land test", chainId: GNO.chainId, network: "testnet", realms: GNO.realms, gno: GNO })};export const MARKET_CHAINS={chains:{get gno(){return {...gno,enabled:f.enabled};}}};export const serverMarketChains=()=>MARKET_CHAINS;`,
    "lib/gno/tx": `const f=globalThis.__mimirPaidApi;export const normalizeTxHash=(v)=>/^(0x)?[0-9a-fA-F]{64}$/.test(v)?v.replace(/^0x/,"").toLowerCase():null;export const gnoTx=async(h)=>{f.reads++;return {hash:h,height:7,index:0,ok:f.ok,error:f.ok?null:"failed",events:f.ok?f.events:[]};};export const gnoBlock=async(h)=>({height:h,time:f.blockTime(),txs:[]});`,
    "lib/launch/request": "const f=globalThis.__mimirPaidApi;export const launchCx=()=>({secret:'internal',client:{query:async()=>f.agent,action:async(_,a)=>f.backend(f.ctx,a)}});",
    "lib/server/rate-limit": "export const allowRequest=async()=>true;export const clientIp=()=> 'fixture';",
    "lib/internal-secrets": "export const secretMatches=(_,s)=>s==='internal';",
    "lib/launch/byok": "export const byokRouter=()=>globalThis.__mimirPaidApi.router;",
    "lib/launch/llm": "export const platformRouter=globalThis.__mimirPaidApi.router;",
    "convex/marketDeploymentGuard": "export const assertMarketDeployment=async()=>{};",
  };
  try {
    const out = join(temp, "api.mjs");
    await build({ stdin: { contents: `export {GET,POST} from './app/api/launch/[id]/call/route';export {call} from './convex/agentApi';export {claim,release,done} from './convex/agentApiDb';export {memoryBackend} from './tests/helpers/convex-memory';`, resolveDir: root, loader: "ts" }, outfile: out, bundle: true, platform: "node", format: "esm", tsconfig: join(root, "tsconfig.json"), plugins: [{ name: "remote-boundaries", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        const key = a.path.startsWith("@/") ? a.path.slice(2) : resolve(a.resolveDir, a.path).slice(root.length + 1).replaceAll("\\", "/");
        if (key in remotes) return { path: key, namespace: "fixture" };
      });
      b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({ contents: remotes[a.path], loader: "js", resolveDir: root }));
    } }] });
    const m = await import(pathToFileURL(out).href);
    const ledger = m.memoryBackend();
    f.ctx = { runQuery: async () => f.agent, runMutation: async (ref: any, a: any) => {
      const name = getFunctionName(ref).split(":")[1];
      assert.ok(["claim", "done", "release"].includes(name));
      return ledger.run(m[name], a);
    } };
    f.backend = m.call._handler;
    const params = { params: Promise.resolve({ id: "fixture" }) };
    const backend = (over = {}) => f.backend(f.ctx, { secret: "internal", slug: "fixture", prompt: "hello", chain: "gno", tx, callSecret: secret, ...over });
    const post = (header: string) => m.POST(new Request("https://example.invalid", { method: "POST", body: JSON.stringify({ prompt: "hello" }), headers: { "x-mimir-payment": header } }), params);

    await t.test("the quote names r/agentpay, the agent's account and a fresh private commitment", async () => {
      const q = await (await m.GET(new Request("https://example.invalid"), params)).json();
      assert.equal(q.accepts.length, 1);
      const [o] = q.accepts;
      assert.deepEqual([o.chain, o.asset, o.units, o.payTo, o.agent], ["gno", "mUSD", "50000", GNO.realms.agentpay, agent]);
      assert.equal(callIdFor(o.secret), o.callId);
      const again = await (await m.GET(new Request("https://example.invalid"), params)).json();
      assert.notEqual(again.accepts[0].secret, o.secret);
    });
    await t.test("a public hash alone, or a missing secret, never reaches redemption", async () => {
      assert.equal((await post(`gno:${tx}`)).status, 402);
      assert.equal((await post(`arc:0x${tx}:0x${secret}`)).status, 402);
      assert.equal((await backend({ callSecret: undefined })).status, 400);
      assert.equal(f.reads, 0);
    });
    await t.test("wrong secret, look-alike realms, another agent, short amounts and old or failed txs do not redeem", async () => {
      assert.equal((await backend({ callSecret: "77".repeat(32) })).status, 402);
      for (const events of [[paid({}, "gno.land/r/evil/agentpay")], [paid({ agent: payer })], [paid({ amount: "100" })], []]) {
        f.events = events;
        assert.equal((await backend()).status, 402);
      }
      f.events = [paid()];
      f.ok = false;
      assert.equal((await backend()).status, 402);
      f.ok = true;
      f.blockTime = () => Math.floor(Date.now() / 1000) - 2 * 3600;
      assert.match((await backend()).error, /older than an hour/);
      f.blockTime = () => Math.floor(Date.now() / 1000);
      assert.deepEqual(await ledger.db.query("agentApiPayments").collect(), []);
    });
    await t.test("a good payment redeems once, whatever the hash's case or 0x prefix", async () => {
      const r = await post(`gno:0x${tx.toUpperCase()}:${secret.toUpperCase()}`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.answer, "fixture answer");
      assert.deepEqual(body.paid, { chain: "gno", tx });
      assert.equal((await backend()).status, 409);
      assert.equal((await ledger.db.query("agentApiPayments").collect())[0].key, `gno:${tx}`);
    });
    await t.test("a failed answer releases its payment for a legitimate retry", async () => {
      const another = "bc".repeat(32);
      f.failedAnswer = true;
      assert.equal((await backend({ tx: another })).status, 502);
      f.failedAnswer = false;
      assert.equal((await backend({ tx: another })).ok, true);
      assert.equal((await backend({ tx: another })).status, 409);
    });
    await t.test("a disabled chain offers nothing and redeems nothing", async () => {
      f.enabled = false;
      assert.deepEqual((await (await m.GET(new Request("https://example.invalid"), params)).json()).accepts, []);
      assert.equal((await backend({ tx: "cd".repeat(32) })).status, 503);
      f.enabled = true;
    });
  } finally {
    globals.__mimirPaidApi = previous;
    await rm(temp, { recursive: true, force: true });
  }
});
