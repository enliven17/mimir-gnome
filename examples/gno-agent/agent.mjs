// A bring-your-own-agent example for Mimir on gno.land, using only the public agent API (POST /api/agents/v1/<action>)
// and gno-js-client. Mimir never sees a key: the API returns unsigned MsgCall messages and this script signs them.
//
// What it does, end to end:
//   1. key: one gno.land account (AGENT_MNEMONIC, or a fresh one printed on first run) is the agent's owner (it signs
//      every API request with an ADR-036 SignArbitrary proof, as Adena does), its operator and its gnoOperator (the
//      account that signs and pays gas for its own market transactions). Separate keys work the same way.
//   2. fund: needs GNOT for gas (https://faucet.gno.land); tops up mUSD from the mUSD realm's daily Faucet when short.
//   3. register: pays the 1 mUSD deploy fee (an mUSD Transfer to the pool realm's fee recipient), then registers with
//      authority to stake, naming the gnoOperator. Skipped once registered.
//   4. read: lists live VS markets and picks one to challenge (a deliberately simple rule: the one with the most room
//      left, closing soonest), skipping markets it already holds.
//   5. act: asks the API for the challenge, gets the messages back (an mUSD Approve may come first), checks them, and
//      signs them all as ONE transaction.
//   6. verify: polls listPositions until the index shows the new position.
//
//   AGENT_MNEMONIC="…" node examples/gno-agent/agent.mjs
//   (MIMIR_URL defaults to http://localhost:3123, STAKE_MUSD to 1; GNO_RPC_URL, GNO_CHAIN_ID and GNO_NAMESPACE default
//   to the onyx-1 testnet deployment, as lib/gno/config.ts.)
import { randomUUID } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { getArbitrarySignBytes, makeArbitrarySignDoc } from '@adena-wallet/sdk'
import { decodeTxMessages, GnoJSONRPCProvider, GnoWallet, MsgCall } from '@gnolang/gno-js-client'
import { TransactionEndpoint } from '@gnolang/tm2-js-client'

const env = (...names) => names.map((n) => process.env[n]?.trim()).find(Boolean)
const MIMIR = (env('MIMIR_URL') ?? 'http://localhost:3123').replace(/\/$/, '')
const RPC = env('GNO_RPC_URL', 'NEXT_PUBLIC_GNO_RPC_URL') ?? 'https://rpc.onyx.testnets.gno.land:443'
const CHAIN_ID = env('GNO_CHAIN_ID', 'NEXT_PUBLIC_GNO_CHAIN_ID') ?? 'onyx-1'
const NS = env('GNO_NAMESPACE', 'NEXT_PUBLIC_GNO_NAMESPACE') ?? 'g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz'
const REALM = { musd: `gno.land/r/${NS}/musd`, pool: `gno.land/r/${NS}/pool`, vs: `gno.land/r/${NS}/vs` }
const STAKE_MUSD = Number(env('STAKE_MUSD') ?? '1')
const DEPLOY_FEE_MUSD = Number(env('DEPLOY_FEE_MUSD') ?? '1')
const GAS = { gas_wanted: 50_000_000n, gas_fee: '1000000ugnot' }
const log = (...a) => console.log('[agent]', ...a)
const units = (musd) => BigInt(Math.round(musd * 1e6)) // mUSD has 6 decimals on chain
const fromWei = (wei) => Number(BigInt(wei) / 1_000_000_000_000n) / 1e6 // the API and the index use 18 dp

// ── key ─────────────────────────────────────────────────────────────────────
let mnemonic = env('AGENT_MNEMONIC')
if (!mnemonic) {
  mnemonic = generateMnemonic(wordlist, 256)
  log('no AGENT_MNEMONIC: a new account was made. Keep this line and rerun with it set (it is the only copy):')
  console.log(`AGENT_MNEMONIC="${mnemonic}"`)
}
const wallet = await GnoWallet.fromMnemonic(mnemonic)
const provider = await GnoJSONRPCProvider.create(RPC)
wallet.connect(provider)
const me = await wallet.getAddress()
const AGENT_ID = env('AGENT_ID') ?? `byoa-${me.slice(2, 10)}`

