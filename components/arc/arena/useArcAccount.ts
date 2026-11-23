"use client";

/**
 * The connected Adena account as a market account on gno.land: its mUSD in index units (18 dp,
 * lib/chains/amounts.ts; null = not known yet), its GNOT for gas (ugnot) and its entry fee as r/fees has it (0.5% by
 * default). `sendAction` runs lib/chains/send.ts: an exact mUSD Approve in the same transaction when the allowance
 * falls short, and the no-GNOT check before Adena opens.
 */
import { useCallback, useEffect, useState } from "react";

import { useMimirWallet } from "@/hooks/useMimirWallet";
import { ENTRY_FEE_BPS } from "@/lib/arc/fees";
import type { MarketAction } from "@/lib/chains/calls";
import { entryBpsOf, gasBalanceUgnot, musdAllowanceWei, musdBalanceWei } from "@/lib/chains/client";
import { MARKET_CHAINS, marketChain, type MarketChainId } from "@/lib/chains/registry";
import { sendMarketAction } from "@/lib/chains/send";
import { sendWithWallet } from "@/components/wallet/useAdenaWallet";

export function useArcAccount(chain: MarketChainId = MARKET_CHAINS.defaultChain) {
  const wallet = useMimirWallet();
  const address = wallet.address;
  const cfg = marketChain(chain);
  /** The market session: the connected account, when there is one. */
  const session = address && cfg.enabled ? { address } : null;
  const [balance, setBalance] = useState<bigint | null>(null);
  const [gas, setGas] = useState<bigint | null>(null);
  const [onchainBps, setOnchainBps] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!address || !cfg.enabled) {
      setBalance(null);
      setGas(null);
      setOnchainBps(null);
      return;
    }
    const [wei, ugnot, bps] = await Promise.all([
      musdBalanceWei(address, cfg.gno).catch(() => null),
      gasBalanceUgnot(address, cfg.gno).catch(() => null),
      entryBpsOf(address, cfg.gno).catch(() => null),
    ]);
    // A failed read stays unknown rather than zero.
    setBalance(wei);
    setGas(ugnot);
    setOnchainBps(bps);
  }, [address, cfg]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 20_000);
    return () => clearInterval(t);
  }, [reload]);

  const entryBps = onchainBps ?? ENTRY_FEE_BPS;

  /** One market action from the account: one transaction, with an mUSD Approve in front when needed. */
  const sendAction = useCallback(
    async (action: MarketAction) => {
      if (!address) throw new Error("Connect your wallet first.");
      return sendMarketAction(cfg, address, action, {
        allowance: (owner, kind) => musdAllowanceWei(owner, kind, cfg.gno),
        gasBalance: (owner) => gasBalanceUgnot(owner, cfg.gno),
        send: (messages) => sendWithWallet(messages),
      });
    },
    [address, cfg],
  );

  return { wallet, chain, chainConfig: cfg, session, address, balance, gas, reload, entryBps, sendAction };
}
