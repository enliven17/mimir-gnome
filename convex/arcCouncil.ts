"use node";

// The council on gno.land, as a Convex cron step. Each tick takes the open markets from the index, and for each
// (market, persona) pair still undecided runs the same persona pipeline (agents/council/shared/persona-runner.ts:
// category filter, rule personas, the LLM persona over one cached evidence fetch, Kelly sizing at the pool's odds).
// A persona that disagrees with the creator stakes side B from its own gno.land account (its mnemonic in
// GNO_COUNCIL_MNEMONICS, lib/chains/house.ts): an exact mUSD Approve rides in the same transaction when needed, gas is
// GNOT. A persona without a key or without GNOT does not stake. Every decision is recorded (arcCouncilDb) and shown on
// the market page; a considered no stands for COUNCIL_REEVAL_MS.
// Env: GNO_COUNCIL_MNEMONICS (scripts/gno-wallets.ts), GNO_COUNCIL_WALLETS (the public addresses, optional), the LLM
//      keys, MIMIR_PAUSE_COUNCIL=1 to stop, COUNCIL_DRY_RUN=1 to decide without staking.

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { activePersonas } from "../agents/council/personas";
import { createThrottle, evaluatePersonaForClaim } from "../agents/council/shared/persona-runner";
import { getOrFetchEvidence } from "../agents/council/shared/evidence-cache";
import { evaluateClaimAsPersona } from "../agents/council/shared/persona-llm";
import type { PersonaSpec } from "../agents/council/personas";
import type { ActionCtx } from "./_generated/server";
import { sizeStakeUnits } from "../agents/council/shared/persona-rules";
import type { CouncilClaim, EvidenceCacheEntry } from "../agents/council/shared/types";
import { floorToChain } from "../lib/chains/amounts";
import { councilMnemonics, councilWallets, houseAddresses, houseCreatorWallet } from "../lib/chains/house";
import { serverMarketChains, type MarketChainId } from "../lib/chains/registry";
import { gnoSigner } from "../lib/gno/signer";
import { gnoStake, MIN_GAS_UGNOT, walletGasUgnot, walletMusdWei } from "../lib/server/gno-wallets";
import { jevEnabled } from "../lib/jev";
import { skipTake } from "../lib/jev-triage";
import { ENTRY_FEE_BPS } from "../lib/arc/fees";
import { LOCK_SECONDS, maxGrossFor, vsRoom } from "../lib/arc/markets";
import { copyArcStake } from "../lib/launch/arc-copy";
import { councilCopyKey } from "../lib/launch/copy-key";
import { createConsoleLogger } from "../lib/launch/log";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

const copyLog = createConsoleLogger({ level: process.env.LOG_LEVEL, base: { svc: "council-copy" } });

/** A tick fits well inside Convex's 10-minute action limit: each decision is one throttled LLM call at most. */
const MAX_DECISIONS_PER_TICK = Number(process.env.COUNCIL_MAX_DECISIONS ?? 12);
const REEVAL_MS = Number(process.env.COUNCIL_REEVAL_MS ?? 30 * 60_000);
const RETRY_MS = 10 * 60_000;
/** Leave the stake time to land before betting closes. */
const MARGIN_SECONDS = 5 * 60;

type Market = Doc<"arcMarkets"> & { chain: MarketChainId };
type Position = Doc<"arcPositions">;

/** The shared runner reads addresses through toBase58() / equals(); an Arc address behind that face. */
/** Addresses as the oracle and council compare them: lowercase. */
const addr = (a: string) => a.toLowerCase();
const units = (wei: string | bigint) => BigInt(wei) / 1_000_000_000_000n;

function asCouncilClaim(m: Market, positions: Position[]): CouncilClaim {
  return {
    id: BigInt(m.marketId),
    creator: addr(m.creator),
    question: m.question,
    creatorPosition: m.labelA,
    counterPosition: m.labelB,
    resolutionUrl: m.resolutionUrl,
    category: m.category,
    creatorStake: units(m.stakeA),
    totalChallengerStake: units(m.stakeB),
    deadline: m.deadline,
    state: m.status === "active" ? 1 : 0,
    maxChallengers: 100,
    challengers: positions.filter((p) => p.side === 2).map((p) => ({ addr: addr(p.user), stake: units(p.amount), paid: false })),
  } as unknown as CouncilClaim;
}

