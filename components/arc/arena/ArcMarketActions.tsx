"use client";

/**
 * What a participant can do outside staking:
 *   cancel   the VS creator, while nobody has challenged yet: the stake comes back (the entry fee stays earned)
 *   dispute  any participant, while the oracle's proposal is inside its dispute window: a 2 mUSD bond escalates it
 *            to the arbiter; the bond comes back if the verdict changes, and is forfeited if it stands
 *   claim    a pool participant, once settled: the payout (or refund) the realm holds for them, if it has not been
 *            paid out already (r/pool PositionJSON claimable)
 */
import { useEffect, useState } from "react";

import { DISPUTE_BOND_WEI } from "@/lib/chains/calls";
import { explorerUrl } from "@/lib/chains/registry";
import { fromMusdUnits } from "@/lib/gno/msgs";
import { poolPosition } from "@/lib/gno/reads";
import { BTN_PRIMARY, BTN_SECONDARY, usd, type ArcMarket } from "./shared";
import type { useArcAccount } from "./useArcAccount";
import { useArcSend } from "./useArcSend";

const BOND = DISPUTE_BOND_WEI;

export default function ArcMarketActions({
  m,
  mine,
  account,
  now,
}: {
  m: ArcMarket;
  mine: { side: number }[];
  account: ReturnType<typeof useArcAccount>;
  now: number;
}) {
  const { send, busy, error, last } = useArcSend(account);
  const cfg = account.chainConfig;
  const [confirming, setConfirming] = useState(false);
  /** What the realm would pay this account now (index units); null = unknown or not applicable. */
  const [claimable, setClaimable] = useState<bigint | null>(null);
  const me = account.address?.toLowerCase();
  const settled = m.status === "resolved" || m.status === "cancelled";
  const canCancel = m.kind === "vs" && m.status === "open" && me === m.creator;
  const canDispute = m.status === "proposed" && m.disputableUntil > now && mine.length > 0;

  useEffect(() => {
    if (m.kind !== "pool" || !settled || !me || !mine.length) return setClaimable(null);
    let live = true;
    poolPosition(m.marketId, me, cfg.gno).then(
      (p) => live && setClaimable(p.claimed ? 0n : fromMusdUnits(p.claimable)),
      () => live && setClaimable(null),
    );
    return () => {
      live = false;
    };
  }, [m.kind, m.marketId, settled, me, mine.length, cfg, last]);

  const canClaim = claimable !== null && claimable > 0n;
  if (!account.session || (!canCancel && !canDispute && !canClaim)) return null;

  const short = account.balance !== null && account.balance < BOND;

  const cancel = async () => {
    if (await send({ type: "cancel", marketId: m.marketId })) void account.reload();
  };
  const dispute = async () => {
    if (await send({ type: "dispute", kind: m.kind, marketId: m.marketId })) void account.reload();
  };
  const claim = async () => {
    if (await send({ type: "claim", marketId: m.marketId })) void account.reload();
  };

  return (
    <div className="mt-6 grid gap-3 border-t border-line pt-5">
      {canClaim ? (
        <>
          <p className="m-0 text-[13px] leading-relaxed text-muted">This market is settled. {usd(claimable ?? 0n)} is waiting for you.</p>
          <button type="button" disabled={busy} onClick={() => void claim()} className={BTN_PRIMARY}>
            {busy ? "Confirm in Adena…" : `Claim ${usd(claimable ?? 0n)}`}
          </button>
        </>
      ) : null}
      {canCancel ? (
        <>
          <p className="m-0 text-[13px] leading-relaxed text-muted">Nobody has challenged yet. You can cancel and take your stake back.</p>
          <button type="button" disabled={busy} onClick={() => void cancel()} className={BTN_SECONDARY}>
            {busy ? "Confirm in Adena…" : "Cancel and get your stake back"}
          </button>
        </>
      ) : null}
      {canDispute ? (
        <>
          <p className="m-0 text-[13px] leading-relaxed text-muted">
            Think the oracle got it wrong? Dispute with a {usd(BOND)} bond before the window closes: it comes back if the arbiter changes the result or cutoff, and
            is kept if the result stands.
          </p>
          {confirming ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy || short} onClick={() => void dispute()} className="rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-[#160909] disabled:opacity-60">
                {busy ? "Confirm in Adena…" : `Dispute (${usd(BOND)} bond)`}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={BTN_SECONDARY}>
                Keep the result
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className={BTN_SECONDARY}>
              Dispute the result
            </button>
          )}
          {short ? <p className="m-0 text-[12px] text-pending">You need {usd(BOND)} {cfg.token.symbol} on {cfg.label} for the bond.</p> : null}
        </>
      ) : null}
      {error ? <p className="m-0 text-[13px] text-danger">{error}</p> : null}
      {last ? (
        <a href={explorerUrl(cfg, "tx", last.txHash)} target="_blank" rel="noreferrer" className="text-[13px] text-coral hover:underline">
          ✓ Done, view on {cfg.explorerName}
        </a>
      ) : null}
    </div>
  );
}
