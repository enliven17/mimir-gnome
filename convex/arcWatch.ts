"use node";

// The watchdog: every 10 minutes, look for what needs a human and message the admin Telegram (TELEGRAM_BOT_TOKEN to each
// TELEGRAM_ADMIN_IDS chat; the admin must have sent /start to the bot once). Each problem is sent once per its quiet period.
// Watches: a live proposal that is not our oracle's verdict (a stolen oracle key), a participant's dispute (the arbiter
// must rule), a paused realm or a changed/queued role, the oracle and creator running low on GNOT or mUSD, a stopped
// job, a market the oracle keeps failing on, and house keys set the wrong way. Rules: lib/arc/watch.ts. Realms that are
// not deployed yet are reported once and otherwise skipped.
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { gasBalanceUgnot, musdBalanceWei } from "../lib/chains/client";
import { houseCreatorWallet, houseKeyWarnings, oracleAddress, oracleKey, oracleKeyWarnings } from "../lib/chains/house";
import { serverMarketChains } from "../lib/chains/registry";
import type { GnoConfig } from "../lib/gno/config";
import { poolConfig, poolMarket, vsClaim, vsConfig, type MarketConfig } from "../lib/gno/reads";
import { missingRealm, qeval, qevalValues, unquoteGo } from "../lib/gno/rpc";
import { proposalProblem, roleProblems, type Problem } from "../lib/arc/watch";

const HOUR = 3_600_000;
// How long a job may be silent before it counts as stopped (its cron interval plus slack).
const STALE_MS: Record<string, number> = { "gno-sync": 5 * 60_000, "gno-oracle": 10 * 60_000, "arc-creator": 3 * HOUR };
/** Low-balance floors: GNOT pays every account's gas; the creator also needs mUSD for seed stakes. */
const LOW = { oracle: { gnot: 5, musd: 0 }, creator: { gnot: 5, musd: 1 } } as const;

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chats = (process.env.TELEGRAM_ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!token || !chats.length) return false;
  let ok = false;
  for (const chat_id of chats) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      ok ||= res.ok;
      if (!res.ok) console.warn(`[watch] telegram ${chat_id}: ${res.status}`);
    } catch (err) {
      console.warn(`[watch] telegram ${chat_id}:`, err instanceof Error ? err.message : err);
    }
  }
  return ok;
}

const utc = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");

/** A queued role change on a realm (p/mimir roles), or "" when none or unreadable. */
async function pending(realm: string, field: string, cfg: GnoConfig): Promise<string> {
  try {
    const [v] = qevalValues(await qeval(realm, `roles.${field}.String()`, cfg));
    return v?.type === "string" ? unquoteGo(v.value) : "";
  } catch {
    return "";
  }
}

