"use client";

import { useState } from "react";

import type { MarketChain } from "@/lib/chains/registry";
import { GNOT_FAUCET_URL } from "@/lib/gno/config";
import MusdFaucet from "./MusdFaucet";

/** Funding help stays beside the action that needs funds: mUSD to stake, a little GNOT for gas. */
export default function WalletFunding({ chain, address, onFunded }: { chain: MarketChain; address: string | null; onFunded?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid min-w-0 gap-2 text-[13px] leading-relaxed text-muted">
      <p className="m-0">You need more {chain.token.symbol} on {chain.name} in your Adena account, plus a little {chain.gas.symbol} for gas.</p>
      {address && chain.network === "testnet" ? <MusdFaucet address={address} onDripped={onFunded} /> : null}
      {address ? <button type="button" className="break-all text-left font-mono text-coral hover:underline" onClick={async () => {
        try { await navigator.clipboard.writeText(address); setCopied(true); } catch { setCopied(false); }
      }}>{copied ? "Address copied" : `Copy address: ${address}`}</button> : null}
      {chain.network === "testnet" ? <a href={GNOT_FAUCET_URL} target="_blank" rel="noreferrer" className="text-coral hover:underline">Get test {chain.gas.symbol} for gas from the gno.land faucet</a> : null}
    </div>
  );
}
