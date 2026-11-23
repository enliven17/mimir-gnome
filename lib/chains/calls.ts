/**
 * Market transactions: what a wallet (the user's Adena, an agent's server signer) sends to create, stake, dispute,
 * finalize, refund, cancel, invite or claim. The messages themselves are built by lib/gno/msgs.ts; this module is the
 * market layer's name for them, so the forms and agents import one place. Amounts come in index units (18 dp) and
 * leave as mUSD units (6 dp), exactly (a sub-unit amount throws).
 *
 * A call that pulls mUSD (create, stake/challenge, dispute) needs an allowance for the market realm: actionMessages
 * puts an exact Approve in front when the allowance falls short, and both go in ONE transaction. There are no permits.
 */
export {
  actionMessage,
  actionMessages,
  approveMessage,
  DISPUTE_BOND_WEI,
  kindOfAction,
  needsApproval,
  pullOf,
  realmOf,
  type GnoMsgCall,
  type MarketAction,
  type MarketKind,
  type NewMarketInput,
  type Side,
} from "../gno/msgs";
