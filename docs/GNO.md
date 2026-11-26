# Mimir on gno.land: network, realms, units, deploy, keys

For people who work on Mimir or build against its realms directly. It describes the code in `gno/`, `lib/gno/`,
`lib/chains/` and `convex/`. For the plain-language overview read [how-mimir-works.md](how-mimir-works.md); for the
agent API read [AGENTS.md](AGENTS.md).

## Network

| | Testnet (current) | Mainnet |
|---|---|---|
| Chain id | `onyx-1` | `gnoland-1` |
| RPC | `https://rpc.onyx.testnets.gno.land:443` | set `NEXT_PUBLIC_GNO_RPC_URL` |
| gnoweb | `https://onyx.testnets.gno.land` | set `NEXT_PUBLIC_GNOWEB_URL` |
| Gas | GNOT (`ugnot`, 6 decimals), from `https://faucet.gno.land` | GNOT |
| Dispute window | 10 minutes | 1 day |

The realms pick their dispute window at deploy time: `MinLiveDisputeWindow` (86,400 s) when the chain id is
`gnoland-1`, `TestnetDisputeWindow` (600 s) on any other chain.

Users connect **Adena**. The app adds `onyx-1` to Adena if it is missing (`lib/gno/adena.ts` `ensureNetwork`), sends
every action as one transaction of `MsgCall`s (`sendMessages`), and proves account ownership with Adena
`SignArbitrary` (ADR-036) proofs, verified offline in `lib/owner.ts`.

Every package lives under one namespace, the deployer's address:

| Package | Path |
|---|---|
| mUSD | `gno.land/r/g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz/musd` |
| Fees | `gno.land/r/g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz/fees` |
| Pools | `gno.land/r/g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz/pool` |
| VS | `gno.land/r/g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz/vs` |
| Agent pay | `gno.land/r/g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz/agentpay` |
| Shared library | `gno.land/p/g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz/mimir` |

`lib/gno/config.ts` builds these paths from `NEXT_PUBLIC_GNO_NAMESPACE`. A realm's own address (the spender in an mUSD
`Approve`, the holder of staked mUSD) is derived from its path: the bech32 `g` encoding of the first 20 bytes of
`sha256("pkgPath:" + path)` (`lib/gno/address.ts`).

There is one market chain. `lib/chains/registry.ts` exposes it with id `"gno"`; every indexed row carries that id, and
market pages are `/arena/gno/<kind>/<id>`.

## Units

| Where | Unit | Example: 1 mUSD |
|---|---|---|
| On chain (realm arguments, events, JSON views) | mUSD units, 6 decimals, `int64` | `1000000` |
| Off chain (Convex rows, quotes, the UI, agent sizing, agent API reads) | index units, 18 decimals, decimal strings | `1000000000000000000` |
| Gas | `ugnot`, 6 decimals | |

Reads multiply chain amounts by 1e12. Transaction builders divide by 1e12 and refuse an amount that does not divide
exactly (`toMusdUnits` in `lib/gno/msgs.ts`, `toChainUnits` in `lib/chains/amounts.ts`), so a transaction never sends
more or less than the user saw. Computed amounts (a maximum that fits, a Kelly size) are rounded down first with
`floorToChain`; the dust stays with the user.

Every time in the realms is block time in unix seconds.

## Sending a transaction

A market realm takes mUSD with `musd.TransferFrom`, so the caller needs an allowance for that realm. The app, the
agent API and the server signers all build messages with `actionMessages` (`lib/gno/msgs.ts`): when the allowance is
short, an `Approve` of exactly the amount goes in front of the call, and both messages go in **one** transaction. There
are no permit variants and no separate approve step.

From the command line:

```sh
REALM=gno.land/r/g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz
POOL_ADDR=<the pool realm's address>

gnokey maketx call -pkgpath $REALM/musd -func Faucet \
  -gas-fee 1000000ugnot -gas-wanted 50000000 -broadcast \
  -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 mykey

gnokey maketx call -pkgpath $REALM/musd -func Approve -args $POOL_ADDR -args 1000000 \
  -gas-fee 1000000ugnot -gas-wanted 50000000 -broadcast \
  -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 mykey

# Stake 1 mUSD on side A of pool #1, no referrer
gnokey maketx call -pkgpath $REALM/pool -func Stake -args 1 -args 1 -args "" -args 1000000 \
  -gas-fee 1000000ugnot -gas-wanted 50000000 -broadcast \
  -chainid onyx-1 -remote https://rpc.onyx.testnets.gno.land:443 mykey
```

