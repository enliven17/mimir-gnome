"use client";

/** Live Convex queries for the Arc arena (convex/arc.ts). One client per tab. */
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

const url = process.env.NEXT_PUBLIC_CONVEX_URL;
// NEXT_PUBLIC_CONVEX_OFF=1: no socket at all; lib/convex-react.ts answers the hooks.
const client = url && process.env.NEXT_PUBLIC_CONVEX_OFF !== "1" ? new ConvexReactClient(url) : null;

export const convexConfigured = client !== null;

export default function ConvexClientProvider({ children }: { children: ReactNode }) {
  return client ? <ConvexProvider client={client}>{children}</ConvexProvider> : <>{children}</>;
}
