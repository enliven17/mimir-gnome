/**
 * Paying to deploy an agent on gno.land: a flat mUSD price (lib/arc/fees.ts). The owner pays with a plain mUSD
 * Transfer to the realms' fee recipient (r/pool ConfigJSON feeRecipient, so it follows the realm's timelocked
 * changes); the registration names that transaction's hash, and each one pays for one agent only (an agent_payments
 * row per hash). The payment is read from the committed transaction's events (lib/gno/payments.ts), never from what
 * the caller claims.
 */
import { AgentEnvelopeError } from "@/lib/agents/api";
import { AGENT_DEPLOY_USD } from "@/lib/arc/fees";
import { usdToIndex } from "@/lib/chains/amounts";
import { GNO, type GnoConfig } from "@/lib/gno/config";
import { toMusdUnits } from "@/lib/gno/msgs";
import { musdTransferPaid } from "@/lib/gno/payments";
import { poolConfig } from "@/lib/gno/reads";
import { gnoTx, normalizeTxHash, type GnoTx } from "@/lib/gno/tx";
import { insert, store } from "./store";

/** The deploy price, index units (18 dp). */
export const deployPriceWei = (): bigint => usdToIndex(AGENT_DEPLOY_USD);

/** Where deploy payments go: the pool realm's fee recipient. */
export async function treasury(cfg: GnoConfig = GNO): Promise<string> {
  const to = (await poolConfig(cfg)).feeRecipient;
  if (!to) throw new AgentEnvelopeError("the realms' fee recipient is not set", 503, "chain_unavailable");
  return to.toLowerCase();
}

export interface DeployPaymentDeps {
  tx(hash: string): Promise<GnoTx | null>;
  treasury(): Promise<string>;
  used(hash: string): Promise<boolean>;
  musd: string;
}

const defaults = (cfg: GnoConfig = GNO): DeployPaymentDeps => ({
  tx: (h) => gnoTx(h, cfg),
  treasury: () => treasury(cfg),
  used: async (h) => Boolean(await store().get("agent_payments", h)),
  musd: cfg.realms.musd,
});

/**
 * Throws unless `txHash` moved at least `minWei` of mUSD to the treasury from one of `payers` (the owner's wallet or
 * the agent's gno operator) and has not paid for an agent before. Returns the normalized (lowercase hex) hash.
 */
export async function verifyDeployPayment(txHash: unknown, minWei: bigint, payers: string[], deps: DeployPaymentDeps = defaults()): Promise<string> {
  const hash = normalizeTxHash(txHash);
  if (!hash) throw new AgentEnvelopeError("paymentTx (the gno.land transaction that paid the deploy fee) is required", 402, "payment_required");
  if (await deps.used(hash)) throw new AgentEnvelopeError("that payment already paid for another agent", 409, "payment_used");
  const [tx, to] = await Promise.all([deps.tx(hash), deps.treasury()]);
  if (!tx) throw new AgentEnvelopeError("the payment transaction was not found yet: try again in a few seconds", 402, "payment_invalid");
  const paid = musdTransferPaid(tx, { musd: deps.musd, to, from: payers.filter(Boolean), min: toMusdUnits(minWei) });
  if (!paid.ok) throw new AgentEnvelopeError(`${paid.error} Send at least ${Number(minWei / 10n ** 12n) / 1e6} mUSD to ${to} from the owner's account.`, 402, "payment_invalid");
  return hash;
}

/** Records the payment; throws when the same tx was recorded for another agent in the meantime (it pays once). */
export async function recordDeployPayment(hash: string, agentId: string, ownerWallet: string, amountWei: bigint): Promise<void> {
  const now = Date.now();
  const fresh = await insert("agent_payments", hash, { tx_hash: hash, agent_id: agentId, owner_wallet: ownerWallet, amount_wei: amountWei.toString(), paid_at: now }, { i1: agentId, at: now });
  if (!fresh) throw new AgentEnvelopeError("that payment already paid for another agent", 409, "payment_used");
}