gnokey sends one message per transaction; to put the approve and the call in one transaction, use Adena or
gno-js-client as `examples/gno-agent/agent.mjs` does. Each market page in gnoweb also links to the realm's functions
(`$help&func=...`).

Reads use `vm/qeval` on the JSON views and `vm/qrender` on `Render` (`lib/gno/rpc.ts`, `lib/gno/reads.ts`).

## Realm reference

Error strings below are the realms' `panic` messages, which a failed transaction returns.

### p/mimir (shared library)

| Export | What it is |
|---|---|
| `Roles`, `NewRoles(owner, arbiter, oracle, feeRecipient)` | Each market realm's roles, pause flag and stake caps, with the rules listed under [Roles](#roles-and-timelocks) |
| `TimelockSeconds` | 172,800 (2 days): ownership, oracle and fee-recipient changes |
| `History`, `Amounts`, `Checkpoint` | Append-only stake checkpoints per market and per position. `Before(cutoff)` gives the totals recorded strictly before `cutoff` (0 means the latest), which is how a settlement cutoff excludes late stakes |
| `MulDiv(a, b, d)`, `Add(a, b)` | Overflow-checked integer math; `MulDiv` rounds down |
| `Quote`, `Escape`, `FormatUSD` | JSON string quoting, markdown escaping for `Render`, mUSD units as a decimal string |
| `ParseOptional(s)` | An optional address argument: `""` means none, anything else must be a valid address (`BadAddress`) |

### r/musd

Mimir USD, a GRC20 test dollar. It has no value and no backing.

| Constant | Value |
|---|---|
| `Decimals` | 6 |
| `Unit` | 1,000,000 |
| `FaucetAmount` | 1,000 mUSD |
| `FaucetCooldown` | 24 hours |
| `Deployer` | `g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz` (owns `Mint`) |

| Function | Who | What |
|---|---|---|
| `Faucet()` | anyone | Mints `FaucetAmount` to the caller, at most once per cooldown; otherwise panics with `faucet: next drip at unix <t>` |
| `Transfer(to, amount)`, `Approve(spender, amount)`, `TransferFrom(from, to, amount)` | anyone | Standard GRC20 |
| `Mint(to, amount)` | owner | Seeds agent and council accounts |
| `TotalSupply()`, `BalanceOf(owner)`, `Allowance(owner, spender)`, `NextDrip(addr)` | read | `NextDrip` is the unix time the address may use the faucet again (0: now) |

Events: `Faucet` (`to`, `amount`), plus the GRC20 `Transfer` events the payment checks read.

Render: `""` is the token page with the faucet terms; `balance/<address>` is that address's balance in units. The app's
account links point at the balance page.

### r/fees

The entry fee each account pays on pool and VS stakes.

| Constant | Value |
|---|---|
| `BaseBps` | 50 (0.5%): everyone without a valid ticket |
| `HolderBps` | 25 (0.25%): tier 1 ticket |
| `WhaleBps` | 10 (0.1%): tier 2 ticket |
| `MaxTicketSeconds` | 2 days: the longest a ticket may run |
| `OwnershipTimelockSeconds`, `SignerTimelockSeconds` | 2 days |

A **fee ticket** says "account A is tier T until `expires`". The fee signer signs it with **ed25519** over the exact
string `TicketMessage(account, tier, expires)`:

```
Mimir Fees v1|<chain id>|<fees realm path>|<account>|<tier>|<expires>
```

The chain id and realm path are part of the message, so a ticket cannot be replayed on another network or another
deployment. The account submits it with `ApplyTicket(tier, expires, sigHex)`; a ticket only applies to the account that
sends it. A ticket can only lower a rate. Mimir's server signs no tickets, so in practice everyone pays `BaseBps`.

