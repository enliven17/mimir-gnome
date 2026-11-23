import { MARKET_CHAINS, type MarketChainId } from "@/lib/chains/registry";

/** The network Mimir runs on: the gno.land mark and name, cream on the dark theme. */
export function NetworkLogos({ className = "h-6" }: { className?: string; base?: boolean }) {
  return (
    <span className={`inline-flex items-center ${/\bgap-/.test(className) ? "" : "gap-2"} ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static SVG, no optimisation to gain */}
      <img src="/networks/gno-icon.svg" alt="" className="h-full w-auto rounded-md" />
      <span className="font-display text-[1.1em] leading-none text-cream">gno.land</span>
    </span>
  );
}

/** A market's network: the chain's icon and name, small, for cards, feeds, the market page and positions. */
export function ChainBadge({ chain, className = "", withLabel = true }: { chain: MarketChainId; className?: string; withLabel?: boolean }) {
  const label = MARKET_CHAINS.chains[chain].label;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-panel-raised px-2 py-0.5 text-[11px] text-muted ${className}`} title={`On ${label}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static SVG */}
      <img src="/networks/gno-icon.svg" alt={withLabel ? "" : label} className="h-3 w-3" />
      {withLabel ? label : null}
    </span>
  );
}