/** The house creator's address: rule personas trade only its markets (persona-rules.ts). */
const houseCreator = (): string | null => houseCreatorWallet()?.address ?? null;

/** 6-dp units as the decimal USDC string for logs. */
const usdcString = (u: bigint) => (Number(u) / 1e6).toFixed(6).replace(/\.?0+$/, "");
/** 6-dp units → index units (18 dp). */
const unitsToWei = (u: bigint) => u * 1_000_000_000_000n;

export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runQuery(internal.marketDeployment.check, {});
    if (process.env.MIMIR_BACKEND_OFF === "1") return; // this deployment is switched off (crons.ts)
    await ctx.runMutation(internal.arcAdmin.beat, { name: "arc-council" });
    if (process.env.MIMIR_PAUSE_COUNCIL === "1") return;
    const e = process.env;
    const registry = serverMarketChains(e);
    if (!registry.enabled.length) return;
    // A persona stakes when it has a key; its address is the one GNO_COUNCIL_WALLETS lists (or derived from the key).
    const keys = councilMnemonics(e);
    const addresses = councilWallets(e);
    const wallets: Record<string, { address: string; mnemonic: string }> = Object.fromEntries(
      Object.entries(keys).filter(([slug]) => addresses[slug]).map(([slug, mnemonic]) => [slug, { address: addresses[slug].address, mnemonic }]),
    );
    const dryRun = e.COUNCIL_DRY_RUN === "1";
    const now = Math.floor(Date.now() / 1000);

    const markets = (await ctx.runQuery(internal.arc.openMarkets, { closesAfter: now + LOCK_SECONDS + MARGIN_SECONDS })).filter((m) =>
      registry.enabled.includes(m.chain),
    ) as Market[];
    const standing = new Set(await ctx.runQuery(internal.arcCouncilDb.standing, { now: Date.now() }));
    const evidenceCache = new Map<string, EvidenceCacheEntry>();
    const throttle = createThrottle(Number(e.COUNCIL_LLM_THROTTLE_MS ?? 4500));
    // Per account: mUSD (index units) and whether it has GNOT for gas.
    const balances = new Map<string, bigint>();
    const hasGas = new Map<string, boolean>();

    // Comment mode: one take per market from the best-suited persona, no stake (COUNCIL_COMMENTS, on by default).
    if (e.COUNCIL_COMMENTS !== "0") await writeTakes(ctx, markets, evidenceCache, throttle);
    // Betting can be switched off on its own (COUNCIL_BETS=0 saves the mUSD and most of the LLM spend).
    if (e.COUNCIL_BETS === "0") return;

    let decisions = 0;
    const staked = new Set<MarketChainId>();

    // Closest deadline first: those are the markets about to stop taking positions.
    for (const m of markets.sort((a, b) => a.deadline - b.deadline)) {
      const cfg = registry.chains[m.chain];
      const full = await ctx.runQuery(internal.arc.marketWithPositions, { chain: m.chain, kind: m.kind, marketId: m.marketId });
      if (!full) continue;
      const claim = asCouncilClaim(m, full.positions);
      const inMarket = new Set(full.positions.map((p) => p.user));
      for (const persona of activePersonas()) {
        if (decisions >= MAX_DECISIONS_PER_TICK) break;
        const wallet = wallets[persona.slug];
        if (!wallet || standing.has(`${persona.slug}:${m.chain}:${m.kind}:${m.marketId}`)) continue;
        const me = wallet.address.toLowerCase();
        // Personas only challenge: never their own market, and once per market.
        if (m.creator === me || inMarket.has(me)) continue;

        decisions++;
        let lean: number | undefined;
        const record = (d: { outcome: "staked" | "abstained" | "retry" | "failed"; rationale: string; confidence?: number; amount?: string; txHash?: string; until: number }) =>
          ctx.runMutation(internal.arcCouncilDb.record, { slug: persona.slug, chain: m.chain, kind: m.kind, marketId: m.marketId, ...(lean !== undefined ? { lean } : {}), ...d });
        try {
          const decision = await evaluatePersonaForClaim(persona, claim, { evidenceCache, throttle, recordForecasts: false, houseCreator: houseCreator(), mainnet: cfg.network === "mainnet" });
          lean = decision.verdict ? LEAN[decision.verdict] : undefined;
          if (!decision.shouldStake) {
            const transient = decision.skipReason === "llm-failed" || decision.skipReason === "no-evidence";
            const considered = !transient && persona.archetype !== "rule-based";
            await record({ outcome: considered ? "abstained" : "retry", rationale: decision.rationale, confidence: decision.confidence, until: Date.now() + (considered ? REEVAL_MS : RETRY_MS) });
            continue;
          }
          const bal = me;
          if (!balances.has(bal)) balances.set(bal, await walletMusdWei(wallet.address, cfg.gno));
          if (!hasGas.has(bal)) hasGas.set(bal, (await walletGasUgnot(wallet.address, cfg.gno)) >= MIN_GAS_UGNOT);
          if (hasGas.get(bal) === false) {
            await record({ outcome: "abstained", rationale: `${persona.displayName} has no GNOT for gas.`, confidence: decision.confidence, until: Date.now() + REEVAL_MS });
            continue;
          }
          const bankroll = units(balances.get(bal)!);
          let stake = sizeStakeUnits({ baseUsdc: persona.stakeUsdc, confidence: decision.confidence, bankrollUnits: bankroll, creatorStakeUnits: claim.creatorStake, totalChallengerStakeUnits: claim.totalChallengerStake });
          if (stake === null || stake === 0n) {
            await record({ outcome: "abstained", rationale: stake === null ? `${persona.displayName} is out of mUSD.` : `${persona.displayName} sits out: no +EV stake at these pool odds.`, confidence: decision.confidence, until: Date.now() + REEVAL_MS });
            continue;
          }
          if (m.kind === "vs") {
            // The 5x cap counts net stakes; personas pay the standard entry fee.
            const room = units(maxGrossFor(vsRoom(BigInt(m.stakeA), BigInt(m.stakeB)), ENTRY_FEE_BPS));
            if (room < units(cfg.minStakeWei)) {
              await record({ outcome: "abstained", rationale: `${persona.displayName} would challenge, but the market is full.`, confidence: decision.confidence, until: Date.now() + REEVAL_MS });
              continue;
            }
            if (stake > room) stake = room;
          }
          const amount = usdcString(stake);
          if (dryRun) {
            await record({ outcome: "abstained", rationale: `[dry run] would stake ${amount} mUSD. ${decision.rationale}`, confidence: decision.confidence, until: Date.now() + RETRY_MS });
            continue;
          }
          const wei = floorToChain(cfg, unitsToWei(stake));
          const signer = await gnoSigner(wallet.mnemonic, cfg.gno);
          const { txHash } = await gnoStake(signer, { kind: m.kind, marketId: m.marketId, side: 2, wei }, cfg.gno);
          balances.set(bal, balances.get(bal)! - wei);
          inMarket.add(me);
          staked.add(m.chain);
          // A stake stands for good: a persona is in once per market.
          await record({ outcome: "staked", rationale: decision.rationale, confidence: decision.confidence, amount: wei.toString(), txHash, until: Number.MAX_SAFE_INTEGER });
          // Mimir Launch: one copy job per follower of this persona (pools only); scheduling only, never throws.
          await copyArcStake(ctx, copyLog, councilCopyKey(persona.slug), m, 2, txHash);
        } catch (err) {
          const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 300);
          console.warn(`[council] ${persona.slug} on ${m.chain} ${m.kind} #${m.marketId}: ${msg}`);
          await record({ outcome: "failed", rationale: msg, until: Date.now() + RETRY_MS });
        }
      }
      if (decisions >= MAX_DECISIONS_PER_TICK) break;
    }
    if (staked.size) await ctx.scheduler.runAfter(0, internal.arcSync.sync, {});
  },
});

