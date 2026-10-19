#!/usr/bin/env node
// Verify a saved day: every record's content address and signature, the batch root
// recomputed from the records, and (with --anchor) that a Bitcoin BSV transaction
// carries exactly that root in its OP_RETURN. Zero-dependency, read-only.
//
//   node bin/verify.mjs --run runs/<day> [--anchor <txid>]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyRecord } from "../lib/receipt.mjs";
import { anchorBatch, verifyAnchorOnChain } from "../src/anchor.mjs";

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const runDir = arg("--run"), txid = arg("--anchor");
if (!runDir) {
  console.error("usage: node bin/verify.mjs --run runs/<day> [--anchor <txid>]");
  process.exit(2);
}

const records = JSON.parse(await readFile(join(runDir, "records.json"), "utf8"));
const batch = JSON.parse(await readFile(join(runDir, "batch.json"), "utf8"));
let bad = 0;
records.forEach((r, i) => {
  const v = verifyRecord(r);
  if (!v.ok) { bad++; console.log(`  record ${i} (${r.kind}): ${v.reason}`); }
});
const re = anchorBatch(records.map((r) => r.claimId));
const rootOk = re.root === batch.root && re.scriptHex === batch.scriptHex;
console.log(`Records    : ${records.length - bad} of ${records.length} verify`);
console.log(`Batch root : ${rootOk ? "recomputed, matches" : "MISMATCH"} ${batch.root}`);
let anchorOk = true;
if (txid) {
  const a = await verifyAnchorOnChain(txid, batch.root);
  anchorOk = a.ok;
  console.log(`Anchor     : ${a.ok ? "on chain" : "FAIL " + a.reason} tx ${txid}${a.ok ? `, ${a.confirmations} confirmations${a.blocktime ? ", block time " + a.blocktime : ""}` : ""}`);
}
const ok = bad === 0 && rootOk && anchorOk;
console.log(ok ? "PASS" : "FAIL");
process.exitCode = ok ? 0 : 1; // not process.exit(): it can abort libuv on Windows after a fetch
