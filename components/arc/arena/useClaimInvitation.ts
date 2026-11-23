"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readClaimInvitation } from "@/lib/chains/invites";
import type { MarketChain } from "@/lib/chains/registry";

/** Live, fail-closed permissions. A stale read can never describe a different wallet/claim/chain. */
export function useClaimInvitation(cfg: MarketChain, marketId: number, wallet: string | null, enabled: boolean) {
  const key = enabled && wallet && marketId > 0 ? `${cfg.id}:${cfg.chainId}:${cfg.realms.vs}:${marketId}:${wallet.toLowerCase()}` : null;
  const current = useRef(key);
  current.current = key;
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string; allowed: boolean | null; error: boolean } | null>(null);

  const checkNow = useCallback(async (): Promise<boolean> => {
    if (!key || !wallet || current.current !== key) return false;
    const request = ++sequence.current;
    setState({ key, allowed: null, error: false });
    try {
      const allowed = await readClaimInvitation(marketId, wallet, cfg.gno);
      if (current.current !== key || sequence.current !== request) return false;
      setState({ key, allowed, error: false });
      return allowed;
    } catch {
      if (current.current === key && sequence.current === request) setState({ key, allowed: null, error: true });
      return false;
    }
  }, [key, wallet, cfg, marketId]);

  useEffect(() => {
    if (!key) return;
    void checkNow();
    const refresh = () => { void checkNow(); };
    const timer = setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => { ++sequence.current; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [key, checkNow]);

  const live = key && state?.key === key ? state : null;
  return { allowed: live?.allowed ?? null, checked: live?.allowed !== undefined && live?.allowed !== null, error: live?.error ?? false, checkNow };
}
