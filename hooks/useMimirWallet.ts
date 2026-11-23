"use client";

/**
 * The one place UI code reads the wallet: the connected Adena account (components/wallet/useAdenaWallet.ts) on
 * gno.land. Its g1 address is the user's identity everywhere on Mimir. `signMessage` is Adena SignArbitrary and returns
 * the JSON proof lib/owner.ts verifies; null while nothing is connected.
 */
import { useCallback } from "react";

import { connectWallet, disconnectWallet, signWithWallet, useAdenaAccount } from "@/components/wallet/useAdenaWallet";
import { GNO } from "@/lib/gno/config";

export interface MimirWallet {
  address: string | null;
  connected: boolean;
  connecting: boolean;
  /** Adena is installed in this browser. */
  installed: boolean;
  networkName: string;
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  signMessage: ((message: string) => Promise<string>) | null;
}

export function useMimirWallet(): MimirWallet {
  const a = useAdenaAccount();
  const address = a.address;
  const sign = useCallback((message: string) => {
    if (!address) return Promise.reject(new Error("Connect your wallet first."));
    return signWithWallet(address, message);
  }, [address]);
  return {
    address,
    connected: Boolean(address),
    connecting: a.connecting,
    installed: a.installed,
    networkName: GNO.chainName,
    connect: connectWallet,
    disconnect: disconnectWallet,
    signMessage: address ? sign : null,
  };
}
