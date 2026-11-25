/**
 * gno.land keys without the SDK: a BIP-39 mnemonic, gnokey's default derivation (m/44'/118'/0'/0/0, secp256k1) and the
 * bech32 "g1" address of the compressed public key (ripemd160(sha256(pub))). Pure JS, so it runs in every Convex
 * runtime and the browser; tests/node/gno-keys.test.ts pins it against gno-js-client's GnoWallet.
 */
import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";

export const GNO_HD_PATH = "m/44'/118'/0'/0/0";

/** A fresh 24-word mnemonic. */
export const newMnemonic = (): string => generateMnemonic(wordlist, 256);

export const isMnemonic = (m: string): boolean => validateMnemonic(m.trim().replace(/\s+/g, " "), wordlist);

/** The g1 address of a compressed secp256k1 public key. */
export function addressFromPubKey(pub: Uint8Array): string {
  return bech32.encode("g", bech32.toWords(ripemd160(sha256(pub))));
}

/** The g1 address gnokey derives from `mnemonic` (account 0, index 0). Throws on an invalid mnemonic. */
export function addressFromMnemonic(mnemonic: string): string {
  const m = mnemonic.trim().replace(/\s+/g, " ");
  if (!validateMnemonic(m, wordlist)) throw new Error("invalid mnemonic");
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(m)).derive(GNO_HD_PATH);
  if (!key.publicKey) throw new Error("no public key");
  return addressFromPubKey(key.publicKey);
}
