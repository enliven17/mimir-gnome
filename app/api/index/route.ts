/**
 * GET /api/index?q=markets|market&chain=&kind=&id=: the raw market index rows (convex/arc.ts shapes), for the browser
 * while Convex is off (lib/convex-react.ts). Reads go through lib/server/arc-index.ts, so they come from the chain then.
 */
import { NextResponse } from "next/server";

import { arcMarketDetail, arcMarketList } from "@/lib/server/arc-index";
import { allowRequest, clientIp, tooManyRequests } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await allowRequest("index", clientIp(req), 120, 60_000))) return tooManyRequests(60);
  const sp = new URL(req.url).searchParams;
  const chain = sp.get("chain") ?? undefined;
  const kind = sp.get("kind") ?? undefined;
  if (chain && chain !== "arc" && chain !== "base") return NextResponse.json(null, { status: 400 });
  if (kind && kind !== "vs" && kind !== "pool") return NextResponse.json(null, { status: 400 });
  try {
    if (sp.get("q") === "market") {
      const id = Number(sp.get("id"));
      if (!kind || !Number.isInteger(id) || id < 0) return NextResponse.json(null, { status: 400 });
      return NextResponse.json(await arcMarketDetail(kind as "vs" | "pool", id, (chain ?? "arc") as "arc" | "base"));
    }
    return NextResponse.json(await arcMarketList(kind as "vs" | "pool" | undefined, chain as "arc" | "base" | undefined), { headers: { "cache-control": "public, s-maxage=15" } });
  } catch (err) {
    console.error("[index] read failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(null, { status: 503 });
  }
}
