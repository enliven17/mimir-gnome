"use client";

/**
 * Copy an agent's market stakes from its page: set a cap per stake, fund the copy wallet (a gno.land account Mimir
 * runs for you: mUSD to stake, a little GNOT for gas), stop, withdraw. Every change is signed in Adena.
 */
import { useCallback, useEffect, useState } from "react";

import { ExternalMark } from "@/components/ExternalMark";
import { sendWithWallet } from "@/components/wallet/useAdenaWallet";
import { useMimirWallet } from "@/hooks/useMimirWallet";
import { usdToIndex } from "@/lib/chains/amounts";
import { explorerUrl, MARKET_CHAINS } from "@/lib/chains/registry";
import { transferMessage } from "@/lib/gno/msgs";
import { signedPost } from "@/lib/launch/client";
import { trackProductEvent } from "@/lib/product-analytics";

type CopyWalletStatus = { address: string; on: boolean; maxPerStakeUsdc: number; balanceUsdc: number | null; balanceGnot?: number | null };

type Status = {
  can: boolean;
  sub: null | {
    active: boolean;
    pausedReason: string | null;
    /** The copy wallet on gno.land. `arc` / `base` are the backend's legacy per-chain keys, read until it is ported. */
    gno?: null | CopyWalletStatus;
    arc?: null | CopyWalletStatus;
    base?: null | CopyWalletStatus;
  };
};

const chain = MARKET_CHAINS.chains.gno;
const walletOf = (sub: Status["sub"]) => sub?.gno ?? sub?.base ?? sub?.arc ?? null;

export default function CopyPanel({ slug, ticker }: { slug: string; ticker: string }) {
  const { address, signMessage } = useMimirWallet();
  const owner = address ?? null;
  const [st, setSt] = useState<Status | null>(null);
  const [maxStake, setMaxStake] = useState("2");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!owner) return;
    const res = await fetch(`/api/launch/${slug}/copy?follower=${owner}`).catch(() => null);
    if (!res?.ok) return;
    const s = (await res.json()) as Status;
    setSt(s);
    const w = walletOf(s.sub);
    if (w) setMaxStake(String(w.maxPerStakeUsdc));
  }, [owner, slug]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!owner || !st?.sub?.active || !((walletOf(st.sub)?.balanceUsdc ?? 0) > 0)) return;
    try { const key = `mimir.copy-funded:${owner}:${slug}`; if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); trackProductEvent("copy_funded", { mode: "live" }); } catch { /* Analytics never block copying. */ }
  }, [owner, slug, st]);

  if (!owner || !signMessage || !st || !st.can) return null;

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await fn());
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  const save = (active: boolean) =>
    act(async () => {
      const cap = { on: active, maxPerStakeUsdc: Number(maxStake) || 0.1 };
      await signedPost(`/api/launch/${slug}/copy`, { owner, signMessage, action: "copy", agent: slug, body: { active, [chain.id]: cap } });
      if (active && !st.sub?.active) trackProductEvent("copy_started", { mode: "live" });
      return active ? "Copying. Fund your copy wallet below." : "Stopped: no new copies. Open stakes settle on their own.";
    });
  const sub = st.sub;
  const wallet = walletOf(sub);

  return (
    <section className="grid gap-5 rounded-2xl bg-[rgb(27_19_20/.93)] p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="m-0 font-display text-[1.5rem] leading-none text-cream">Copy ${ticker}</h2>
          <p className="m-0 max-w-[60ch] text-[13px] text-muted">Its market stakes, from a {chain.label} wallet of your own, up to your cap. Same market, same side. Stop and withdraw any time.</p>
        </div>
        {sub ? (
          <span className={`rounded-full px-3 py-1 text-[12px] ${sub.active ? "bg-emerald-400/10 text-emerald-300" : "bg-cream/[0.06] text-muted"}`}>
            {sub.active ? "Copying" : sub.pausedReason ? `Paused: ${sub.pausedReason}` : "Stopped"}
          </span>
        ) : null}
      </div>

      <label className="grid max-w-xs gap-1.5">
        <span className="text-[12px] text-muted">Most per stake</span>
        <span className="flex items-center gap-2">
          <input className="input font-mono" inputMode="decimal" value={maxStake} onChange={(e) => setMaxStake(e.target.value)} />
          <span className="shrink-0 text-[13px] text-muted">{chain.token.symbol}</span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-4">
        <button type="button" disabled={busy} className="btn-primary !min-h-[44px] !w-auto !px-6 !py-2 !text-[15px]" onClick={() => void save(true)}>
          {sub?.active ? "Save changes" : "Start copying"}
        </button>
        {sub?.active ? (
          <button type="button" disabled={busy} className="text-[14px] text-coral hover:underline" onClick={() => void save(false)}>
            Stop copying
          </button>
        ) : null}
      </div>

      {wallet ? (
        <CopyWallet
          wallet={wallet}
          busy={busy}
          onFund={(n) =>
            act(async () => {
              const r = await sendWithWallet([transferMessage(owner, wallet.address, usdToIndex(n), chain.gno)]);
              return `Sent ${n} ${chain.token.symbol} to your copy wallet (${r.txHash.slice(0, 10)}…).`;
            })
          }
          onWithdraw={(n) =>
            act(async () => {
              const r = await signedPost<{ tx: string }>(`/api/launch/${slug}/copy/withdraw`, { owner, signMessage, action: "copy-withdraw", agent: slug, body: { amount: n, chain: chain.id } });
              return `Sent to you (${r.tx.slice(0, 10)}…).`;
            })
          }
        />
      ) : null}
      {note ? <p role="status" className="m-0 text-[14px] text-cream">{note}</p> : null}
    </section>
  );
}

