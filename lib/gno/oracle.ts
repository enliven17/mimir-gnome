/**
 * The oracle's and the audit agent's calls on the market realms, as MsgCalls (lib/gno/msgs.ts shape). Pure, so the
 * exact arguments are tested; convex/arcOracle.ts and agents/audit send them with lib/gno/signer.ts.
 *
 *   resolve   pool ResolveWithCutoff(id, outcome, summary, evidenceHash, cutoff)
 *             vs   ResolveClaimWithCutoff(id, winnerSide, summary, confidence 0-100, evidenceHash, cutoff)
 *   finalize  pool Finalize(id) / vs FinalizeResolution(id), once the dispute window closed
 *   refund    RefundExpired(id) on either, once the grace is over
 *   pay       pool ClaimFor(id, user): the payout only ever goes to `user`
 *
 * evidenceHash is the lowercase hex sha256 of the verdict bundle (lib/verdict-bundle.ts), or "" for none; the realms
 * refuse anything else.
 */
import { GNO, type GnoConfig } from "./config";
import type { GnoMsgCall, MarketKind } from "./msgs";

const call = (caller: string, pkg: string, func: string, args: (string | number)[]): GnoMsgCall => ({
  type: "/vm.m_call",
  value: { caller, send: "", max_deposit: "", pkg_path: pkg, func, args: args.map(String) },
});
const realm = (kind: MarketKind, cfg: GnoConfig) => (kind === "vs" ? cfg.realms.vs : cfg.realms.pool);
/** Summaries the realms store: plain text, bounded. */
const MAX_SUMMARY = 500;

export function evidenceHashArg(hash: string | Uint8Array | null | undefined): string {
  if (!hash) return "";
  const hex = typeof hash === "string" ? hash.replace(/^0x/, "").toLowerCase() : Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  if (/^0+$/.test(hex)) return "";
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("evidence hash must be 32 bytes");
  return hex;
}

export interface Verdict {
  kind: MarketKind;
  marketId: number;
  /** 1 A / creator, 2 B / challengers, 3 draw, 4 unresolvable. */
  side: number;
  summary: string;
  /** 0-100 (VS only). */
  confidence: number;
  evidenceHash: string | Uint8Array | null;
  /** Unix seconds; only deposits strictly before it compete (0 = all). */
  cutoff: number;
}

export function resolveMessage(caller: string, v: Verdict, cfg: GnoConfig = GNO): GnoMsgCall {
  if (![1, 2, 3, 4].includes(v.side)) throw new Error("bad side");
  const conf = Math.max(0, Math.min(100, Math.round(v.confidence)));
  const summary = v.summary.slice(0, MAX_SUMMARY);
  const hash = evidenceHashArg(v.evidenceHash);
  return v.kind === "vs"
    ? call(caller, cfg.realms.vs, "ResolveClaimWithCutoff", [v.marketId, v.side, summary, conf, hash, v.cutoff])
    : call(caller, cfg.realms.pool, "ResolveWithCutoff", [v.marketId, v.side, summary, hash, v.cutoff]);
}

export const finalizeMessage = (caller: string, kind: MarketKind, id: number, cfg: GnoConfig = GNO) =>
  call(caller, realm(kind, cfg), kind === "vs" ? "FinalizeResolution" : "Finalize", [id]);

export const refundMessage = (caller: string, kind: MarketKind, id: number, cfg: GnoConfig = GNO) => call(caller, realm(kind, cfg), "RefundExpired", [id]);

export const claimForMessage = (caller: string, id: number, user: string, cfg: GnoConfig = GNO) => call(caller, cfg.realms.pool, "ClaimFor", [id, user]);
