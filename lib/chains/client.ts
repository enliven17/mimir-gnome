/**
 * Account reads on gno.land, in index units (18 dp) whatever the chain holds: the mUSD balance and allowance, the
 * GNOT gas balance (ugnot) and the account's entry fee. Isomorphic; every read is an ABCI query (lib/gno/rpc.ts).
 */
import { GNO, type GnoConfig } from "../gno/config";
import { fromMusdUnits, realmOf, type MarketKind } from "../gno/msgs";
import { entryBps, musdAllowance, musdBalance, musdNextDrip } from "../gno/reads";
import { ugnotBalance } from "../gno/rpc";

/** mUSD held, index units. */
export const musdBalanceWei = async (address: string, cfg: GnoConfig = GNO): Promise<bigint> => fromMusdUnits(await musdBalance(address, cfg));

/** The mUSD allowance `owner` gave the market realm of `kind`, index units. */
export const musdAllowanceWei = async (owner: string, kind: MarketKind, cfg: GnoConfig = GNO): Promise<bigint> =>
  fromMusdUnits(await musdAllowance(owner, realmOf(kind, cfg), cfg));

/** GNOT for gas, in ugnot (6 dp). */
export const gasBalanceUgnot = (address: string, cfg: GnoConfig = GNO): Promise<bigint> => ugnotBalance(address, cfg);

/** The account's entry fee in basis points (r/fees). */
export const entryBpsOf = (account: string, cfg: GnoConfig = GNO): Promise<number> => entryBps(account, cfg);

/** Unix seconds from which the account may use the mUSD faucet again (0 = now). */
export const nextDripAt = (address: string, cfg: GnoConfig = GNO): Promise<number> => musdNextDrip(address, cfg);

/** GNOT as a display number. */
export const ugnotToGnot = (ugnot: bigint): number => Number(ugnot) / 1e6;
