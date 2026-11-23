package pool

// Two steps and a timelock: the new owner accepts no earlier than TimelockSeconds.
func TransferOwnership(cur realm, next address) {
	assertOwner(cur)
	if !next.IsValid() {
		panic("ZeroAddress")
	}
	pendingOwner = next
	pendingOwnerEta = now() + TimelockSeconds
	emit("OwnershipTransferStarted", "previous", owner.String(), "next", next.String(), "eta", itoa(pendingOwnerEta))
}

func CancelOwnershipTransfer(cur realm) {
	assertOwner(cur)
	if pendingOwnerEta == 0 {
		panic("NothingQueued")
	}
	emit("OwnershipTransferCancelled", "pending", pendingOwner.String())
	pendingOwner = ""
	pendingOwnerEta = 0
}

func AcceptOwnership(cur realm) {
	c := caller(cur)
	if pendingOwner == "" || c != pendingOwner {
		panic("NotPendingOwner")
	}
	if now() < pendingOwnerEta {
		panic("Timelocked")
	}
	checkAuditCollision(c)
	emit("OwnershipTransferred", "previous", owner.String(), "next", c.String())
	owner = c
	pendingOwner = ""
	pendingOwnerEta = 0
}

func QueueOracle(cur realm, next address) {
	assertOwner(cur)
	if !next.IsValid() {
		panic("ZeroAddress")
	}
	if next == owner || next == arbiter || next == feeRecipient {
		panic("RoleCollision")
	}
	pendingOracle = next
	pendingOracleEta = now() + TimelockSeconds
	emit("OracleChangeQueued", "next", next.String(), "eta", itoa(pendingOracleEta))
}

// RevokeOracle is the emergency stop: the oracle loses its power at once. A
// replacement still waits the timelock.
func RevokeOracle(cur realm) {
	assertOwner(cur)
	emit("OracleChanged", "previous", oracle.String(), "next", "")
	oracle = ""
}

func CancelOracle(cur realm) {
	assertOwner(cur)
	if pendingOracleEta == 0 {
		panic("NothingQueued")
	}
	emit("OracleChangeCancelled", "next", pendingOracle.String())
	pendingOracle = ""
	pendingOracleEta = 0
}

// ExecuteOracle is permissionless once due, so a queued change cannot be quietly withheld.
func ExecuteOracle(cur realm) {
	if pendingOracleEta == 0 {
		panic("NothingQueued")
	}
	if now() < pendingOracleEta {
		panic("Timelocked")
	}
	checkAuditCollision(pendingOracle)
	emit("OracleChanged", "previous", oracle.String(), "next", pendingOracle.String())
	oracle = pendingOracle
	pendingOracle = ""
	pendingOracleEta = 0
}

// SetAuditAgent appoints an independent reviewer that may dispute with a bond.
// It has no settlement or administration authority. "" disables it.
func SetAuditAgent(cur realm, next string) {
	assertOwner(cur)
	a := parseReferrer(next)
	if a != "" && (a == owner || a == arbiter || a == oracle || a == feeRecipient) {
		panic("RoleCollision")
	}
	emit("AuditAgentChanged", "previous", auditAgent.String(), "next", a.String())
	auditAgent = a
}

func checkAuditCollision(next address) {
	if next != "" && next == auditAgent {
		panic("RoleCollision")
	}
}

func SetArbiter(cur realm, next address) {
	assertOwner(cur)
	if !next.IsValid() {
		panic("ZeroAddress")
	}
	if next == oracle {
		panic("RoleCollision")
	}
	checkAuditCollision(next)
	emit("ArbiterChanged", "previous", arbiter.String(), "next", next.String())
	arbiter = next
}

// SetCaps sets guarded launch caps (net mUSD units, 0 = none). They only gate new stakes.
func SetCaps(cur realm, market, account int64) {
	assertOwner(cur)
	if market < 0 || account < 0 {
		panic("BadCap")
	}
	maxMarketStake = market
	maxAccountStake = account
	emit("CapsChanged", "maxMarketStake", itoa(market), "maxAccountStake", itoa(account))
}

// SetLockAt closes a market to new stakes early (kickoff), by its creator or
// the owner. Only ever earlier.
func SetLockAt(cur realm, id int64, at int64) {
	m := getMarket(id)
	c := caller(cur)
	if c != m.Creator && c != owner {
		panic("BadLock")
	}
	if m.State != StOpen || at < now() || at+LockSeconds > m.Deadline {
		panic("BadLock")
	}
	if m.LockAt != 0 && at > m.LockAt {
		panic("BadLock")
	}
	m.LockAt = at
	emit("LockSet", "id", itoa(id), "lockAt", itoa(at))
}

func QueueFeeRecipient(cur realm, next address) {
	assertOwner(cur)
	if !next.IsValid() {
		panic("ZeroAddress")
	}
	pendingFeeRecipient = next
	pendingFeeEta = now() + TimelockSeconds
	emit("FeeRecipientQueued", "next", next.String(), "eta", itoa(pendingFeeEta))
}

func CancelFeeRecipient(cur realm) {
	assertOwner(cur)
	if pendingFeeEta == 0 {
		panic("NothingQueued")
	}
	emit("FeeRecipientCancelled", "next", pendingFeeRecipient.String())
	pendingFeeRecipient = ""
	pendingFeeEta = 0
}

func ExecuteFeeRecipient(cur realm) {
	if pendingFeeEta == 0 {
		panic("NothingQueued")
	}
	if now() < pendingFeeEta {
		panic("Timelocked")
	}
	checkAuditCollision(pendingFeeRecipient)
	emit("FeeRecipientChanged", "previous", feeRecipient.String(), "next", pendingFeeRecipient.String())
	feeRecipient = pendingFeeRecipient
	pendingFeeRecipient = ""
	pendingFeeEta = 0
}

func SetPaused(cur realm, p bool) {
	assertOwner(cur)
	paused = p
	if p {
		emit("Paused", "paused", "true")
	} else {
		emit("Paused", "paused", "false")
	}
}