export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    await ctx.runQuery(internal.marketDeployment.check, {});
    if (process.env.MIMIR_BACKEND_OFF === "1") return; // this deployment is switched off (crons.ts)
    const e = process.env;
    const chain = serverMarketChains(e).chains.gno;
    const g = chain.gno;
    const problems: Problem[] = [];
    const tag = chain.network === "mainnet" ? "Mimir mainnet" : "Mimir testnet";
    const oracle = oracleAddress(e);

    if (chain.enabled && oracle) {
      const now = Math.floor(Date.now() / 1000);
      try {
        // 1. Roles and pause on both market realms.
        for (const [name, path, read] of [["r/vs", g.realms.vs, vsConfig], ["r/pool", g.realms.pool, poolConfig]] as const) {
          let c: MarketConfig;
          try {
            c = await read(g);
          } catch (err) {
            if (missingRealm(err)) {
              problems.push({ key: `missing:${path}`, ttlMs: 24 * HOUR, text: `ℹ️ ${name} (${path}) is not on chain yet: nothing is indexed or settled there.` });
              continue;
            }
            throw err;
          }
          const [pOwner, pOracle, pFee] = await Promise.all(["PendingOwner", "PendingOracle", "PendingFeeRecipient"].map((f) => pending(path, f, g)));
          problems.push(
            ...roleProblems(
              { name, address: path, owner: c.owner, arbiter: c.arbiter, oracle: c.oracle, paused: c.paused, feeRecipient: c.feeRecipient, pending: { owner: pOwner, oracle: pOracle, "fee recipient": pFee } },
              oracle,
            ),
          );
        }

        // 2. Live proposals: the side on chain must be the verdict our oracle saved (under 3 minutes old: maybe not saved yet, skip).
        const snap = await ctx.runQuery(internal.arcWatchDb.snapshot, { chain: "gno", now });
        for (const p of snap.proposed) {
          const [side, proposedAt] =
            p.kind === "vs"
              ? await vsClaim(p.marketId, g).then((c) => [c.proposal.winnerSide, c.proposal.proposedAt])
              : await poolMarket(p.marketId, g).then((m) => [m.proposed, m.proposedAt]);
          if (now - proposedAt < 180) continue;
          const problem = proposalProblem(p, side);
          if (problem) problems.push(problem);
        }

        // 3. A participant disputed: the arbiter has to rule (ResolveDisputeWithCutoff) before the refund opens.
        for (const d of snap.disputed.filter((d) => !d.vetoed))
          problems.push({
            key: `dispute:${d.kind}:${d.marketId}`,
            ttlMs: 24 * HOUR,
            text: `⚖️ Dispute on ${d.kind} #${d.marketId} "${d.question.slice(0, 120)}". The arbiter must rule (ResolveDisputeWithCutoff) before ${utc(d.refundAt)} UTC, or everyone is refunded.`,
          });

        // 4. A market the oracle keeps failing on (reported at 6 tries, again at 12). Waiting on a game still in play is a
        // deferral, not a failure: only a try that ended in an error counts (arcWatchDb).
        for (const s of snap.stuck)
          problems.push({ key: `stuck:${s.kind}:${s.marketId}:${s.attempts >= 12 ? 12 : 6}`, ttlMs: 7 * 24 * HOUR, text: `⚠️ The oracle has failed ${s.attempts}× on ${s.kind} #${s.marketId}: ${s.lastError.slice(0, 300)}` });

        // 5. Stopped jobs.
        for (const [name, stale] of Object.entries(STALE_MS)) {
          const h = snap.heartbeats.find((b) => b.name === name);
          if (h && Date.now() - h.at > stale) problems.push({ key: `stale:${name}`, ttlMs: 2 * HOUR, text: `⚠️ Job ${name} last ran ${Math.round((Date.now() - h.at) / 60_000)} min ago.` });
        }

        // 6. Money: GNOT for gas, and mUSD for the creator's seed stakes.
        for (const [who, address, min] of [["Oracle", oracle, LOW.oracle], ["Market creator", houseCreatorWallet(e)?.address, LOW.creator]] as const) {
          if (!address) continue;
          const [ugnot, musd] = await Promise.all([gasBalanceUgnot(address, g), musdBalanceWei(address, g)]);
          const gnot = Number(ugnot) / 1e6;
          const usd = Number(musd) / 1e18;
          if (gnot < min.gnot) problems.push({ key: `low-gnot:${address}`, ttlMs: 12 * HOUR, text: `🪫 ${who} ${address} has ${gnot.toFixed(2)} GNOT (under ${min.gnot}). Top it up.` });
          if (usd < min.musd) problems.push({ key: `low-musd:${address}`, ttlMs: 12 * HOUR, text: `🪫 ${who} ${address} has ${usd.toFixed(2)} mUSD (under ${min.musd}). Top it up.` });
        }
      } catch (err) {
        problems.push({ key: "watch-error", ttlMs: HOUR, text: `⚠️ The watchdog could not finish its checks: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}` });
      }
    }

    for (const w of [...oracleKeyWarnings(e), ...houseKeyWarnings(e)]) problems.push({ key: `keys:${w.slice(0, 40)}`, ttlMs: 24 * HOUR, text: `⚠️ ${w}` });
    if (chain.enabled && !oracleKey(e)) problems.push({ key: "oracle-key:none", ttlMs: 12 * HOUR, text: "⚠️ No ORACLE_MNEMONIC: nothing is settled." });

    const seen = new Set<string>();
    for (const p of problems) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      if (!(await ctx.runMutation(internal.arcWatchDb.claim, { key: p.key, ttlMs: p.ttlMs }))) continue;
      const sent = await sendTelegram(`${tag}\n${p.text}`);
      if (!sent) console.warn(`[watch] NOT sent (Telegram env missing?): ${p.text}`);
    }
  },
});
