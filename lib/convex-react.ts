"use client";

/**
 * convex/react, or a stand-in while Convex is off (NEXT_PUBLIC_CONVEX_OFF=1, e.g. over its quota): market queries read
 * the chain through /api/index, everything else answers empty, writes are no-ops. The flag is build-time, so each
 * build uses one implementation and hook order never changes.
 */
import { useMutation as convexMutation, useQuery as convexQuery } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { useEffect, useState } from "react";

export const convexOff = process.env.NEXT_PUBLIC_CONVEX_OFF === "1";

// What a query answers with no backend: lists empty, counts zero, single rows null.
const EMPTY: Record<string, unknown> = {
  "arc:positionsOf": [], "arc:openedToday": 0, "arcViews:council": [], "arcViews:stats": { claims: [] },
  "arcCouncilDb:forMarket": [], "councilOpinions:forMarket": [], "discovery:radar": [], "launch:list": [],
};
const REFRESH_MS = 30_000;

function indexUrl(name: string, args: Record<string, unknown>): string | null {
  const p = new URLSearchParams();
  for (const k of ["chain", "kind"]) if (args[k] != null) p.set(k, String(args[k]));
  if (name === "arc:markets") return `/api/index?q=markets&${p}`;
  if (name === "arc:market") return `/api/index?q=market&${p}&id=${args.marketId}`;
  return null;
}

function offlineQuery(ref: FunctionReference<"query">, args?: Record<string, unknown> | "skip"): any {
  const name = getFunctionName(ref);
  const url = args === "skip" ? null : indexUrl(name, args ?? {});
  const [data, setData] = useState<unknown>(url ? undefined : (EMPTY[name] ?? null));
  useEffect(() => {
    if (!url) return;
    let live = true;
    const load = () => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => { if (live) setData(d ?? EMPTY[name] ?? null); });
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [url, name]);
  return args === "skip" ? undefined : data;
}

const offlineMutation = (): any => async () => null;

export const useQuery: typeof convexQuery = convexOff ? (offlineQuery as typeof convexQuery) : convexQuery;
export const useMutation: typeof convexMutation = convexOff ? (offlineMutation as typeof convexMutation) : convexMutation;