| Function | Who | What |
|---|---|---|
| `ApplyTicket(tier, expires, sigHex)` | anyone | Stores a signed tier for the caller. Panics `BadTier`, `BadExpiry`, `BadSignature` |
| `EntryBps(account)` | read | The account's rate now: `BaseBps` without a ticket, after expiry, or when the ticket was applied under an earlier signer epoch |
| `SetInitialSigner(pubHex)` | owner, once | Installs the first signer (32-byte ed25519 public key, hex) |
| `RevokeSigner()` | owner | Removes the signer at once and retires every applied ticket |
| `QueueSigner(pubHex)`, `ExecuteSigner()` | owner, then anyone once due | Signer change after the 2-day timelock; also retires every applied ticket |
| `TransferOwnership(next)`, `CancelOwnershipTransfer()`, `AcceptOwnership()` | owner, then the new owner after 2 days | Two-step ownership |
| `Owner()`, `PendingOwner()`, `SignerEpoch()`, `Signer()`, `TicketMessage(...)` | read | |

Events: `TicketApplied`, `SignerChanged`, `SignerQueued`, `OwnershipTransferStarted`, `OwnershipTransferCancelled`,
`OwnershipTransferred`.

Render: `""` shows the rates, owner and signer epoch; `<address>` shows that account's rate.

### r/pool

Two-sided pool markets. Side A and side B; anyone stakes on either side, stakes add up per side, and winners take
their stake back plus a pro-rata share of the losing side, rounded down.

| Constant | Value |
|---|---|
| `MinStake` | 100,000 (0.1 mUSD), gross |
| `DisputeBond` | 2,000,000 (2 mUSD) |
| `LockSeconds` | 60: no new stakes in the last minute before the deadline |
| `MaxDeadlineAhead` | 365 days |
| `MaxEntryBps` | 100: a stake is refused if `fees.EntryBps` ever answers more than 1% |
| `ReferrerFeeBps`, `CopyFeeBps` | 100 each: 1% of a copy trade's net profit to the referrer, 1% to the fee recipient |
| `ResolutionGraceSeconds` | 7 days |
| `MaxDisputeWindow` | 7 days |
| `MinLiveDisputeWindow`, `TestnetDisputeWindow` | 1 day, 10 minutes |
| `Deployer`, `InitialOracle`, `InitialArbiter` | the initial owner and fee recipient (`g12dcs…6tcz`), oracle (`g18pnec3atge4msr5hhanm790tljtdyd87s0wguh`) and arbiter (`g1af78r3tuv84mf3cd0kxrssmw6g2v2mvvc6phpv`) |

States: 0 Open, 1 Proposed, 2 Disputed, 3 Resolved. Outcomes: 1 A, 2 B, 3 Draw, 4 Unresolvable.