const TAKES_PER_TICK = Number(process.env.COUNCIL_TAKES_PER_TICK ?? 3);
// Anyone can open markets cheaply; a creator gets this many takes a day so a bot cannot spend the backend's model quota.
// Jev's category replaces a "custom" one for persona choice only when it is at least this sure.
const JEV_CATEGORY_AT = 0.8;
const LEAN = { CREATOR_WINS: 1, CHALLENGERS_WIN: 2, DRAW: 0, UNRESOLVABLE: 0 } as const;

/**
 * The persona best placed to read a market: the specialist for its category (crypto, sports, weather), else the
 * Statistician, else Socrates. Rule personas never comment: they have no read, only pool arithmetic.
 */
function bestPersonaFor(category: string): PersonaSpec | null {
  const all = activePersonas().filter((p) => p.archetype !== "rule-based");
  const c = category.toLowerCase();
  return (
    all.find((p) => p.categoryFilter?.some((f) => c.includes(f))) ??
    all.find((p) => p.slug === "statistician") ??
    all.find((p) => p.slug === "socrates") ??
    all[0] ??
    null
  );
}

/**
 * Up to three forecast-only perspectives per market, sharing the existing per-tick call budget.
 */
async function writeTakes(ctx: ActionCtx, markets: Market[], evidenceCache: Map<string, EvidenceCacheEntry>, throttle: () => Promise<void>) {
  const takes = await ctx.runQuery(internal.arcCouncilDb.takenMarkets, {});
  const taken = new Map(takes.map((t) => [t.key, t]));
  const radarOn = process.env.COUNCIL_RADAR !== "0";
  const refreshMs = Math.max(30 * 60_000, Number(process.env.COUNCIL_RADAR_REEVAL_MS) || 6 * 3_600_000);
  // Jev's triage (only with TYPESAFE_API_KEY): no take on a market it is sure is spam or cannot be settled, and a
  // better category for persona choice when the creator left it as "custom".
  const triage = new Map(jevEnabled() ? (await ctx.runQuery(internal.arcTriage.all, {})).map((t) => [t.key, t]) : []);
  const houseSet = new Set(houseAddresses());
  const keyOf = (m: Market) => `${m.chain}:${m.kind}:${m.marketId}`;
  let written = 0;
  for (const m of [...markets].sort((a, b) => b.createdAt - a.createdAt)) {
    if (written >= TAKES_PER_TICK) break;
    const mk = keyOf(m);
    const featured = taken.get(mk);
    if (featured && !radarOn) continue;
    const creator = m.creator.toLowerCase();
    const t = triage.get(mk);
    if (skipTake(t)) continue;
    const lead = bestPersonaFor(m.category === "custom" && t && t.categoryConfidence >= JEV_CATEGORY_AT ? t.category : m.category);
    if (!lead) return;
    const roster = activePersonas().filter((p) => p.archetype !== "rule-based");
    const candidates = [...new Map([lead, ...roster.filter((p) => p.slug === "statistician" || p.slug === "socrates"), ...roster.filter((p) => !p.categoryFilter)].map((p) => [p.slug, p])).values()].slice(0, radarOn ? 3 : 1);
    const existing = radarOn ? await ctx.runQuery(internal.councilOpinions.forWorker, { chain: m.chain, kind: m.kind, marketId: m.marketId }) : [];
    for (const persona of candidates) {
      if (written >= TAKES_PER_TICK) break;
      const previous = existing.find((o) => o.slug === persona.slug);
      const lastAt = previous?.at ?? (featured?.slug === persona.slug ? featured.at : 0);
      if (lastAt && Date.now() - lastAt < refreshMs) continue;
      if (!await ctx.runMutation(internal.councilOpinions.claim, { creator })) break;
      written++; // Failed calls consume the same attempt budget.
      try {
        const claim = asCouncilClaim(m, []);
        const evidence = await getOrFetchEvidence(mk, m.resolutionUrl, evidenceCache);
        await throttle();
        const result = await evaluateClaimAsPersona(persona, claim, evidence.text, { mode: "take" });
        const evidenceHash = bytesToHex(sha256(new TextEncoder().encode(evidence.text)));
        const forecast = { chain: m.chain, kind: m.kind, marketId: m.marketId, slug: persona.slug, lean: LEAN[result.verdict], confidence: result.confidence, text: result.explanation.slice(0, 600) };
        if (!featured && persona.slug === lead.slug) await ctx.runMutation(internal.arcCouncilDb.saveTake, { ...forecast, creator });
        if (radarOn) await ctx.runMutation(internal.councilOpinions.record, { ...forecast, evidenceHash });
      } catch (err) {
        console.warn(`[council] forecast on ${m.chain} ${m.kind} #${m.marketId}:`, err instanceof Error ? err.message : err);
      }
    }
  }
}
