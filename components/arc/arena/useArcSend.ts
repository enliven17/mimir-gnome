"use client";

/**
 * Send market actions from the connected Adena account (lib/chains/send.ts: one transaction, an mUSD Approve in
 * front when the allowance falls short), then nudge the Convex indexer so the page shows the result in seconds
 * instead of on the next cron tick.
 */
import { useCallback, useState } from "react";
import { useMutation } from "@/lib/convex-react";

import { api } from "@/convex/_generated/api";
import { isUserRejection, type TxReceipt } from "@/lib/gno/adena";
import type { MarketAction } from "@/lib/chains/calls";
import type { MarketChain } from "@/lib/chains/registry";
import { NoGasError } from "@/lib/chains/send";
import type { useArcAccount } from "./useArcAccount";

export function describeSendError(err: unknown, chain: Pick<MarketChain, "label" | "gas" | "token">): string {
  if (err instanceof NoGasError) return err.message;
  if (isUserRejection(err)) return "The transaction was cancelled in Adena.";
  const msg = (err as { message?: string })?.message || "Something went wrong.";
  // The realms' own words (their panics), when the log made it through.
  if (/PoolFull|\bFull\b/.test(msg)) return "This market is full: challengers can stake at most 5× the creator's stake.";
  if (/NotInvited/.test(msg)) return "The creator has not approved this wallet to join this private claim.";
  if (/BadInvite/.test(msg)) return "Only the creator can change approvals for valid participant wallets on an open private claim.";
  if (/BettingClosed|ChallengeWindowClosed|\bLocked\b/.test(msg)) return "Staking has closed on this market.";
  if (/SelfChallenge/.test(msg)) return "You created this market: challengers take the other side.";
  if (/DisputeWindowClosed/.test(msg)) return "The dispute window has closed.";
  if (/NotAParticipant|NotParticipant/.test(msg)) return "Only someone with a stake in this market can do that.";
  if (/BadDeadline|DeadlineInPast|DeadlineTooFar/.test(msg)) return "Pick a deadline at least a few minutes and at most a year from now.";
  if (/AlreadyChallenged/.test(msg)) return "You already challenged this market.";
  if (/StakeTooSmall/.test(msg)) return "That stake is below the market's minimum.";
  if (/CapExceeded/.test(msg)) return "That stake is over the market's launch cap.";
  if (/Paused/.test(msg)) return "Staking is paused on this market for now. Your funds are safe; refunds stay open.";
  if (/insufficient (balance|allowance)|InsufficientBalance|InsufficientAllowance/i.test(msg)) return `Not enough ${chain.token.symbol} on ${chain.label} for this.`;
  if (/insufficient funds|insufficient coins|out of gas/i.test(msg)) return `Not enough ${chain.gas.symbol} on ${chain.label} to pay the gas.`;
  if (/SubUnit|precision|whole number of them/.test(msg)) return `${chain.token.symbol} has 6 decimals: use at most 6 digits after the point.`;
  return msg;
}

/** One wallet request at a time across every panel on the page (the stake box is mounted twice: sheet and sidebar). */
let sending = false;

export function useArcSend(account: ReturnType<typeof useArcAccount>) {
  const poke = useMutation(api.arc.poke);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<TxReceipt | null>(null);
  const { sendAction, chain, chainConfig, session } = account;

  const send = useCallback(
    async (action: MarketAction): Promise<TxReceipt | null> => {
      if (!session || sending) return null;
      sending = true;
      setBusy(true);
      setError(null);
      try {
        const r = await sendAction(action);
        setLast(r);
        // A short tap on phones that support it: the stake landed.
        navigator.vibrate?.(18);
        void poke({ chain }).catch(() => {});
        return r;
      } catch (err) {
        setError(describeSendError(err, chainConfig));
        return null;
      } finally {
        sending = false;
        setBusy(false);
      }
    },
    [session, sendAction, poke, chain, chainConfig],
  );

  return { send, busy, error, last, clearError: () => setError(null) };
}
