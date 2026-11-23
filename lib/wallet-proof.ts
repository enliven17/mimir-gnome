/**
 * Wallet proof: a signed statement that the caller controls a gno.land address, so a server route can act for that
 * wallet (follows, access, invite codes).
 *
 * The browser signs `walletProofMessage` once with Adena (SignArbitrary, lib/owner.ts verifies it) and sends it on
 * requests as
 *
 *   x-mimir-wallet: <g1 address>
 *   x-mimir-proof:  <signedAt ms>.<base64url of the SignedArbitraryData JSON>
 *
 * It moves nothing and authorizes nothing else. It expires after WALLET_PROOF_TTL_MS. Pure and isomorphic.
 */

export const WALLET_PROOF_TTL_MS = 24 * 60 * 60 * 1000;
export const WALLET_HEADER = "x-mimir-wallet";
export const WALLET_PROOF_HEADER = "x-mimir-proof";

export function walletProofMessage(wallet: string, signedAt: number): string {
  return [
    "Mimir wallet proof",
    `wallet: ${wallet}`,
    `signedAt: ${signedAt}`,
    "This only proves you control this wallet. It moves no funds.",
  ].join("\n");
}

const toBase64Url = (s: string) =>
  (typeof Buffer !== "undefined" ? Buffer.from(s, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(s))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromBase64Url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    return typeof Buffer !== "undefined" ? Buffer.from(b64, "base64").toString("utf8") : decodeURIComponent(escape(atob(b64)));
  } catch {
    return null;
  }
}

/** `signature` is the signStatement result (a JSON string); headers carry it base64url-encoded. */
export function formatProofHeader(signedAt: number, signature: string): string {
  return `${signedAt}.${toBase64Url(signature)}`;
}

/** `{signedAt, signature}` (the JSON proof) from the header value, or null when malformed or expired. */
export function parseProofHeader(value: string | null | undefined, now = Date.now()): { signedAt: number; signature: string } | null {
  const m = /^(\d{12,14})\.([A-Za-z0-9_-]{16,20000})$/.exec((value ?? "").trim());
  if (!m) return null;
  const signedAt = Number(m[1]);
  // A little clock skew into the future is fine; a lot is not.
  if (signedAt > now + 5 * 60_000 || now - signedAt > WALLET_PROOF_TTL_MS) return null;
  const signature = fromBase64Url(m[2]);
  if (!signature?.startsWith("{")) return null;
  return { signedAt, signature };
}
