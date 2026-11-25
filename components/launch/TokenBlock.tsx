"use client";

/**
 * An agent's own token: a GRC20 its owner opens from their Adena account through gno.land's GRC20 factory
 * (lib/launch/token.ts). The owner sees a launch button until there is one; everyone sees the token once it exists.
 */
import { useState } from "react";

import { sendWithWallet } from "@/components/wallet/useAdenaWallet";
import { useMimirWallet } from "@/hooks/useMimirWallet";
import { tokenPage, type AgentToken } from "@/lib/launch/council-view";
import { signedPost } from "@/lib/launch/client";
import type { GnoMsgCall } from "@/lib/gno/msgs";

export default function TokenBlock({ slug, ticker, owner, status, token }: { slug?: string; ticker: string; owner: string | null; status: string; token?: AgentToken | null }) {
  const { address, signMessage } = useMimirWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<AgentToken | null>(token ?? null);
  const mine = !!owner && !!address && address === owner.toLowerCase();

  if (launched) {
    return (
      <section className="grid gap-1 rounded-2xl bg-cream/[0.04] p-5" aria-label={`$${ticker} token`}>
        <h2 className="m-0 font-display text-[1.4rem] text-cream">${ticker} token</h2>
        <p className="m-0 max-w-[62ch] text-[14px] text-muted">
          A GRC20 on gno.land, made with the GRC20 factory; its owner is the admin.{" "}
          <a href={tokenPage(launched)} target="_blank" rel="noreferrer" className="text-coral hover:underline">View on gnoweb</a>
        </p>
      </section>
    );
  }
  if (!mine || !slug || status === "killed" || !signMessage) return null;

  async function launch() {
    if (!address || !signMessage || !slug) return;
    setBusy(true);
    setError(null);
    try {
      const prep = await signedPost<{ messages: GnoMsgCall[] }>(`/api/launch/${slug}/token`, { owner: address, signMessage, action: "token", agent: slug, body: { step: "prepare" } });
      const r = await sendWithWallet(prep.messages);
      const rec = await signedPost<{ token: AgentToken }>(`/api/launch/${slug}/token`, { owner: address, signMessage, action: "token", agent: slug, body: { step: "record", tx: r.txHash } });
      setLaunched(rec.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The launch did not go through.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-2 rounded-2xl bg-cream/[0.04] p-5" aria-label={`$${ticker} token`}>
      <h2 className="m-0 font-display text-[1.4rem] text-cream">${ticker} token</h2>
      <p className="m-0 max-w-[62ch] text-[14px] text-muted">
        Optional: open ${ticker} as a GRC20 on gno.land from your own wallet. You become its admin; Mimir takes nothing. Your agent stakes mUSD either way.
      </p>
      <button type="button" className="btn-primary justify-self-start !w-auto !px-5" disabled={busy} onClick={() => void launch()}>
        {busy ? "Launching…" : `Launch $${ticker}`}
      </button>
      {error ? <p role="alert" className="m-0 text-[13px] text-danger">{error}</p> : null}
    </section>
  );
}