// ── chain helpers ─────────────────────────────────────────────────────────────
/** qeval of a realm function: its "(value type)" result values in order, Go strings unquoted. */
async function qeval(realm, expr) {
  const lines = (await provider.evaluateExpression(realm, expr)).split('\n')
  return lines.map((l) => /^\((.*) ([\w.*[\]]+)\)$/s.exec(l.trim())).filter(Boolean)
    .map(([, v, t]) => (t === 'string' ? JSON.parse(v.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')) : v))
}
const musdBalance = async (addr) => BigInt((await qeval(REALM.musd, `BalanceOf(${JSON.stringify(addr)})`))[0] ?? '0')
const msgCall = (pkg_path, func, args) => ({ type: '/vm.m_call', value: { caller: me, send: '', max_deposit: '', pkg_path, func, args: args.map(String) } })

/** Signs the messages as ONE transaction and broadcasts it; returns the hex hash. */
async function send(messages, fee = GAS) {
  const tx = {
    messages: messages.map((m) => ({ type_url: '/vm.m_call', value: MsgCall.encode({ ...m.value, caller: me }).finish() })),
    fee,
    memo: '',
    signatures: [],
  }
  const signed = await wallet.signTransaction(tx, decodeTxMessages)
  const res = await wallet.sendTransaction(signed, TransactionEndpoint.BROADCAST_TX_COMMIT)
  return String(res.hash).toLowerCase()
}

// ── the signed envelope (lib/agents/api.ts: canonical body, sha256, the readable request text) ──────────────
function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => `${JSON.stringify(k)}:${canonicalize(x)}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
const bodyHash = (body) => bytesToHex(sha256(utf8ToBytes(canonicalize(body ?? {}))))

/** What Adena's SignArbitrary returns (ADR-036), as the JSON string the API expects. */
async function sign(text) {
  const signer = wallet.getSigner()
  const signed = makeArbitrarySignDoc(CHAIN_ID, me, text)
  const b64 = (b) => Buffer.from(b).toString('base64')
  const signature = await signer.signData(getArbitrarySignBytes(signed))
  return JSON.stringify({ signed, signature: { pubKey: { typeUrl: '/tm.PubKeySecp256k1', value: b64(await signer.getPublicKey()) }, signature: b64(signature) } })
}

async function call(action, body = {}) {
  const e = { version: 'v1', agentId: AGENT_ID, action, idempotencyKey: randomUUID(), nonce: randomUUID(), signedAt: Date.now(), body }
  e.signature = await sign(['Mimir Agent API request', `version: ${e.version}`, `agent: ${e.agentId}`, `action: ${e.action}`, `idempotency: ${e.idempotencyKey}`, `nonce: ${e.nonce}`, `signedAt: ${e.signedAt}`, `bodyHash: ${bodyHash(e.body)}`].join('\n'))
  const res = await fetch(`${MIMIR}/api/agents/v1/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${action} → ${res.status} ${json.reason ?? ''}: ${json.message ?? JSON.stringify(json)}`)
  return json
}

// ── main ────────────────────────────────────────────────────────────────────
const gas = BigInt(await provider.getBalance(me, 'ugnot').catch(() => 0))
log(`agent ${AGENT_ID} · account ${me} · ${Number(gas) / 1e6} GNOT · ${Number(await musdBalance(me)) / 1e6} mUSD on ${CHAIN_ID}`)
if (gas === 0n) {
  log(`no GNOT for gas: get some for ${me} at https://faucet.gno.land, then rerun`)
  process.exit(1)
}

// 2. fund: the mUSD faucet gives 1,000 a day
if ((await musdBalance(me)) < units(DEPLOY_FEE_MUSD + STAKE_MUSD)) {
  await send([msgCall(REALM.musd, 'Faucet', [])])
  log(`took the daily mUSD faucet: ${Number(await musdBalance(me)) / 1e6} mUSD`)
}

// 3. register (once)
let registered = true
try {
  await call('heartbeat')
} catch (err) {
  if (!/unknown_agent/.test(err.message)) throw err
  registered = false
}
if (!registered) {
  // The fee recipient is the pool realm's; the API refuses a payment sent anywhere else.
  let paymentTx
  if (DEPLOY_FEE_MUSD > 0) {
    const { feeRecipient } = JSON.parse((await qeval(REALM.pool, 'ConfigJSON()'))[0])
    paymentTx = await send([msgCall(REALM.musd, 'Transfer', [feeRecipient, units(DEPLOY_FEE_MUSD)])])
    log(`paid the ${DEPLOY_FEE_MUSD} mUSD deploy fee to ${feeRecipient}: ${paymentTx}`)
  }
  const operatorSignature = await sign(`Mimir agent operator proof\nagent: ${AGENT_ID}\noperator: ${me}`)
  const reg = await call('register', {
    ownerWallet: me, operatorWallet: me, payoutWallet: me, gnoOperator: me, displayName: 'BYOA example',
    authorityLevel: 3, capabilities: [], operatorSignature, ...(paymentTx ? { paymentTx } : {}),
  })
  log(`registered: ${reg.agent?.agentId} (${reg.agent?.status})`)
}

// 4. read and decide
const { markets } = await call('listClaims', { state: 'live', kind: 'vs', limit: 50 })
const held = new Set(((await call('listPositions')).positions ?? []).map((p) => `${p.kind}:${p.marketId}`))
const now = Math.floor(Date.now() / 1000)
const stakeWei = units(STAKE_MUSD) * 1_000_000_000_000n
const room = (m) => BigInt(m.stakeA) * 5n - BigInt(m.stakeB)
const pick = markets
  .filter((m) => m.deadline > now + 600 && !held.has(`vs:${m.marketId}`) && m.creator?.toLowerCase() !== me && room(m) >= stakeWei)
  .sort((a, b) => Number(room(b) - room(a)) || a.deadline - b.deadline)[0]
if (!pick) {
  log(`no live VS market to challenge (${markets.length} listed); done`)
  process.exit(0)
}
log(`challenging VS #${pick.marketId}: "${pick.question}" (taking "${pick.labelB}")`)

// 5. act: the messages back; check them before signing (lib/gno/msgs.ts: [Approve?, ChallengeClaim(id, units, referrer)])
const prepared = await call('challenge', { claimId: pick.marketId, stakeUsdc: STAKE_MUSD, kind: 'vs' })
const msgs = prepared.messages ?? []
const last = msgs.at(-1)?.value
const isApprove = (m) => m.value.pkg_path === REALM.musd && m.value.func === 'Approve' && BigInt(m.value.args[1]) === units(STAKE_MUSD)
if (
  prepared.chainId !== CHAIN_ID || !last || msgs.length > 2 || msgs.some((m) => m.value.caller !== me || m.value.send) ||
  last.pkg_path !== REALM.vs || last.func !== 'ChallengeClaim' || last.args[0] !== String(pick.marketId) || BigInt(last.args[1]) !== units(STAKE_MUSD) ||
  (msgs.length === 2 && !isApprove(msgs[0]))
) throw new Error('the prepared messages are not the challenge asked for; not signing')
log(prepared.description)
const hash = await send(msgs, { gas_wanted: BigInt(prepared.fee.gasWanted), gas_fee: prepared.fee.gasFee })
log(`sent ${hash}`)

// 6. verify through the API
for (let i = 0; i < 12; i++) {
  const { positions = [] } = await call('listPositions')
  const mine = positions.find((p) => p.kind === 'vs' && p.marketId === pick.marketId)
  if (mine) {
    log(`position on VS #${pick.marketId}: side ${mine.side}, ${fromWei(mine.amount)} mUSD staked (after the entry fee)`)
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 5000))
}
log('the index has not shown the position yet; it updates every 30 s')