/** The copy wallet: its balances, its address, funding it from Adena and a withdrawal back to you. */
function CopyWallet({
  wallet,
  busy,
  onFund,
  onWithdraw,
}: {
  wallet: CopyWalletStatus;
  busy: boolean;
  onFund: (n: number) => Promise<void>;
  onWithdraw: (n: number) => Promise<void>;
}) {
  const [fund, setFund] = useState("");
  const [amount, setAmount] = useState("");
  const token = chain.token.symbol;
  return (
    <div className="grid gap-3 border-t border-cream/10 pt-5">
      <h3 className="m-0 text-[15px] text-cream">Your copy wallet on {chain.label}</h3>
      <div className="grid gap-2 rounded-xl bg-ink-deep/70 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] text-cream">On {chain.label}</span>
          <span className="font-mono text-[13px] tabular-nums text-cream">
            {wallet.balanceUsdc?.toFixed(2) ?? "?"} {token}
            {wallet.balanceGnot != null ? ` · ${wallet.balanceGnot.toFixed(3)} ${chain.gas.symbol}` : ""}
          </span>
        </div>
        <p className="m-0 break-all font-mono text-[12px] leading-relaxed text-muted">{wallet.address}</p>
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-dim">Send {token} and a little {chain.gas.symbol} (gas)</span>
          <span className="flex items-center gap-3">
            <button type="button" className="text-cream hover:text-coral" onClick={() => void navigator.clipboard?.writeText(wallet.address)}>
              Copy
            </button>
            <a href={explorerUrl(chain, "address", wallet.address)} target="_blank" rel="noreferrer" className="text-coral hover:underline">
              {chain.explorerName} <ExternalMark />
            </a>
          </span>
        </div>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(fund);
          if (!(n > 0)) return;
          void onFund(n).then(() => setFund(""));
        }}
      >
        <span className="text-[13px] text-muted">Fund</span>
        <input className="input !w-28 font-mono" inputMode="decimal" placeholder="0.00" value={fund} onChange={(e) => setFund(e.target.value)} aria-label={`Amount in ${token} to send`} />
        <span className="text-[13px] text-muted">{token}</span>
        <button type="submit" disabled={busy} className="rounded-full bg-cream/[0.08] px-4 py-2 text-[14px] text-cream hover:bg-cream/15">
          Send from Adena
        </button>
      </form>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(amount);
          if (!(n > 0)) return;
          void onWithdraw(n).then(() => setAmount(""));
        }}
      >
        <span className="text-[13px] text-muted">Withdraw</span>
        <input className="input !w-28 font-mono" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`Amount in ${token} to withdraw`} />
        <span className="text-[13px] text-muted">{token}</span>
        <button type="submit" disabled={busy} className="rounded-full bg-cream/[0.08] px-4 py-2 text-[14px] text-cream hover:bg-cream/15">
          Withdraw
        </button>
      </form>
    </div>
  );
}
