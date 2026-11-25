/**
 * Committed transactions and blocks over the Tendermint JSON-RPC (fetch only, isomorphic): what a transaction did is
 * read from its events (gno `chain.Emit`), each tagged with the realm that emitted it. Used to verify payments (an
 * mUSD Transfer, an r/agentpay Paid event), to find the market id a create opened and by the indexer.
 *
 * Hashes are hex (what gno-js-client returns and gnoweb links use); base64 is accepted too.
 */
import { base64, hex as hexCodec } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";

import { GNO, type GnoConfig } from "./config";

export interface GnoEvent {
  type: string;
  pkgPath: string;
  attrs: Record<string, string>;
}

export interface GnoTx {
  hash: string;
  height: number;
  index: number;
  ok: boolean;
  error: string | null;
  events: GnoEvent[];
}

type RawEvent = { type?: string; pkg_path?: string; attrs?: Array<{ key?: string; value?: string }> | null };
type RawResponseBase = { Error?: unknown; Events?: RawEvent[] | null; Log?: string };

export class GnoRpcError extends Error {}

async function rpc<T>(method: string, params: Record<string, unknown>, cfg: GnoConfig, signal?: AbortSignal): Promise<T> {
  const res = await fetch(cfg.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: signal ?? AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new GnoRpcError(`gno RPC ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string; data?: string } };
  if (body.error) throw new GnoRpcError(body.error.data || body.error.message || "gno RPC error");
  if (body.result === undefined) throw new GnoRpcError("gno RPC: empty result");
  return body.result;
}

/** A 32-byte tx hash as lowercase hex, from hex (0x optional) or base64; null when it is neither. */
export function normalizeTxHash(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) return v.replace(/^0x/, "").toLowerCase();
  if (/^[A-Za-z0-9+/]{43}=$/.test(v)) {
    try {
      const hex = hexCodec.encode(base64.decode(v));
      return hex.length === 64 ? hex : null;
    } catch {
      return null;
    }
  }
  return null;
}

const hexToB64 = (hex: string) => base64.encode(hexCodec.decode(hex));

/** The events of a deliver-tx result, flattened. */
export function eventsOf(base: RawResponseBase | null | undefined): GnoEvent[] {
  return (base?.Events ?? []).map((e) => ({
    type: e.type ?? "",
    pkgPath: e.pkg_path ?? "",
    attrs: Object.fromEntries((e.attrs ?? []).map((a) => [a.key ?? "", a.value ?? ""])),
  }));
}

/** The parsed `tx` RPC result (pure, for tests). */
export function parseTxResult(r: { hash: string; height: string | number; index?: number; tx_result: { ResponseBase: RawResponseBase } }): GnoTx {
  const base = r.tx_result?.ResponseBase;
  const error = base?.Error ? String(base.Log ?? "failed").split("\n")[0] : null;
  return {
    hash: normalizeTxHash(r.hash) ?? String(r.hash),
    height: Number(r.height),
    index: Number(r.index ?? 0),
    ok: !error,
    error,
    events: error ? [] : eventsOf(base),
  };
}

/** A committed transaction, or null when the node does not know it (yet). */
export async function gnoTx(hash: string, cfg: GnoConfig = GNO): Promise<GnoTx | null> {
  const hex = normalizeTxHash(hash);
  if (!hex) throw new GnoRpcError("bad transaction hash");
  try {
    return parseTxResult(await rpc("tx", { hash: hexToB64(hex) }, cfg));
  } catch (err) {
    if (err instanceof GnoRpcError && /not found|no transaction|could not find/i.test(err.message)) return null;
    throw err;
  }
}

/** A block's time (unix seconds) and its transactions' hashes (hex, in order). */
export async function gnoBlock(height: number, cfg: GnoConfig = GNO): Promise<{ height: number; time: number; txs: string[] }> {
  const r = await rpc<{ block: { header: { time: string }; data: { txs: string[] | null } } }>("block", { height: String(height) }, cfg);
  const txs = (r.block.data.txs ?? []).map((t) => hexCodec.encode(sha256(base64.decode(t))));
  return { height, time: Math.floor(Date.parse(r.block.header.time) / 1000), txs };
}

/** Every transaction result in a block (same order as gnoBlock's txs). */
export async function gnoBlockResults(height: number, cfg: GnoConfig = GNO): Promise<Array<{ ok: boolean; events: GnoEvent[] }>> {
  const r = await rpc<{ results: { deliver_tx: Array<{ ResponseBase: RawResponseBase }> | null } }>("block_results", { height: String(height) }, cfg);
  return (r.results.deliver_tx ?? []).map((d) => ({ ok: !d.ResponseBase?.Error, events: d.ResponseBase?.Error ? [] : eventsOf(d.ResponseBase) }));
}

/** The events of `type` that realm `pkgPath` emitted. */
export const eventsFrom = (tx: Pick<GnoTx, "events">, pkgPath: string, type: string) =>
  tx.events.filter((e) => e.pkgPath === pkgPath && e.type === type);
