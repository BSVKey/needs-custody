#!/usr/bin/env node
// Build and sign (never broadcast) a transaction anchoring a saved day's batch root on
// Bitcoin BSV.
//
//   WALLET_JSON=/path/to/wallet.json node bin/anchor.mjs --run runs/<day>
//
// wallet.json holds { "mnemonic", "derivation"? } or { "wif" } for a small, funded key
// kept outside this repo. Needs @bsv/sdk (`npm i --no-save @bsv/sdk`); the rest of this
// project stays zero-dependency. Prints the signed tx hex: broadcasting it is a separate,
// deliberate step by the operator. Check it after with
// `node bin/verify.mjs --run <dir> --anchor <txid>`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WOC, anchorBatch } from "../src/anchor.mjs";

const argv = process.argv.slice(2);
const runDir = argv.includes("--run") ? argv[argv.indexOf("--run") + 1] : undefined;
if (!runDir) {
  console.error("usage: WALLET_JSON=<wallet.json> node bin/anchor.mjs --run runs/<day>");
  process.exit(2);
}
const walletPath = process.env.WALLET_JSON;
if (!walletPath) {
  console.error("set WALLET_JSON to a funded wallet file kept outside this repo");
  process.exit(2);
}

let sdk;
try {
  sdk = await import("@bsv/sdk");
} catch {
  console.error("bin/anchor.mjs needs @bsv/sdk: npm i --no-save @bsv/sdk");
  process.exit(2);
}
const { PrivateKey, Transaction, P2PKH, Script, SatoshisPerKilobyte, Mnemonic, HD, Utils } = sdk;

// Never anchor a root the records do not produce.
const records = JSON.parse(await readFile(join(runDir, "records.json"), "utf8"));
const batch = JSON.parse(await readFile(join(runDir, "batch.json"), "utf8"));
const re = anchorBatch(records.map((r) => r.claimId));
if (re.root !== batch.root || re.scriptHex !== batch.scriptHex) throw new Error(`batch.json does not match records.json in ${runDir}`);

const wallet = JSON.parse(await readFile(walletPath, "utf8"));
const priv = wallet.wif
  ? PrivateKey.fromWif(wallet.wif)
  : HD.fromSeed(Mnemonic.fromString(wallet.mnemonic).toSeed()).derive(wallet.derivation || "m/44'/236'/0'/0/0").privKey;
const address = priv.toPublicKey().toAddress();

const unspent = await (await fetch(`${WOC}/address/${address}/unspent`)).json();
if (!Array.isArray(unspent) || !unspent.length) throw new Error(`unfunded: ${address}`);

const tx = new Transaction();
tx.addOutput({ lockingScript: Script.fromHex(batch.scriptHex), satoshis: 0 });
let inSats = 0;
for (const u of unspent.sort((a, b) => a.value - b.value)) {
  if (u.value < 200) continue;
  const hex = await (await fetch(`${WOC}/tx/${u.tx_hash}/hex`)).text();
  tx.addInput({
    sourceTransaction: Transaction.fromHex(hex.trim()),
    sourceOutputIndex: u.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(priv),
  });
  inSats += u.value;
  if (inSats >= 500) break;
}
if (inSats < 500) throw new Error(`not enough funds at ${address}`);
tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toHash()), change: true });
// 1 sat/byte: the SDK default is below the relay minimum and gets rejected.
await tx.fee(new SatoshisPerKilobyte(1000));
await tx.sign();

const txhex = Utils.toHex(tx.toBinary());
const fee = inSats - tx.outputs.reduce((s, o) => s + (o.satoshis || 0), 0);
console.log("Anchor built and signed, NOT broadcast");
console.log(`  run        : ${runDir} (${records.length} records)`);
console.log(`  batch root : ${batch.root}`);
console.log(`  from       : ${address}`);
console.log(`  inputs     : ${tx.inputs.length} (${inSats} sats), fee ${fee} sats, change back to the same address`);
console.log(`  txid       : ${tx.id("hex")}`);
console.log(`\n${txhex}\n`);
console.log("Broadcast (a spend of the fee above; nothing is sent until you do this):");
console.log(`  curl -sS -X POST ${WOC}/tx/raw -H "Content-Type: application/json" -d '{"txhex":"<hex above>"}'`);
console.log("Then check:");
console.log(`  node bin/verify.mjs --run ${runDir} --anchor ${tx.id("hex")}`);
