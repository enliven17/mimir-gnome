/**
 * The gno.land indexer's pure half (convex/arcSync.ts drives it): which of a block's events belong to Mimir's market
 * realms, as activity rows (convex/schema.ts arcEvents) and as the markets and pool stakers they touched. The realms'
 * own JSON views stay the source of truth for every market's state; events only name what changed and who staked,
 * since a pool cannot list its stakers on chain.
 *
 * Amounts in events are mUSD units (6 dp) and leave as index units (18 dp); `logIndex` is tx index × 1000 + the
 * event's position in that tx, unique within a block.
 */
import type { GnoConfig } from "./config";
import type { GnoEvent } from "./tx";

export type Kind = "vs" | "pool";

export interface IndexedBlock {
  height: number;
  /** Unix seconds. */
  time: number;
  /** Hex hashes, in block order. */
  txs: string[];
  /** One per tx, same order. */
  results: Array<{ ok: boolean; events: GnoEvent[] }>;
}

export interface EventRow {
  chain: "gno";
  kind: Kind;
  marketId: number;
  name: string;
  user?: string;
  amount?: string;
  side?: number;
  txHash: string;
  logIndex: number;
  block: number;
  at: number;
}

const SCALE = 1_000_000_000_000n;
const lower = (s: string | undefined) => (s ?? "").trim().toLowerCase();
const idx = (units: string | undefined) => (/^\d+$/.test(units ?? "") ? (BigInt(units as string) * SCALE).toString() : undefined);
const num = (s: string | undefined) => (/^\d+$/.test(s ?? "") ? Number(s) : undefined);

/** Which attribute is the event's user, amount and side, per realm event name. */
const FIELDS: Record<string, { user?: string; amount?: string; side?: string }> = {
  MarketCreated: { user: "creator" },
  ClaimCreated: { user: "creator" },
  Staked: { user: "user", amount: "amount", side: "side" },
  ClaimChallenged: { user: "challenger", amount: "stake" },
  Claimed: { user: "user", amount: "paid" },
  FeeAccrued: { user: "recipient", amount: "amount" },
  ResolutionProposed: { side: "outcome" },
  ResolutionDisputed: { user: "disputer", amount: "bond" },
  DisputeResolved: { side: "outcome" },
  MarketResolved: { side: "outcome" },
  ClaimResolved: { side: "winnerSide" },
  ClaimCancelled: { amount: "refunded" },
  MarketSettled: { amount: "totalPaid" },
  MarketExpiredRefund: { user: "caller" },
  ClaimExpiredRefund: { user: "caller" },
  ReferrerSet: { user: "user" },
  InviteUpdated: { user: "account" },
  LockSet: {},
  SettlementCutoffSet: {},
};

export function eventRows(blocks: IndexedBlock[], cfg: Pick<GnoConfig, "realms">): EventRow[] {
  const kindOf = (pkg: string): Kind | null => (pkg === cfg.realms.vs ? "vs" : pkg === cfg.realms.pool ? "pool" : null);
  const out: EventRow[] = [];
  for (const b of blocks) {
    b.results.forEach((r, ti) => {
      if (!r.ok) return;
      r.events.forEach((e, ei) => {
        const kind = kindOf(e.pkgPath);
        const marketId = num(e.attrs.id);
        if (!kind || !marketId || !(e.type in FIELDS)) return;
        const f = FIELDS[e.type];
        // r/vs names the proposed side winnerSide; r/pool names it outcome.
        const sideAttr = f.side === "outcome" && kind === "vs" ? "winnerSide" : f.side;
        const user = f.user ? lower(e.attrs[f.user]) : "";
        const amount = f.amount ? idx(e.attrs[f.amount]) : undefined;
        const side = sideAttr ? num(e.attrs[sideAttr]) : undefined;
        out.push({
          chain: "gno",
          kind,
          marketId,
          name: e.type,
          ...(user ? { user } : {}),
          ...(amount !== undefined ? { amount } : {}),
          ...(side !== undefined ? { side } : {}),
          txHash: b.txs[ti] ?? `${b.height}:${ti}`,
          logIndex: ti * 1000 + ei,
          block: b.height,
          at: b.time,
        });
      });
    });
  }
  return out;
}

/** The markets the rows touched ("vs:3"), each with the users who staked in it (pool positions to re-read). */
export function touchedMarkets(rows: EventRow[]): Map<string, { kind: Kind; marketId: number; users: Set<string> }> {
  const out = new Map<string, { kind: Kind; marketId: number; users: Set<string> }>();
  for (const r of rows) {
    const key = `${r.kind}:${r.marketId}`;
    const t = out.get(key) ?? { kind: r.kind, marketId: r.marketId, users: new Set<string>() };
    if (r.user && (r.name === "Staked" || r.name === "MarketCreated" || r.name === "Claimed")) t.users.add(r.user);
    out.set(key, t);
  }
  return out;
}
