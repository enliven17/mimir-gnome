/**
 * Server-side signing for keys Mimir runs itself: the oracle, the arbiter, the house and council wallets and hosted
 * agents. A key is a BIP-39 mnemonic (gnokey's default derivation); it never reaches the browser.
 *
 * Server code only (Next routes, Convex node actions, scripts): never import it from a client component.
 *
 * send signs the messages as ONE transaction and waits for it to commit, so an approve and its call land together.
 */
import { decodeTxMessages, GnoJSONRPCProvider, GnoWallet, MsgCall } from "@gnolang/gno-js-client";
import { TransactionEndpoint } from "@gnolang/tm2-js-client";

import { GNO, type GnoConfig } from "./config";
import type { GnoMsgCall } from "./msgs";
import { gnoTx, type GnoEvent } from "./tx";

export interface SentTx {
  txHash: string;
  height: number;
  /** What the transaction emitted (lib/gno/tx.ts), e.g. the id a create opened. */
  events: GnoEvent[];
}

export interface GnoSigner {
  address: string;
  send(messages: GnoMsgCall[], memo?: string): Promise<SentTx>;
  /** A native GNOT transfer (gas money), ugnot. */
  sendUgnot(to: string, ugnot: bigint): Promise<SentTx>;
}

type CommitResult = { hash: string; height: string };
/** The committed tx with its events, re-read through the `tx` RPC (the broadcast reply's event encoding is the SDK's own). */
async function sent(r: CommitResult, cfg: GnoConfig): Promise<SentTx> {
  const txHash = r.hash.toLowerCase();
  const tx = await gnoTx(txHash, cfg).catch(() => null);
  return { txHash, height: Number(r.height), events: tx?.events ?? [] };
}

const wallets = new Map<string, Promise<GnoWallet>>();

async function walletFor(mnemonic: string, cfg: GnoConfig): Promise<GnoWallet> {
  const key = `${cfg.rpcUrl}|${mnemonic}`;
  let w = wallets.get(key);
  if (!w) {
    w = (async () => {
      const wallet = await GnoWallet.fromMnemonic(mnemonic.trim());
      wallet.connect(await GnoJSONRPCProvider.create(cfg.rpcUrl));
      return wallet;
    })();
    wallets.set(key, w);
    w.catch(() => wallets.delete(key));
  }
  return w;
}

/** A signer for one mnemonic. The messages' `caller` is overwritten with the signer's address. */
export async function gnoSigner(mnemonic: string, cfg: GnoConfig = GNO): Promise<GnoSigner> {
  const wallet = await walletFor(mnemonic, cfg);
  const address = await wallet.getAddress();
  return {
    address,
    async send(messages, memo = "") {
      if (!messages.length) throw new Error("no messages to send");
      const tx = {
        messages: messages.map((m) => ({
          type_url: "/vm.m_call",
          value: MsgCall.encode({ ...m.value, caller: address, args: m.value.args }).finish(),
        })),
        fee: { gas_wanted: BigInt(cfg.gas.wanted), gas_fee: `${cfg.gas.fee}ugnot` },
        memo,
        signatures: [],
      };
      const signed = await wallet.signTransaction(tx as never, decodeTxMessages);
      return sent((await wallet.sendTransaction(signed, TransactionEndpoint.BROADCAST_TX_COMMIT)) as unknown as CommitResult, cfg);
    },
    async sendUgnot(to, ugnot) {
      if (ugnot <= 0n) throw new Error("Invalid amount");
      const res = await wallet.transferFunds(to, new Map([["ugnot", Number(ugnot)]]), TransactionEndpoint.BROADCAST_TX_COMMIT, {
        gas_wanted: BigInt(cfg.gas.wanted),
        gas_fee: `${cfg.gas.fee}ugnot`,
      } as never);
      return sent(res as unknown as CommitResult, cfg);
    },
  };
}

/** The signer configured in env var `name` (a mnemonic), or null when unset. */
export async function envSigner(name: string, cfg: GnoConfig = GNO): Promise<GnoSigner | null> {
  const m = process.env[name]?.trim();
  return m ? gnoSigner(m, cfg) : null;
}
