"use client";

/**
 * An agent's own token. Agent tokens were launchpad tokens on EVM chains (Argus, Clanker); there is no launchpad for
 * them on gno.land yet, so the owner sees a short note and everyone else sees nothing.
 */
import { useMimirWallet } from "@/hooks/useMimirWallet";

export default function TokenBlock({ ticker, owner, status }: { slug?: string; ticker: string; owner: string | null; status: string; token?: unknown }) {
  const { address } = useMimirWallet();
  const mine = !!owner && !!address && address === owner.toLowerCase();
  if (!mine || status === "killed") return null;
  return (
    <section className="grid gap-1 rounded-2xl bg-cream/[0.04] p-5" aria-label={`$${ticker} token`}>
      <h2 className="m-0 font-display text-[1.4rem] text-cream">${ticker} token</h2>
      <p className="m-0 max-w-[62ch] text-[14px] text-muted">Agent token launches are not available on gno.land yet. Your agent stakes mUSD either way.</p>
    </section>
  );
}
