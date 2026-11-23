"use client";

/**
 * The browser's one wallet connection: Adena (window.adena, lib/gno/adena.ts). The connected gno.land address is the
 * user's identity and market account. Module state shared by every component through useSyncExternalStore:
 * connecting asks Adena once per site; a reload restores the account silently when the site was connected before.
 * Adena has no disconnect call: disconnecting forgets the account here, and the next connect asks again only if the
 * user revoked the site in Adena.
 */
import { useSyncExternalStore } from "react";

import { adena, connectAdena, currentAddress, ensureNetwork, onAdenaChange, sendMessages, signStatement, WalletError, type TxReceipt } from "@/lib/gno/adena";
import type { GnoMsgCall } from "@/lib/gno/msgs";

export interface AdenaAccount {
  address: string | null;
  connecting: boolean;
  /** window.adena is present (false during SSR and before the first client read). */
  installed: boolean;
}

/** Set while the site holds a connection, so a reload restores it without a prompt. */
const CONNECTED_KEY = "mimir:adena-connected";
/** Keys from the EVM wallet: only cleaned up. */
const LEGACY_KEYS = ["mimir:evm-connected", "mimir:evm-intent", "mimir:evm-wallet", "mimir.robinhood.via", "mimir:entry-mode"];

const NO_ACCOUNT: AdenaAccount = { address: null, connecting: false, installed: false };
let account: AdenaAccount = NO_ACCOUNT;
const listeners = new Set<() => void>();
let loaded = false;

function storage(write?: boolean): boolean {
  try {
    if (write === true) localStorage.setItem(CONNECTED_KEY, "1");
    else if (write === false) localStorage.removeItem(CONNECTED_KEY);
    return localStorage.getItem(CONNECTED_KEY) === "1";
  } catch {
    return false; // storage blocked: no restore on reload
  }
}

function set(next: Partial<AdenaAccount>) {
  const prev = account.address;
  account = { ...account, ...next };
  listeners.forEach((l) => l());
  // A stored wallet proof (useWalletProof) belongs to the old address.
  if ("address" in next && next.address !== prev && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("mimir-wallet-changed", { detail: next.address }));
  }
}

/** Re-reads the account Adena has selected; a locked or revoked wallet reads as disconnected. */
async function refresh() {
  if (!storage()) return;
  const address = await currentAddress().catch(() => null);
  set({ address, installed: Boolean(adena()) });
}

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
  const start = () => {
    account = { ...account, installed: Boolean(adena()) };
    listeners.forEach((l) => l());
    if (!adena()) return;
    onAdenaChange(() => void refresh());
    void refresh();
  };
  // Adena injects at document start; a late injection still gets a second look once the page has loaded.
  if (adena() || document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

/** The live Adena account, shared by every component. */
export const useAdenaAccount = () =>
  useSyncExternalStore(
    (l) => {
      load();
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => account,
    () => NO_ACCOUNT,
  );

/** The live account's address, outside React. */
export const currentAdenaAddress = () => account.address;

/** Asks Adena to connect this site (and switch to Mimir's network); resolves with the address. */
export async function connectWallet(): Promise<string> {
  if (account.connecting) throw new WalletError("A wallet connection is already open.");
  if (!adena()) throw new WalletError("Install the Adena wallet to continue.", "NOT_INSTALLED");
  set({ connecting: true, installed: true });
  try {
    const address = await connectAdena();
    storage(true);
    set({ address });
    return address;
  } finally {
    set({ connecting: false });
  }
}

/** Forgets the account on this site. */
export async function disconnectWallet(): Promise<void> {
  storage(false);
  set({ address: null });
}

function requireAccount(address?: string): string {
  const now = account.address;
  if (!now) throw new WalletError("Connect your wallet first.");
  if (address && now !== address) throw new WalletError(`Switch Adena back to ${address}, or reconnect.`);
  return now;
}

/** A SignArbitrary proof (JSON) of `message` by the connected account, on Mimir's network. */
export async function signWithWallet(address: string, message: string): Promise<string> {
  requireAccount(address);
  await ensureNetwork();
  return signStatement(address, message);
}

/** The messages as ONE transaction from the connected account (Adena DoContract). */
export async function sendWithWallet(messages: GnoMsgCall[], memo = ""): Promise<TxReceipt> {
  const caller = requireAccount();
  if (messages.some((m) => m.value.caller !== caller)) throw new WalletError(`Switch Adena back to ${messages[0]?.value.caller}, or reconnect.`);
  return sendMessages(messages, undefined, memo);
}
