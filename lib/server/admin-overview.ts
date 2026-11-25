/**
 * Everything the admin panel shows, gathered on the server in one pass: the backend's own read (convex/arcAdmin.ts),
 * gno.land (the realms' roles, caps and mUSD holdings, balances, solvency), the app records in the backend, Telegram
 * and the RPC. Each probe is timed and fails on its own, so one dead service shows as red instead of blanking the
 * page. Read-only; no secret values leave this module, only whether they are set.
 */
import { internalSecret } from "@/lib/internal-secrets";
import { ConvexHttpClient } from "convex/browser";

import { api } from "@/convex/_generated/api";
import { gasBalanceUgnot, latestBlockHeight, musdBalanceWei } from "@/lib/chains/client";
import { MARKET_CHAINS } from "@/lib/chains/registry";
import { realmAddress } from "@/lib/gno/address";
import { fromMusdUnits } from "@/lib/gno/msgs";
import { poolConfig, vsConfig, type MarketConfig } from "@/lib/gno/reads";
import { qevalInts } from "@/lib/gno/rpc";
import { store, storeEnabled } from "@/lib/server/store";

export type Health = "ok" | "warn" | "down";
export interface Probe<T> {
  ok: boolean;
  ms: number;
  data?: T;
  error?: string;
}

const TIMEOUT_MS = 8_000;
/** Below this many mUSD an operating account is flagged; below LOW_GNOT GNOT it can barely pay gas. */
const LOW_USDC = 1;
const LOW_GNOT = 1;
const CHAIN = MARKET_CHAINS.chains.gno;
const G = CHAIN.gno;

async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
  const t0 = Date.now();
  try {
    const data = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), TIMEOUT_MS))]);
    return { ok: true, ms: Date.now() - t0, data };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

async function backend() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  const secret = internalSecret("admin");
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  if (!secret) throw new Error("MIMIR_ADMIN_SECRET is not set on the site");
  return new ConvexHttpClient(url).query(api.arcAdmin.overview, { secret });
}

type RealmConfig = MarketConfig & { lifetimeFeesAccrued?: number; lifetimeFeesClaimed?: number };

/** A market realm's roles, caps, fees and what it holds in mUSD (index units). */
async function realm(kind: "vs" | "pool") {
  const path = kind === "vs" ? G.realms.vs : G.realms.pool;
  const address = realmAddress(path);
  const [c, balance] = await Promise.all([(kind === "vs" ? vsConfig(G) : poolConfig(G)) as Promise<RealmConfig>, musdBalanceWei(address, G)]);
  const unclaimed = c.lifetimeFeesAccrued !== undefined && c.lifetimeFeesClaimed !== undefined ? fromMusdUnits(c.lifetimeFeesAccrued - c.lifetimeFeesClaimed) : null;
  return {
    address,
    path,
    balanceWei: balance.toString(),
    owner: c.owner,
    oracle: c.oracle,
    arbiter: c.arbiter,
    feeRecipient: c.feeRecipient,
    paused: c.paused,
    // Net mUSD, index units, "0" = no cap.
    maxMarketStakeWei: fromMusdUnits(c.maxMarketStake).toString(),
    maxAccountStakeWei: fromMusdUnits(c.maxAccountStake).toString(),
    unclaimedFeesWei: unclaimed?.toString() ?? null,
  };
}

async function balances(wallets: Array<{ label: string; address: string }>) {
  return Promise.all(
    wallets.map(async (w) => {
      const [wei, ugnot] = await Promise.all([musdBalanceWei(w.address, G).catch(() => null), gasBalanceUgnot(w.address, G).catch(() => null)]);
      const usdc = wei === null ? null : Number(wei) / 1e18;
      const gnot = ugnot === null ? null : Number(ugnot) / 1e6;
      return { ...w, usdc, gnot, low: (usdc !== null && usdc < LOW_USDC) || (gnot !== null && gnot < LOW_GNOT) };
    }),
  );
}

