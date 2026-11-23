/**
 * The browser's wallet: Adena, through the API it injects as window.adena. The connected address is the user's
 * identity and market account. Every market action is ONE transaction of one or more MsgCall messages (an mUSD
 * approve and the call), signed and broadcast by Adena (DoContract).
 */
import type { AdenaWallet } from "@adena-wallet/sdk";

import { GNO, type GnoConfig } from "./config";
import type { GnoMsgCall } from "./msgs";

export class WalletError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
  }
}

export const ADENA_INSTALL_URL = "https://adena.app";

export function adena(): AdenaWallet | null {
  return typeof window !== "undefined" && window.adena ? window.adena : null;
}

function requireAdena(): AdenaWallet {
  const a = adena();
  if (!a) throw new WalletError("Install the Adena wallet to continue.", "NOT_INSTALLED");
  return a;
}

/** A refusal in the wallet: never a reason to retry another way. */
export const isUserRejection = (err: unknown) => {
  const e = err as { code?: unknown; type?: string; message?: string };
  return e?.code === 4000 || e?.code === 4001 || /TRANSACTION_REJECTED|SIGN_REJECTED|CONNECTION_REJECTED|rejected|denied/i.test(`${e?.type ?? ""} ${e?.message ?? ""}`);
};

/** Puts Adena on Mimir's network, adding it first if the wallet does not know it. */
export async function ensureNetwork(cfg: GnoConfig = GNO): Promise<void> {
  const a = requireAdena();
  const net = await a.GetNetwork();
  if (net.status === "success" && net.data.chainId === cfg.chainId) return;
  const sw = await a.SwitchNetwork(cfg.chainId);
  if (sw.status === "success" || sw.type === "REDUNDANT_CHANGE_REQUEST") return;
  if (sw.type === "UNADDED_NETWORK") {
    await a.AddNetwork({ chainId: cfg.chainId, chainName: cfg.chainName, rpcUrl: cfg.rpcUrl });
    const again = await a.SwitchNetwork(cfg.chainId);
    if (again.status === "success") return;
  }
  throw new WalletError(`Switch Adena to ${cfg.chainName} and try again.`, "WRONG_NETWORK");
}

/** Connects (asks the user once per site) and returns the account's address. */
export async function connectAdena(cfg: GnoConfig = GNO): Promise<string> {
  const a = requireAdena();
  const est = await a.AddEstablish("Mimir");
  if (est.status !== "success" && est.type !== "ALREADY_CONNECTED") throw new WalletError(est.message || "Connection refused", est.type);
  await ensureNetwork(cfg);
  return currentAddress();
}

export async function currentAddress(): Promise<string> {
  const acc = await requireAdena().GetAccount();
  if (acc.status !== "success" || !acc.data?.address) {
    throw new WalletError(acc.type === "WALLET_LOCKED" ? "Unlock Adena and try again." : "No Adena account connected.", acc.type);
  }
  return acc.data.address;
}

export interface TxReceipt {
  txHash: string;
  height?: number;
}

/** Sends the messages as one transaction and waits for it to be committed. Throws on a refusal or a failed call. */
export async function sendMessages(messages: GnoMsgCall[], cfg: GnoConfig = GNO, memo = ""): Promise<TxReceipt> {
  if (!messages.length) throw new Error("no messages to send");
  await ensureNetwork(cfg);
  const res = await requireAdena().DoContract({
    messages: messages as never,
    gasFee: cfg.gas.fee,
    gasWanted: cfg.gas.wanted,
    memo,
  });
  if (res.status !== "success") {
    const err = new WalletError(res.message || "The transaction failed", String(res.type));
    (err as unknown as { code: number }).code = res.code;
    throw err;
  }
  const data = res.data as unknown as { hash?: string; height?: string | number; deliver_tx?: { ResponseBase?: { Error?: unknown; Log?: string } } };
  const deliverError = data.deliver_tx?.ResponseBase?.Error;
  if (deliverError) throw new WalletError(cleanLog(data.deliver_tx?.ResponseBase?.Log ?? "The transaction failed"), "DELIVER_FAILED");
  return { txHash: data.hash ?? "", height: data.height !== undefined ? Number(data.height) : undefined };
}

/** The realm's panic message, e.g. "StakeTooSmall", out of an ABCI log. */
export function cleanLog(log: string): string {
  const m = /panic: ([^\n]+)/.exec(log) ?? /Msg Traces:\s*\n\s*\d+\s+\S+ - ([^\n]+)/.exec(log);
  return (m?.[1] ?? log.split("\n")[0]).trim();
}

/** A signed statement proving the connected account controls its address (verified by lib/owner.ts). */
export async function signStatement(address: string, message: string): Promise<string> {
  const a = requireAdena();
  if (!a.SignArbitrary) throw new WalletError("Update Adena to sign messages.", "UNSUPPORTED");
  const res = await a.SignArbitrary({ signer: address, data: message } as never);
  if (res.status !== "success") throw new WalletError(res.message || "Signature refused", String(res.type));
  return JSON.stringify(res.data);
}

/** Subscribes to account and network changes. */
export function onAdenaChange(cb: () => void): void {
  const a = adena();
  if (!a) return;
  a.On("changedAccount", cb);
  a.On("changedNetwork", cb);
}
