/**
 * Read-only gno.land RPC: ABCI queries over JSON-RPC with fetch, no SDK. Isomorphic.
 *
 *   qeval    evaluates an expression in a realm: "(value type)" lines, one per return value
 *   qrender  a realm's Render(path) markdown
 *   bank     an address's native balance
 */
import { GNO, type GnoConfig } from "./config";

export class GnoQueryError extends Error {
  constructor(message: string, public readonly log?: string) {
    super(message);
  }
}

const b64 = (s: string) =>
  typeof Buffer !== "undefined" ? Buffer.from(s, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(s)));
const unb64 = (s: string) =>
  typeof Buffer !== "undefined" ? Buffer.from(s, "base64").toString("utf8") : decodeURIComponent(escape(atob(s)));

export async function abciQuery(path: string, data: string, cfg: GnoConfig = GNO, signal?: AbortSignal): Promise<string> {
  const res = await fetch(cfg.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "abci_query", params: { path, data: b64(data) } }),
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw new GnoQueryError(`gno RPC ${res.status}`);
  const body = (await res.json()) as {
    result?: { response?: { ResponseBase?: { Error?: unknown; Data?: string | null; Log?: string } } };
    error?: { message?: string };
  };
  if (body.error) throw new GnoQueryError(body.error.message ?? "gno RPC error");
  const r = body.result?.response?.ResponseBase;
  if (r?.Error) {
    const log = r.Log ?? "";
    throw new GnoQueryError(firstLine(log) || "gno query failed", log);
  }
  return r?.Data ? unb64(r.Data) : "";
}

function firstLine(log: string): string {
  const m = /Msg Traces:\s*\n\s*\d+\s+\S+ - (.+)/.exec(log) ?? /Data: (.+)/.exec(log);
  return (m?.[1] ?? log.split("\n")[0] ?? "").trim();
}

/** Evaluates `expr` in `realm`, e.g. qeval(pool, "MarketJSON(3)"). Returns the raw "(value type)" lines. */
export const qeval = (realm: string, expr: string, cfg: GnoConfig = GNO, signal?: AbortSignal) =>
  abciQuery("vm/qeval", `${realm}.${expr}`, cfg, signal);

export const qrender = (realm: string, path = "", cfg: GnoConfig = GNO) => abciQuery("vm/qrender", `${realm}:${path}`, cfg);

/** The values of a qeval result, in order, as their raw text (a string keeps its Go quotes). */
export function qevalValues(out: string): { value: string; type: string }[] {
  const values: { value: string; type: string }[] = [];
  for (const line of out.split("\n")) {
    const m = /^\((.*) ([\w.*\[\]]+)\)$/s.exec(line.trim());
    if (m) values.push({ value: m[1], type: m[2] });
  }
  return values;
}

/** A Go-quoted string literal as text. Go's escapes are a superset of JSON's only in \x and \a-style forms. */
export function unquoteGo(lit: string): string {
  const fixed = lit
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => `\\u00${h}`)
    .replace(/\\a/g, "\\u0007")
    .replace(/\\v/g, "\\u000b");
  return JSON.parse(fixed) as string;
}

/** qeval of a function returning one string. */
export async function qevalString(realm: string, expr: string, cfg: GnoConfig = GNO): Promise<string> {
  const [v] = qevalValues(await qeval(realm, expr, cfg));
  if (!v || v.type !== "string") throw new GnoQueryError(`${expr}: expected a string`);
  return unquoteGo(v.value);
}

/** qeval of a function returning a JSON document as a string. */
export async function qevalJSON<T>(realm: string, expr: string, cfg: GnoConfig = GNO): Promise<T> {
  return JSON.parse(await qevalString(realm, expr, cfg)) as T;
}

/** qeval of a function returning integers (int, int64, ...), as bigints in order. */
export async function qevalInts(realm: string, expr: string, cfg: GnoConfig = GNO): Promise<bigint[]> {
  return qevalValues(await qeval(realm, expr, cfg)).map((v) => BigInt(v.value));
}

/** qeval of a function returning a bool. */
export async function qevalBool(realm: string, expr: string, cfg: GnoConfig = GNO): Promise<boolean> {
  const [v] = qevalValues(await qeval(realm, expr, cfg));
  return v?.value === "true";
}

/** The address's native balance in ugnot. */
export async function ugnotBalance(address: string, cfg: GnoConfig = GNO): Promise<bigint> {
  const out = await abciQuery(`bank/balances/${address}`, "", cfg);
  const m = /(\d+)ugnot/.exec(out);
  return m ? BigInt(m[1]) : 0n;
}

/** A Go string literal for a qeval argument. */
export const goString = (s: string) => JSON.stringify(s);