/** The app's records in the backend (lib/server/store.ts), counted. */
async function database() {
  if (!storeEnabled()) throw new Error("the backend is not configured (NEXT_PUBLIC_CONVEX_URL, MIMIR_STORE_SECRET)");
  type R = Record<string, unknown>;
  const s = store();
  const all = (t: string) => s.list<R>(t, { limit: 5000 });
  const [accounts, chats, agentRows, payments, basketCount, subs, perms] = await Promise.all([
    s.count("arc_accounts"),
    all("telegram_chats"),
    all("agent_registry"),
    all("agent_payments"),
    s.count("baskets"),
    all("basket_subscriptions"),
    all("copy_permissions"),
  ]);
  const groupBy = (rows: R[], f: string) => {
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r[f] ?? "none")] = (out[String(r[f] ?? "none")] ?? 0) + 1;
    return out;
  };
  const live = chats.filter((c) => !c.blocked);
  return {
    arcAccounts: accounts,
    telegram: live.length,
    telegramLinked: live.filter((c) => c.wallet != null).length,
    agents: groupBy(agentRows, "status"),
    // Agents with a gno operator set (the field name is the panel's).
    agentsArc: agentRows.filter((r) => r.gno_operator != null).length,
    agentPayments: { count: payments.length, wei: payments.reduce((n, p) => n + BigInt(String(p.amount_wei ?? "0")), 0n).toString() },
    baskets: basketCount,
    subscribers: new Set(subs.map((r) => r.follower)).size,
    copyFollowers: new Set(perms.filter((p) => p.active && p.revoked_at == null).map((p) => p.follower)).size,
  };
}

async function telegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const call = async (method: string) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { cache: "no-store" });
    const body = (await res.json()) as { ok: boolean; result?: Record<string, unknown>; description?: string };
    if (!body.ok) throw new Error(`${method}: ${body.description ?? res.status}`);
    return body.result ?? {};
  };
  const [me, hook] = await Promise.all([call("getMe"), call("getWebhookInfo")]);
  return {
    bot: `@${String(me.username ?? "")}`,
    webhook: String(hook.url ?? "") || null,
    pending: Number(hook.pending_update_count ?? 0),
    lastError: hook.last_error_message ? String(hook.last_error_message).slice(0, 200) : null,
  };
}

/** Which of the site's own secrets are set (yes/no), never their values. */
function siteKeys() {
  const names = [
    "MIMIR_STORE_SECRET", "MIMIR_EVENTS_SECRET", "MIMIR_ADMIN_SECRET", "MIMIR_INTERNAL_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET",
    "GNO_WALLET_SECRET", "LAUNCH_BYOK_SECRET",
    "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "CMC_API_KEY",
    "NEXT_PUBLIC_POSTHOG_KEY",
  ];
  return Object.fromEntries(names.map((n) => [n, Boolean(process.env[n]?.trim())]));
}

const minutes = (ms: number) => ms / 60_000;

