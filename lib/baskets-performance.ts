import "server-only";

/**
 * Turning the read index into a basket curve and mirror signals.
 *
 * A basket member is named by id (a council persona slug or a registered agent
 * id); the chain only knows wallets. This resolves ids to the wallets that
 * actually stake (a persona's gno.land wallet, an agent's operator), reads the
 * markets those wallets staked on from the market index, and hands the pure
 * functions in lib/baskets.ts realized outcomes. Nothing here invents a
 * return: an agent that never settled anything contributes nothing.
 */
import { store } from "@/lib/server/store";
import { serverMarketChains } from "@/lib/chains/registry";
import { normalizeOwner } from "@/lib/owner";
import { arcClaimsChallengedBy, resolveArcAgentWallets } from "@/lib/server/arc-baskets";

/** Baskets read the market index once the market chain is enabled and Convex is set. */
export const onArc = () => Boolean(serverMarketChains().enabled.length && process.env.NEXT_PUBLIC_CONVEX_URL);

/** The address a follower stakes from: the follower's own gno.land address (lowercase, as the index has it). */
export async function stakingAddressOf(follower: string | null): Promise<string | null> {
  if (!follower || !onArc()) return follower;
  return normalizeOwner(follower);
}
import { councilRoster } from "@/lib/server/council-roster";
import { ST_ACTIVE, ST_OPEN, ST_RESOLVED } from "@/lib/market-codes";
import {
  mirrorSignals,
  settlementsFromClaims,
  type BasketMember,
  type IndexedClaim,
  type MemberSettlement,
  type MirrorSignal,
} from "@/lib/baskets";

/**
 * Map member ids to staking wallets. Personas resolve from the roster (their
 * gno.land wallets), registered agents from the registry's operator wallet.
 * An id that resolves to neither is dropped rather than guessed at.
 */
export async function resolveAgentWallets(agentIds: string[]): Promise<Map<string, string>> {
  if (onArc()) return resolveArcAgentWallets(agentIds);
  const wanted = new Set(agentIds);
  const map = new Map<string, string>();

  for (const p of councilRoster()) {
    if (wanted.has(p.slug) && p.address) map.set(p.slug, p.address);
  }

  const missing = agentIds.filter((id) => !map.has(id));
  if (missing.length > 0) {
    const rows = await store().getMany<{ agent_id: string; operator_wallet: string; status: string }>("agent_registry", missing).catch(() => []);
    for (const r of rows) if (r.status !== "revoked") map.set(r.agent_id, r.operator_wallet);
  }
  return map;
}

function invert(wallets: Map<string, string>): Map<string, string> {
  const byWallet = new Map<string, string>();
  for (const [agentId, wallet] of wallets) byWallet.set(wallet, agentId);
  return byWallet;
}

/** Markets where any of `wallets` staked, in `states`. Shared with copy trading. */
export async function claimsChallengedBy(wallets: string[], states: number[], limit: number): Promise<IndexedClaim[]> {
  if (wallets.length === 0) return [];
  return onArc() ? arcClaimsChallengedBy(wallets, states, limit) : [];
}

/** Realized, after-fee outcomes for a basket's members (RESOLVED claims only). */
export async function loadMemberSettlements(
  members: BasketMember[],
  wallets?: Map<string, string>,
): Promise<MemberSettlement[]> {
  const resolved = wallets ?? (await resolveAgentWallets(members.map((m) => m.agentId)));
  const byWallet = invert(resolved);
  const claims = await claimsChallengedBy([...byWallet.keys()], [ST_RESOLVED], 1_000);
  return settlementsFromClaims(claims, byWallet);
}

/** Live positions of a basket's members that `follower` could copy now. */
export async function loadMirrorSignals(args: {
  members: BasketMember[];
  follower: string | null;
  perMarketCapUsdc: number;
  wallets?: Map<string, string>;
}): Promise<MirrorSignal[]> {
  const resolved = args.wallets ?? (await resolveAgentWallets(args.members.map((m) => m.agentId)));
  const byWallet = invert(resolved);
  const claims = await claimsChallengedBy([...byWallet.keys()], [ST_OPEN, ST_ACTIVE], 200);
  return mirrorSignals({
    claims,
    agentByWallet: byWallet,
    follower: await stakingAddressOf(args.follower),
    perMarketCapUsdc: args.perMarketCapUsdc,
  });
}
