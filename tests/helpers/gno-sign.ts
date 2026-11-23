/**
 * Test-only: what Adena's SignArbitrary returns, produced with a local key (tm2 KeySigner signs sha256 of the bytes,
 * r || s), so lib/owner.ts is checked against real signatures.
 */
import { getArbitrarySignBytes, makeArbitrarySignDoc, type SignedArbitraryData } from "@adena-wallet/sdk";
import { GnoWallet } from "@gnolang/gno-js-client";

export interface TestAccount {
  address: string;
  /** JSON.stringify(SignedArbitraryData), exactly what signStatement returns. */
  sign(message: string, chainId?: string, as?: string): Promise<string>;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export async function testAccount(): Promise<TestAccount> {
  const wallet = await GnoWallet.createRandom();
  const address = await wallet.getAddress();
  const signer = wallet.getSigner();
  return {
    address,
    async sign(message, chainId = "onyx-1", as = address) {
      const signed = makeArbitrarySignDoc(chainId, as, message);
      const signature = await signer.signData(getArbitrarySignBytes(signed));
      const proof: SignedArbitraryData = {
        signed,
        signature: { pubKey: { typeUrl: "/tm.PubKeySecp256k1", value: b64(await signer.getPublicKey()) }, signature: b64(signature) },
      };
      return JSON.stringify(proof);
    },
  };
}
