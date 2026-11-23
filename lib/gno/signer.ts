/**
 * Server-side signing for keys Mimir runs itself: the oracle, the arbiter, the house and council wallets and hosted
 * agents. A key is a BIP-39 mnemonic (gnokey's default derivation); it never reaches the browser.
 *
 * sendAs signs the messages as ONE transaction and waits for it to commit, so an approve and its call land together.
 */
import "server-only";

import { decodeTxMessages, GnoJSONRPCProvider, GnoWallet, MsgCall } from "@gnolang/gno-js-client";
import { TransactionEndpoint } from "@gnolang/tm2-js-client";

import { GNO, type GnoConfig } from "./config";
import type { GnoMsgCall } from "./msgs";

export interface GnoSigner {
  address: string;
  send(messages: GnoMsgCall[], memo?: string): Promise<{ txHash: string; height: number }>;
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
      const res = (await wallet.sendTransaction(signed, TransactionEndpoint.BROADCAST_TX_COMMIT)) as unknown as {
        hash: string;
        height: string;
      };
      return { txHash: res.hash, height: Number(res.height) };
    },
  };
}

/** The signer configured in env var `name` (a mnemonic), or null when unset. */
export async function envSigner(name: string, cfg: GnoConfig = GNO): Promise<GnoSigner | null> {
  const m = process.env[name]?.trim();
  return m ? gnoSigner(m, cfg) : null;
}
