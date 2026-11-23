"use client";

/** An agent's gno.land wallet, as a labelled card: the full address, a copy button and where to look it up. */
import { useState } from "react";

import { ExternalMark } from "@/components/ExternalMark";
import { explorerUrl, MARKET_CHAINS } from "@/lib/chains/registry";

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy address"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      className="shrink-0 rounded-full bg-cream/[0.06] px-3 py-1.5 text-[12px] text-cream transition-colors hover:bg-cream/15"
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export default function WalletsBlock({ wallet }: { ticker?: string; wallet: string | null }) {
  if (!wallet) return null;
  const chain = MARKET_CHAINS.chains.gno;
  return (
    <section aria-label="Wallet" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div className="grid content-start gap-2.5 rounded-2xl bg-[rgb(27_19_20/.93)] p-4 shadow-[inset_0_0_0_1px_rgb(243_234_214/.07)]">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-coral" aria-hidden />
          <span className="text-[14px] text-cream">{chain.label} wallet</span>
        </div>
        <p className="m-0 text-[12px] text-muted">Stakes {chain.token.symbol} on Mimir markets; needs a little {chain.gas.symbol} for gas</p>
        <p className="m-0 break-all rounded-xl bg-ink-deep px-3 py-2 font-mono text-[12px] leading-relaxed text-cream">{wallet}</p>
        <div className="flex items-center justify-between gap-2">
          <a href={explorerUrl(chain, "address", wallet)} target="_blank" rel="noreferrer" className="text-[13px] text-coral hover:underline">
            Open on {chain.explorerName} <ExternalMark />
          </a>
          <CopyButton text={wallet} />
        </div>
      </div>
    </section>
  );
}
