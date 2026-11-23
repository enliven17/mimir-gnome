/**
 * The amount convention (lib/chains/registry.ts): off chain, every mUSD amount is an 18-dp integer ("index units",
 * a decimal string in Convex). On chain, mUSD has 6 decimals.
 *
 *   toIndexUnits     chain → index: exact (×1e12). Every read applies it.
 *   toChainUnits     index → chain: exact or it throws SubUnitAmountError. Every transaction builder uses it, so a
 *                    stake can never silently send less (or more) than what the user saw.
 *   floorToChain     index → index, rounded DOWN to what the chain can carry: for computed amounts (a max that fits,
 *                    a Kelly size) before they reach a builder. The dust stays with the user.
 */
import type { MarketChain } from "./registry";

export const INDEX_DECIMALS = 18;

type HasToken = { token: Pick<MarketChain["token"], "decimals"> };

/** How many index units one on-chain unit is: 1e12 for mUSD. */
export const unitScale = (chain: HasToken): bigint => 10n ** BigInt(INDEX_DECIMALS - chain.token.decimals);

export class SubUnitAmountError extends Error {
  constructor(public readonly amount: bigint, public readonly decimals: number) {
    super(`mUSD has ${decimals} decimals: ${amount} index units is not a whole number of them`);
  }
}

export function toIndexUnits(chain: HasToken, raw: bigint): bigint {
  return raw * unitScale(chain);
}

export function toChainUnits(chain: HasToken, wei: bigint): bigint {
  const scale = unitScale(chain);
  if (wei % scale !== 0n) throw new SubUnitAmountError(wei, chain.token.decimals);
  return wei / scale;
}

export function floorToChain(chain: HasToken, wei: bigint): bigint {
  const scale = unitScale(chain);
  return (wei / scale) * scale;
}

/** A raw on-chain amount (bigint, number or decimal string) as an index-unit decimal string, for Convex rows. */
export const indexString = (chain: HasToken, raw: bigint | number | string): string => toIndexUnits(chain, BigInt(raw)).toString();

/** Index units → a dollar number (display, sorting, agent sizing). */
export const indexToUsd = (wei: bigint | string): number => Number(BigInt(wei)) / 1e18;

/** A dollar number → index units, rounded down to 6 decimals (mUSD's precision). */
export function usdToIndex(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  return BigInt(Math.floor(usd * 1e6)) * 1_000_000_000_000n;
}

/** Index units → a 6-dp decimal string ("2.5"), exact to the micro-unit (rounded down). */
export function indexToDecimal6(wei: bigint): string {
  const micro = wei / 1_000_000_000_000n;
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