export async function adminOverview() {
  const nowMs = Date.now();
  const [be, chainHead, v3, pool, db, tg, musd] = await Promise.all([
    probe(backend),
    probe(() => latestBlockHeight(G)),
    probe(() => realm("vs")),
    probe(() => realm("pool")),
    probe(database),
    probe(telegram),
    // mUSD's total supply: the token realm answers.
    probe(() => qevalInts(G.realms.musd, "TotalSupply()", G).then(([v]) => Number(v ?? 0n) / 1e6)),
  ]);

  const b = be.data;
  const wallets = b
    ? [
        ...(b.oracle.address ? [{ label: "Oracle", address: b.oracle.address }] : []),
        ...(b.house ? [{ label: "Market creator", address: b.house }] : []),
        ...b.council.wallets.map((w) => ({ label: `Council · ${w.slug}`, address: w.address })),
        ...(v3.data?.feeRecipient ? [{ label: "Fee recipient", address: v3.data.feeRecipient }] : []),
      ]
    : [];
  const walletBalances = await probe(() => balances(wallets));

  // Solvency: what the realm holds against what the index says it owes (stakes in play, unclaimed pool payouts,
  // dispute bonds) plus fees accrued but not withdrawn.
  const solvency = (c: Probe<Awaited<ReturnType<typeof realm>>>, owedWei: string | undefined) => {
    if (!c.data || owedWei === undefined) return null;
    const owed = BigInt(owedWei) + BigInt(c.data.unclaimedFeesWei ?? "0");
    const held = BigInt(c.data.balanceWei);
    return { heldWei: held.toString(), owedWei: owed.toString(), surplusWei: (held - owed).toString(), ok: held >= owed };
  };

  const lag = b?.cursorBlock != null && chainHead.data != null ? chainHead.data - b.cursorBlock : null;
  // Expected cadence per job (crons.ts); a heartbeat older than 3 periods is stale.
  const JOBS: Record<string, number> = { "gno-sync": 0.5, "gno-oracle": 2, "arc-council": 15, "arc-creator": 60 };
  const jobs = Object.entries(JOBS).map(([name, every]) => {
    const at = b?.heartbeats.find((h) => h.name === name)?.at ?? null;
    const ago = at ? minutes(nowMs - at) : null;
    const health: Health = ago === null ? "warn" : ago > every * 3 ? "down" : ago > every * 1.5 ? "warn" : "ok";
    return { name, everyMinutes: every, lastAt: at, health };
  });
  const lowWallets = walletBalances.data?.filter((w) => w.low).length ?? 0;
  const oracleStuck = b?.oracle.deferred.filter((d) => d.attempts >= 5).length ?? 0;
  const v3Solvent = solvency(v3, b?.owedWei.vs);
  const poolSolvent = solvency(pool, b?.owedWei.pool);

  const status: Array<{ name: string; health: Health; note: string }> = [
    { name: "Backend", health: be.ok ? "ok" : "down", note: be.ok ? `${be.ms} ms` : be.error ?? "" },
    { name: "Indexer", health: lag === null ? "warn" : lag > 600 ? "down" : lag > 120 ? "warn" : "ok", note: lag === null ? "unknown" : `${lag} blocks behind` },
    ...jobs.filter((j) => j.name !== "gno-sync").map((j) => ({
      name: j.name.replace(/^(arc|gno)-/, "").replace(/^./, (c) => c.toUpperCase()),
      health: j.health,
      note: j.lastAt ? `${Math.round(minutes(nowMs - j.lastAt))} min ago` : "no heartbeat yet",
    })),
    { name: "Oracle queue", health: oracleStuck > 0 ? "warn" : "ok", note: `${b?.oracle.waiting ?? "?"} waiting · ${oracleStuck} retried 5+ times` },
    { name: "gno.land RPC", health: chainHead.ok ? "ok" : "down", note: chainHead.ok ? `block ${chainHead.data}` : chainHead.error ?? "" },
    { name: "mUSD realm", health: musd.ok ? "ok" : "warn", note: musd.ok ? `${musd.data?.toLocaleString("en-US")} mUSD supply` : musd.error ?? "" },
    { name: "Database", health: db.ok ? "ok" : "down", note: db.ok ? `${db.ms} ms` : db.error ?? "" },
    { name: "Telegram", health: tg.ok ? (tg.data?.lastError ? "warn" : "ok") : "down", note: tg.ok ? (tg.data?.webhook ? "webhook" : "polling") : tg.error ?? "" },
    { name: "Wallets", health: !walletBalances.ok ? "warn" : lowWallets ? "warn" : "ok", note: lowWallets ? `${lowWallets} below ${LOW_USDC} mUSD or ${LOW_GNOT} GNOT` : "funded" },
    {
      name: "Solvency",
      health: !v3Solvent || !poolSolvent ? "warn" : v3Solvent.ok && poolSolvent.ok ? "ok" : "down",
      note: !v3Solvent || !poolSolvent ? "unknown" : v3Solvent.ok && poolSolvent.ok ? "realms cover what they owe" : "a realm holds less than it owes",
    },
  ];

  return {
    at: nowMs,
    network: CHAIN.chainId,
    explorer: CHAIN.explorer,
    status,
    jobs,
    backend: be,
    chain: { head: chainHead, v3, pool, solvency: { vs: v3Solvent, pool: poolSolvent }, wallets: walletBalances },
    database: db,
    telegram: tg,
    /** The mUSD realm probe (the panel's second network row). */
    base: { head: musd },
    siteKeys: siteKeys(),
  };
}

export type AdminOverview = Awaited<ReturnType<typeof adminOverview>>;
