/**
 * The house's gno.land keys: a mnemonic for every council persona (agents/council/personas.ts), the house creator and
 * the oracle, printed as the env lines lib/chains/house.ts reads:
 *
 *   GNO_COUNCIL_MNEMONICS  {"<slug>": "<mnemonic>"}     GNO_CREATOR_MNEMONIC   ORACLE_MNEMONIC
 *   GNO_COUNCIL_WALLETS    {"<slug>": "g1…"}            GNO_CREATOR_ADDRESS
 *
 * Keys already in the environment are kept (rerun it after adding a persona and only that one is new), so it never
 * rotates a funded wallet by accident. Secrets go to stdout or to --output <file> (written 0600), never into the repo.
 *
 *   npx tsx scripts/gno-wallets.ts [--output .temp/gno-wallets.env] [--fund <mUSD>]
 *
 * --fund sends each NEW address that much mUSD from DEPLOYER_MNEMONIC (gas is GNOT: https://faucet.gno.land).
 * Then set them where they are read, e.g. npx convex env set GNO_COUNCIL_MNEMONICS '<json>'.
 */
import { writeFileSync } from "node:fs";

import { COUNCIL_PERSONAS } from "../agents/council/personas";
import { usdToIndex } from "../lib/chains/amounts";
import { addressFromMnemonic, isMnemonic, newMnemonic } from "../lib/gno/keys";
import { transferMessage } from "../lib/gno/msgs";
import { gnoSigner } from "../lib/gno/signer";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

/** An existing mnemonic from the environment, else a new one. */
function keyFor(existing: unknown, fresh: string[], label: string): string {
  if (typeof existing === "string" && isMnemonic(existing)) return existing.trim().replace(/\s+/g, " ");
  const m = newMnemonic();
  fresh.push(label);
  return m;
}

function parseJson(name: string): Record<string, unknown> {
  const raw = process.env[name]?.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

async function main() {
  const output = flag("--output");
  const fundRaw = flag("--fund");
  const fund = fundRaw === undefined ? 0 : Number(fundRaw);
  if (!Number.isFinite(fund) || fund < 0) throw new Error("--fund takes an mUSD amount, e.g. --fund 50");

  const fresh: string[] = [];
  const prior = parseJson("GNO_COUNCIL_MNEMONICS");
  const council: Record<string, string> = {};
  for (const { slug } of COUNCIL_PERSONAS) council[slug] = keyFor(prior[slug], fresh, slug);
  const creator = keyFor(process.env.GNO_CREATOR_MNEMONIC, fresh, "creator");
  const oracle = keyFor(process.env.ORACLE_MNEMONIC, fresh, "oracle");

  const wallets = Object.fromEntries(Object.entries(council).map(([slug, m]) => [slug, addressFromMnemonic(m)]));
  const creatorAddress = addressFromMnemonic(creator);
  const addressOf: Record<string, string> = { ...wallets, creator: creatorAddress, oracle: addressFromMnemonic(oracle) };

  const lines = [
    `# gno.land house keys (${fresh.length} new: ${fresh.join(", ") || "none"}). Secret: keep out of the repo.`,
    `GNO_COUNCIL_MNEMONICS='${JSON.stringify(council)}'`,
    `GNO_COUNCIL_WALLETS='${JSON.stringify(wallets)}'`,
    `GNO_CREATOR_MNEMONIC="${creator}"`,
    `GNO_CREATOR_ADDRESS=${creatorAddress}`,
    `ORACLE_MNEMONIC="${oracle}"`,
    `# oracle address (the realms' oracle role): ${addressOf.oracle}`,
  ];
  if (output) {
    writeFileSync(output, `${lines.join("\n")}\n`, { mode: 0o600 });
    process.stdout.write(`wrote ${output}\n`);
  } else {
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  if (fund > 0 && fresh.length) {
    const deployer = process.env.DEPLOYER_MNEMONIC?.trim();
    if (!deployer) throw new Error("--fund needs DEPLOYER_MNEMONIC (the account that pays)");
    const signer = await gnoSigner(deployer);
    const wei = usdToIndex(fund);
    for (const label of fresh) {
      const sent = await signer.send([transferMessage(signer.address, addressOf[label], wei)]);
      process.stdout.write(`# funded ${label} ${addressOf[label]} with ${fund} mUSD: ${sent.txHash}\n`);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`gno-wallets: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
