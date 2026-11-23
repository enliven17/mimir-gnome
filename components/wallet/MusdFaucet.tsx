"use client";

/**
 * The mUSD faucet (r/musd Faucet): 1,000 test mUSD once a day per address, sent from the connected Adena account.
 * Shows when the next drip opens (NextDrip) and refreshes balances after a drip through `onDripped`.
 */
import { useCallback, useEffect, useState } from "react";

import { sendWithWallet } from "@/components/wallet/useAdenaWallet";
import { isUserRejection } from "@/lib/gno/adena";
import { nextDripAt } from "@/lib/chains/client";
import { explorerUrl, MARKET_CHAINS } from "@/lib/chains/registry";
import { faucetMessage } from "@/lib/gno/msgs";

const chain = MARKET_CHAINS.chains.gno;

const when = (sec: number) =>
  new Date(sec * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

export default function MusdFaucet({ address, onDripped, className = "" }: { address: string; onDripped?: () => void; className?: string }) {
  /** Unix seconds the faucet opens again; 0 = now; null = unknown (the realm could not be read). */
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const read = useCallback(() => {
    nextDripAt(address).then(setNext, () => setNext(null));
  }, [address]);
  useEffect(read, [read]);

  const now = Math.floor(Date.now() / 1000);
  const waiting = next !== null && next > now;

  const drip = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendWithWallet([faucetMessage(address)]);
      setTx(r.txHash);
      onDripped?.();
      read();
    } catch (err) {
      setError(isUserRejection(err) ? "Cancelled in Adena." : err instanceof Error ? err.message : "The faucet did not pay out.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`grid gap-1.5 ${className}`}>
      <button
        type="button"
        data-menu-item
        disabled={busy || waiting}
        onClick={() => void drip()}
        className="press rounded-full bg-coral/15 px-4 py-2 text-left text-[13px] text-coral disabled:opacity-60"
      >
        {busy ? "Confirm in Adena…" : waiting ? `Next mUSD drip ${when(next)}` : "Get 1,000 test mUSD"}
      </button>
      {error ? <p role="alert" className="m-0 text-[12px] text-danger">{error}</p> : null}
      {tx ? (
        <a href={explorerUrl(chain, "tx", tx)} target="_blank" rel="noreferrer" className="text-[12px] text-coral hover:underline">
          mUSD sent · view on {chain.explorerName}
        </a>
      ) : null}
    </div>
  );
}