| Function | Who | What |
|---|---|---|
| `CreateMarket(question, labelA, labelB, resolutionURL, category, deadline, side, referrer, amount) int64` | anyone | Opens a market and stakes `amount` on `side` (1 or 2). `referrer` is `""` or an address. Returns the id |
| `Stake(id, side, referrer, amount)` | anyone | Adds to the caller's position. Closed from `LockSeconds` before the deadline, or from `LockAt` |
| `SetLockAt(id, at)` | creator or owner | Closes staking early; can only move earlier |
| `Resolve(id, outcome, summary, evidenceHash)`, `ResolveWithCutoff(..., cutoff)` | oracle | After the deadline and before the grace ends: a proposal. `cutoff` (unix seconds, 0 = none): only stakes strictly before it compete |
| `Dispute(id)` | participants, the audit agent, the arbiter | Inside the window, pulls `DisputeBond` and moves the market to Disputed |
| `VetoProposal(id)` | owner | Inside the window, sends the proposal to the arbiter with no bond |
| `Finalize(id)` | anyone | Settles an undisputed proposal once the window has closed |
| `ResolveDispute(id, outcome, summary, evidenceHash)`, `ResolveDisputeWithCutoff(..., cutoff)` | arbiter | The final ruling. The bond goes back if the outcome or the cutoff changed, otherwise it accrues to the fee recipient |
| `RefundExpired(id)` | anyone, after the grace | See [Escape hatch](#escape-hatch) |
| `Claim(id)` | staker | Pays the caller's payout |
| `ClaimFor(id, user)` | anyone | Pays `user`'s payout to `user`; the oracle uses it to push every payout |
| `ClaimFees()`, `ClaimFeesTo(to)` | any address with accrued fees | Pays out accrued entry fees, copy fees and forfeited bonds |
| Role administration | owner / anyone once due | `TransferOwnership`, `CancelOwnershipTransfer`, `AcceptOwnership`, `QueueOracle`, `CancelOracle`, `ExecuteOracle`, `RevokeOracle`, `SetArbiter`, `QueueFeeRecipient`, `CancelFeeRecipient`, `ExecuteFeeRecipient`, `SetAuditAgent`, `SetCaps(market, account)`, `SetPaused(bool)` |

Reads: `MarketCount`, `Owner`, `Arbiter`, `Oracle`, `AuditAgent`, `FeeRecipient`, `Paused`, `DisputeWindow`,
`AccruedFees(addr)`, `SideTotals(id)`, `StakeOf(id, user)`, `EligibleTotals(id)`, `Claimable(id, user)`.

JSON views:

| View | Fields |
|---|---|
| `ConfigJSON()` | `owner`, `arbiter`, `oracle`, `auditAgent`, `feeRecipient`, `paused`, `disputeWindow`, `minStake`, `disputeBond`, `lockSeconds`, `graceSeconds`, `maxMarketStake`, `maxAccountStake`, `marketCount`, `lifetimeFeesAccrued`, `lifetimeFeesClaimed`, `now` |
| `MarketJSON(id)`, `MarketsJSON(offset, limit)` | `id`, `creator`, `deadline`, `createdAt`, `state`, `outcome`, `proposed`, `proposedAt`, `disputedAt`, `disputer`, `bond`, `totalA`, `totalB`, `eligibleA`, `eligibleB`, `entryFees`, `settlementCutoff`, `lockAt`, `participants`, `evidenceHash`, `question`, `labelA`, `labelB`, `resolutionUrl`, `category`, `summary`. The list is newest first, at most 100 per page |
| `PositionJSON(id, user)` | `a`, `b` (net stakes), `copyA`, `copyB`, `referrer`, `claimed`, `claimable`, `claimFee` |

The pool realm cannot list a market's stakers; the indexer learns them from `Staked` events.

Events: `MarketCreated`, `Staked`, `ReferrerSet`, `LockSet`, `SettlementCutoffSet`, `ResolutionProposed`,
`ResolutionDisputed`, `DisputeResolved`, `MarketResolved`, `MarketExpiredRefund`, `Claimed`, `FeeAccrued`,
`FeeClaimed`, and the role events.

Render: `""` lists the latest 50 markets; `<id>` is one market with its odds, proposal or result, and `$help` links to
`Stake`, `Claim`, `Finalize` and `Dispute`.

**Payout.** A winner gets their eligible stake on the winning side plus `stake × losing total / winning total`, rounded
down; dust stays in the realm. Stakes at or after the cutoff come back as principal and share in nothing. Everyone
gets their stake back on a draw, on an unresolvable result, or when either side's eligible total is zero. A copy
trade (a stake made with a `referrer`) pays `ReferrerFeeBps` and `CopyFeeBps` of its net profit on the copied part;
nobody pays a fee to themselves.

### r/vs

VS duels. The creator opens a claim with a stake on their position; challengers take the counter position, each once,
up to `maxChallengers` (at most 100).

- **Pool odds** (default): challengers together may stake at most `MaxPoolMultiple` (5) times the creator's stake. If
  they win, they share up to 5 times their combined stake from the creator's stake, pro rata; the rest goes back to
  the creator.
- **Fixed odds**: each challenger is paid `challengerPayoutBps` of their stake (2x by default, at most 10x). The
  creator's unreserved stake must cover a challenger's profit when they join (`CreatorHasInsufficientLiquidity`).

Settlement pays every participant in the same transaction. There is no claim step on VS.

| Constant | Value |
|---|---|
| `MaxChallengers` | 100 |
| `MaxPoolMultiple` | 5 |
| `MinStake` | 100,000 (0.1 mUSD), gross |
| `DisputeBond` | 2,000,000 (2 mUSD) |
| `DefaultPayoutBps`, `MaxPayoutBps` | 20,000 (2x), 100,000 (10x) |
| `ChallengeLockSeconds` | 60 |
| `MaxDeadlineAhead`, `ResolutionGraceSeconds` | 365 days, 7 days |
| `MaxEntryBps`, `ReferrerFeeBps`, `CopyFeeBps` | 100 each |
| `MinLiveDisputeWindow`, `TestnetDisputeWindow` | 1 day, 10 minutes |
| `Deployer`, `InitialOracle`, `InitialArbiter` | the same three addresses as r/pool |

States: 0 Open (no challenger yet), 1 Active, 2 Resolved, 3 Cancelled, 4 Proposed, 5 Disputed. Winner sides: 1
Creator, 2 Challengers, 3 Draw, 4 Unresolvable.

| Function | Who | What |
|---|---|---|
| `CreateClaim(question, creatorPosition, counterPosition, resolutionURL, deadline, stakeAmount, category, parentID, marketType, oddsMode, challengerPayoutBps, handicapLine, settlementRule, maxChallengers, isPrivate, referrer) int64` | anyone | Opens a claim. `oddsMode` is `"pool"` or `"fixed"`; `challengerPayoutBps` below 10,000 means 2x; `maxChallengers` 0 means 100 |
| `CreateRematch(parentID, deadline, stakeAmount) int64` | anyone | A new claim with the parent's terms; the caller is the creator. A private rematch starts with an empty invite list |
| `ChallengeClaim(claimID, stakeAmount, referrer)` | anyone but the creator, once | Takes the counter position. On a private claim only invited accounts may join (`NotInvited`) |
| `SetInvited(claimID, accounts, allowed)` | creator of a private claim | Grants or revokes up to 100 accounts, comma-separated. Revoking only blocks future entry |
| `SetLockAt(claimID, at)` | creator or owner | Closes the claim to challengers early; can only move earlier |
| `CancelClaim(claimID)` | creator, while Open | Returns the creator's net stake; the entry fee is kept |
| `ResolveClaimWithCutoff(claimID, winnerSide, summary, confidence, evidenceHash, cutoff)` | oracle | After the deadline, on an Active claim: a proposal with a confidence of 0 to 100 |
| `DisputeResolution(claimID)` | creator, challengers, the audit agent, the arbiter | Inside the window, pulls `DisputeBond` |
| `VetoProposal(claimID)` | owner | Inside the window, no bond |
| `FinalizeResolution(claimID)` | anyone | Settles an undisputed proposal once the window has closed |
| `ResolveDisputeWithCutoff(claimID, winnerSide, summary, confidence, evidenceHash, cutoff)` | arbiter | The final ruling; the bond rule is the same as on pools |
| `RefundExpired(claimID)` | anyone, after the grace | See [Escape hatch](#escape-hatch) |
| `ClaimFees()`, `ClaimFeesTo(to)` | any address with accrued fees | As on pools |
| Role administration | owner / anyone once due | The same set as r/pool |

An Open claim (nobody has challenged it) cannot be resolved or refunded by `RefundExpired`; only its creator can
cancel it.

Reads: `ClaimCount`, `Owner`, `Arbiter`, `Oracle`, `AuditAgent`, `FeeRecipient`, `Paused`, `DisputeWindow`,
`AccruedFees(addr)`, `UserStats(addr)` (wins, losses), `HasChallenged(id, addr)`, `Invited(id, addr)`,
`PlatformStats()` (opened, resolved), `FeeStats()` (accrued, claimed, outstanding), `EligibleTotals(id)`.

JSON views:

| View | Fields |
|---|---|
| `ConfigJSON()` | as r/pool, plus `maxPoolMultiple`, `claimCount`, `totalResolved` (no `marketCount`) |
| `ClaimJSON(id)`, `ClaimsJSON(offset, limit)` | `id`, `creator`, `question`, `creatorPosition`, `counterPosition`, `resolutionUrl`, `creatorStake`, `totalChallengerStake`, `reservedCreatorLiability`, `eligibleCreator`, `eligibleChallengers`, `deadline`, `state`, `winnerSide`, `resolutionSummary`, `confidence`, `category`, `parentId`, `challengerCount`, `createdAt`, `marketType`, `oddsMode`, `challengerPayoutBps`, `handicapLine`, `settlementRule`, `maxChallengers`, `isPrivate`, `evidenceHash`, `referrer`, `entryFees`, `settlementCutoff`, `lockAt`, and `proposal` (`winnerSide`, `confidence`, `proposedAt`, `disputedAt`, `disputer`, `bond`, `evidenceHash`, `summary`). The list is newest first, at most 100 per page |
| `ChallengersJSON(id)` | `address`, `stake`, `at`, `referrer` for each challenger, in join order |

Events: `ClaimCreated`, `ClaimChallenged`, `ReferrerSet`, `InviteUpdated`, `LockSet`, `ClaimCancelled`,
`SettlementCutoffSet`, `ResolutionProposed`, `ResolutionDisputed`, `DisputeResolved`, `ClaimResolved`,
`MarketSettled`, `ClaimExpiredRefund`, `FeeAccrued`, `FeeClaimed`, and the role events.

Render: `""` lists the latest 50 duels; `<id>` is one duel with `$help` links to `ChallengeClaim`,
`FinalizeResolution` and `DisputeResolution`.

### r/agentpay

Pays a Mimir agent for one API call, straight from the payer to the agent. It holds no funds, takes no fee and has no
owner.

| Function | Who | What |
|---|---|---|
| `Pay(agent, amount, callID)` | anyone | Moves `amount` mUSD from the caller to `agent` (needs an mUSD allowance for this realm). `callID` is a lowercase hex sha256, not all zeros. Each payer can pay a call id once (`CallIdUsed`) |
| `Used(payer, callID)` | read | Whether the payer already paid that id |

Event: `Paid` (`callId`, `agent`, `payer`, `amount`). Render: `""` describes the realm.

The flow: `GET /api/launch/<agent>/call` quotes a price, the agent's account and a fresh `secret`, with
`callId = hex(sha256(secret))`. The caller sends `Approve` and `Pay` in one transaction, then calls the agent with the
header `X-Mimir-Payment: gno:<tx hash>:<secret>`. Mimir reads the `Paid` event from the committed transaction and
counts it only if its `callId` is the hash of that secret (`lib/gno/payments.ts`).

## Rules every market realm shares

### Lifecycle

1. **Open and stake** until 60 seconds before the deadline, or until the market's `LockAt`.
2. **Propose.** After the deadline the oracle proposes an outcome with a summary and the hex sha256 of its evidence
   bundle (`""` for none). It may set a settlement cutoff.
3. **Dispute window** (10 minutes on testnet, 1 day on `gnoland-1`). A participant, the audit agent or the arbiter
   disputes by posting the 2 mUSD bond; the owner can veto without a bond. The arbiter then rules.
4. **Finalize.** Anyone settles an undisputed proposal after the window.
5. **Payout.** VS pays everyone in the settling transaction. Pools pay per staker through `Claim` or `ClaimFor`; the
   oracle calls `ClaimFor` for every staker.

### Escape hatch

`RefundExpired` opens 7 days after the latest of the deadline, the proposal and the dispute. From then on the oracle
and the arbiter can no longer rule (`GraceOver`).

- A market the oracle never resolved refunds every stake.
- A dispute the arbiter never ruled on settles to the oracle's proposal, and the bond is forfeited, so a dispute
  cannot buy a refund.
- A vetoed proposal, or any proposal while the realm is paused, refunds every stake and returns the bond.

### Fees

- **Entry fee** on every stake that opens or joins a market: `fees.EntryBps(caller)` of the gross amount, 0.5% by
  default, never more than 1%. It accrues to the fee recipient and is kept on refunds.
- **Copy fee**: a stake made with a `referrer` pays 1% of its net profit to the referrer and 1% to the fee recipient,
  on wins only.
- Fees and forfeited bonds **accrue** in the realm per recipient; the recipient collects them with `ClaimFees` or
  `ClaimFeesTo`.
- No other fee on winnings.

### Roles and timelocks

| Role | Can |
|---|---|
| Owner | pause, revoke the oracle at once, queue a new oracle or fee recipient (2 days), veto a proposal, set the arbiter, the audit agent, stake caps and early locks, transfer ownership (2 days) |
| Arbiter | rule on disputed and vetoed proposals |
| Oracle | propose results |
| Fee recipient | collect entry fees, the platform's copy fees and forfeited bonds |
| Audit agent (optional) | dispute any proposal with a bond |

- The oracle is never also the owner, the arbiter or the fee recipient (`RoleCollision`).
- The audit agent never holds another role.
- Queued changes (`ExecuteOracle`, `ExecuteFeeRecipient`) are executed by anyone once due.
- **Pause** stops new markets and stakes, proposals, finalization, rulings and winners' pool payouts. Refunds still go
  out, and `RefundExpired` while paused refunds instead of honouring a proposal.
- **Caps** (`SetCaps(maxMarketStake, maxAccountStake)`, net mUSD units, 0 = none) gate new stakes only
  (`CapExceeded`).

### Differences from the EVM contracts

The realms port `MimirPoolErc20`, `MimirV3Erc20`, `MimirFees` and `MimirAgentPay` rule for rule. What changed comes
from the platform:

- mUSD in `int64` units instead of USDC; an `Approve` in the same transaction instead of permits.
- mUSD has no blacklist and no callbacks, so a payout cannot be refused and cannot re-enter. Payouts are sent
  directly: no parked withdrawals and no reentrancy lock.
- Fee tickets are ed25519 signatures over a text message instead of EIP-712.
- `SetInvited` takes a comma-separated address list.

## Deploy

`scripts/gno/deploy.sh` submits the packages with `gnokey maketx addpkg`, in dependency order:
`p/mimir`, `r/musd`, `r/fees`, `r/pool`, `r/vs`, `r/agentpay`.

```sh
KEY=mimir-deployer CHAIN_ID=onyx-1 REMOTE=https://rpc.onyx.testnets.gno.land:443 scripts/gno/deploy.sh
# only some packages
scripts/gno/deploy.sh r/pool r/vs
```

| Variable | Default |
|---|---|
| `KEY` | `mimir-deployer` (a gnokey key name) |
| `CHAIN_ID`, `REMOTE` | `onyx-1`, `https://rpc.onyx.testnets.gno.land:443` |
| `NS` | `g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz` |
| `GAS_WANTED`, `GAS_FEE`, `MAX_DEPOSIT` | `80000000`, `100000ugnot`, `500000000ugnot` |
| `PASSWORD_FILE` | unset; when set, the key password is read from it |

The key must be the namespace's address. The namespace is also written into the source: the import paths between
packages and the `Deployer`, `InitialOracle` and `InitialArbiter` constants. Deploying under another namespace means
changing those too.

**Code approval on onyx-1.** onyx-1 runs the `inert` code-submission policy: `addpkg` stores a package, and the
package becomes callable only after the chain's package approver (the gpao) approves it. Submit, then wait for the
approval before you seed or point the app at the realms. If the approver rejects a package (`rejectpkg`), fix it and
submit that package again with `scripts/gno/deploy.sh r/<name>`.

**After the realms are live:**

1. The oracle role starts as `InitialOracle`. `ORACLE_MNEMONIC` must derive that address; otherwise queue the right
   one with `QueueOracle` on both market realms and wait 2 days.
2. The fee recipient starts as `Deployer`; move it with `QueueFeeRecipient` if needed.
3. Optional: `SetAuditAgent` on both market realms (`node --import tsx agents/audit/run.ts --print-setup` prints the
   calls), `SetCaps`, and `fees.SetInitialSigner` if fee tickets will be used.
4. Seed the house and council accounts with GNOT from the faucet and mUSD with `musd.Mint` or `musd.Transfer`.
5. Set `GNO_INDEX_FROM_BLOCK` to the deploy height so the indexer sees every stake.

## Keys and environment

Every server key is a BIP-39 mnemonic with gnokey's derivation (`m/44'/118'/0'/0/0`, secp256k1); `lib/gno/keys.ts`
derives the `g1` address. `node --import tsx scripts/gno-wallets.ts` generates the oracle, house creator and council
keys as env lines, keeps any already set, and with `--fund <mUSD>` sends each new account mUSD from
`DEPLOYER_MNEMONIC`.

| Variable | Where | What |
|---|---|---|
| `NEXT_PUBLIC_GNO_CHAIN_ID`, `NEXT_PUBLIC_GNO_RPC_URL`, `NEXT_PUBLIC_GNO_NAMESPACE`, `NEXT_PUBLIC_GNOWEB_URL`, `NEXT_PUBLIC_GNO_FAUCET_URL` | web | The network; the defaults are onyx-1 and the namespace above |
| `GNO_CHAIN_ID`, `GNO_RPC_URL`, `GNO_NAMESPACE`, `GNOWEB_URL` | Convex, server routes | The backend's copies; preferred over the public names |
| `GNO_INDEX_FROM_BLOCK`, `GNO_INDEX_MAX_BLOCKS` | Convex | Where the event scan starts (default: the head at first run) and blocks per run (default 60) |
| `ORACLE_MNEMONIC` | Convex | The realms' oracle: proposes, finalizes, refunds and pushes pool payouts |
| `GNO_CREATOR_ADDRESS`, `GNO_CREATOR_MNEMONIC` | web (address), Convex (both) | The house market creator |
| `GNO_COUNCIL_WALLETS`, `GNO_COUNCIL_MNEMONICS` | web (addresses), Convex (both) | `{"<slug>": "g1…"}` and `{"<slug>": "<mnemonic>"}` for the council personas |
| `GNO_HOUSE_ADDRESSES` | Convex | Extra addresses the oracle treats as Mimir's own |
| `GNO_WALLET_SECRET` | web and Convex, same value | Seals the keys Mimir generates for hosted agents and copy wallets (AES-256-GCM, 32+ characters). Changing it strands those wallets |
| `AUDIT_AGENT_MNEMONIC`, `AUDIT_AGENT_ADDRESS` | the audit worker only | The audit agent (`agents/audit`) |
| `ADMIN_WALLETS` | web | `g1` accounts allowed into `/admin` |

Where both an address and a mnemonic are set they must agree; the admin panel and the watchdog report a mismatch and
any EVM-era variable still set (`ORACLE_KEY`, `ARC_*`, `BASE_*`, `CIRCLE_*`). Keep every server account funded with a
little GNOT for gas; the creator and the council also need mUSD to stake. `.env.example` documents every variable.

**Hosted agents and copy wallets.** Mimir generates a fresh mnemonic per wallet and stores only the sealed form,
bound to the wallet's scope (`lib/server/gno-wallets.ts`). The owner funds the agent with mUSD and a little GNOT from
Adena. An agent's optional token is a GRC20 its owner opens from Adena through `gno.land/r/demo/defi/grc20factory`;
the owner becomes its admin, and Mimir takes no share (`lib/launch/token.ts`).

## The backend

Scheduled Convex jobs (`convex/crons.ts`). Each run finishes on its own and is retried on the next tick.
`MIMIR_BACKEND_OFF=1` turns them all into no-ops.

| Job | Every | What |
|---|---|---|
| Indexer (`arcSync`) | 30 s | Reads every market from `ClaimsJSON` / `MarketsJSON`, re-reads challengers and positions for markets that moved, and scans new blocks for the two market realms' events (activity, stake times for the cutoff rule, pool stakers). Blocks are final once committed. Realms that are not on chain yet leave the run a no-op |
| Oracle (`arcOracle`) | 2 min | Proposes results on past-deadline markets, finalizes proposals whose window closed, calls `RefundExpired` after the grace, and pushes pool payouts with `ClaimFor`. Skips proposals and finalizations on a paused realm |
| Council (`arcCouncil`) | 15 min | Persona takes and optional stakes from the council accounts. See [COUNCIL.md](COUNCIL.md) |
| Market creator (`arcCreator`) | 1 h | Opens house pools from live data within its daily mUSD budget |
| Watchdog (`arcWatch`) | 10 min | Roles, pause, proposals, disputes, stuck markets and low GNOT, reported to the admin Telegram |
| Hosted agents (`launchArc`, `launchMarketsDb`) | 5 min, 1 h | Agents stake on markets and open their own when allowed; off until `LAUNCH_AGENTS=1` |

With `TYPESAFE_API_KEY` set, the indexer also asks Jev to triage each new market (`lib/jev-triage.ts`). Jev never
decides a settlement.

## Testing

```sh
cd gno
gno test ./p/... ./r/...
gno lint ./r/...
```

The realm tests cover payouts, disputes, cutoffs, refunds, pause, roles, invites, fee tickets and agent payments.
TypeScript tests in `tests/node/` pin the address and key derivation against values the chain produced.
