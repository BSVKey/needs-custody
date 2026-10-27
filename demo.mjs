#!/usr/bin/env node
// One day at a fictional settlement, "Camp North" (2,400 residents), covering five basic
// needs: safe water delivered, water bought by the liter, food aid handed out, a
// drought payout, and field medicine after a flood (triage tags and supplies), all of
// it recorded offline then anchored once on Bitcoin BSV.
// Each section verifies the honest records, then shows tampering being caught.
//   node demo.mjs                 print the day
//   node demo.mjs --out runs/X   also save the day's records + batch for anchoring
import { genKeypair } from "./lib/keys.mjs";
import { H } from "./src/common.mjs";
import { SPHERE, qualityReading, waterDelivery, waterReceived, verifyWaterDelivery, coverage } from "./src/water.mjs";
import { openChannel, meterState, kioskAccept, settle } from "./src/meter.mjs";
import { householdTag, aidManifest, entitlementProof, aidHandoff, aidHandout, verifyAid } from "./src/aid.mjs";
import { droughtPolicy, rainReading, evaluate, payout, verifyPayout } from "./src/parametric.mjs";
import { casualtyTag, triage, casualtyHandoff, verifyCasualties, supplyRequest, supplyReceipt, verifySupplies } from "./src/medical.mjs";
import { appendEntry, reassemble } from "./src/offline.mjs";
import { anchorBatch, batchProof, inBatch, ANCHOR_TAG } from "./src/anchor.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const T0 = Date.parse("2026-10-19T06:00:00Z");
const SITE = "camp-north", POPULATION = 2400;
const out = (s = "") => console.log(s);
const head = (s) => out(`\n== ${s} ${"=".repeat(Math.max(0, 70 - s.length))}`);
const allRecords = []; // every signed record of the day, for the anchor
const keep = (...recs) => { allRecords.push(...recs); return recs[0]; };

// ---- 1. Water: safe water delivered -------------------------------------------------
head("1. WATER: delivery receipts with quality evidence");
const operator = genKeypair(), committee = genKeypair(), sensor = genKeypair();
const pins = { operatorPub: operator.pub, sitePub: committee.pub, sensorPub: sensor.pub };
const trucks = [
  { liters: 10000, received: 10000, frc: 0.42, ntu: 1.1 },
  { liters: 10000, received: 9950, frc: 0.38, ntu: 0.9 },
  { liters: 10000, received: 7200, frc: 0.40, ntu: 1.4 }, // short: 2,800 L missing
  { liters: 10000, received: 10000, frc: 0.08, ntu: 1.0 }, // chlorine too low
  { liters: 10000, received: 10000, frc: 0.35, ntu: 2.0 },
  { liters: 10000, received: 10000, frc: 0.45, ntu: 0.7 },
];
const water = trucks.map((t, i) => {
  const at = T0 + i * 2 * H;
  const quality = keep(qualityReading(sensor, { sensorId: "wq-07", siteId: SITE, at: at - 10 * 60000, frcMgL: t.frc, turbidityNtu: t.ntu, eColiCfu: 0 }));
  const delivery = keep(waterDelivery(operator, { deliveryId: `WD-${i + 1}`, operator: "truck-op-3", siteId: SITE, liters: t.liters, at, qualityId: quality.claimId }));
  const received = keep(waterReceived(committee, { delivery, litersReceived: t.received, at: at + 30 * 60000 }));
  return { delivery, received, quality };
});
const results = water.map((w) => verifyWaterDelivery(w, pins));
results.forEach((r, i) => out(`  ${water[i].delivery.deliveryId}  ${r.decision.padEnd(16)} credited ${String(r.litersCredited).padStart(6)} L  ${r.problems.join("; ")}`));
const cov = coverage(results, { population: POPULATION });
out(`  Safe water credited: ${cov.liters} L = ${cov.perPersonDay} L per person per day (Sphere minimum ${SPHERE.litersPerPersonDay}): ${cov.meetsStandard ? "MET" : "NOT MET"}`);
const edited = { ...water[2], delivery: { ...water[2].delivery, liters: 7200 } };
out(`  Tamper: operator edits WD-3 to claim 7,200 L after the fact -> ${verifyWaterDelivery(edited, pins).problems[0]}`);
const fakeSensor = qualityReading(genKeypair(), { ...water[3].quality, frcMgL: 0.4 });
out(`  Tamper: WD-4 backed by a reading from an unknown sensor -> ${verifyWaterDelivery({ ...water[3], quality: fakeSensor }, pins).problems[0]}`);

// ---- 2. Water: pay per liter at a kiosk ---------------------------------------------
head("2. WATER: pay-per-liter kiosk channel");
const buyer = genKeypair(), kiosk = genKeypair();
const open = keep(openChannel(buyer, { channelId: "CH-88", kioskId: "kiosk-2", kioskPub: kiosk.pub, depositSats: 200000, priceMsatPerLiter: 1500000 }));
out(`  Deposit ${open.depositSats} sats, price ${open.priceMsatPerLiter / 1000} sats per liter, metered per mL`);
const fills = [20000, 20000, 13400, 5000]; // mL per visit: two full jerrycans, a partial one, a bucket
let held = null, ml = 0;
const states = [];
for (const f of fills) {
  ml += f;
  const next = meterState(buyer, open, { seq: (held?.seq || 0) + 1, milliliters: ml });
  const a = kioskAccept(open, held, next);
  if (!a.ok) throw new Error(a.reason);
  held = next; states.push(next);
}
keep(held);
const s = settle(open, [held]);
out(`  ${fills.length} visits, ${s.liters} L: kiosk paid ${s.kioskSats} sats, buyer refunded ${s.buyerRefundSats} sats`);
out(`  Buyer closes on old state seq 2, kiosk presents seq ${held.seq} -> settles at seq ${settle(open, [states[1], held]).seq}`);
const forged = { ...held, milliliters: 120000, owedMsat: 180000000 };
out(`  Kiosk inflates the volume without the buyer's key -> ${settle(open, [forged, held]).rejected} state rejected, settles at ${settle(open, [forged, held]).kioskSats} sats`);
out(`  Buyer signs a state that lowers the volume -> kiosk refuses: ${kioskAccept(open, held, meterState(buyer, open, { seq: held.seq + 1, milliliters: 1000 })).reason}`);

// ---- 3. Food: aid handout custody ---------------------------------------------------
head("3. FOOD: aid custody from warehouse to household");
const ppl = Object.fromEntries(["warehouse", "trucker", "dist-point-1"].map((n) => [n, genKeypair()]));
const pubs = Object.fromEntries(Object.entries(ppl).map(([n, k]) => [n, k.pub]));
const route = ["warehouse", "trucker", "dist-point-1"];
const salt = "camp-north-2026-10";
const ents = Array.from({ length: 600 }, (_, i) => ({ tag: householdTag(salt, `HH-${10000 + i}`), rationKg: i % 4 === 0 ? 12.5 : 25 }));
const { manifest, tree } = aidManifest(ppl.warehouse, { consignmentId: "FA-2026-1019", entitlements: ents });
keep(manifest);
const handoffs = [
  keep(aidHandoff(ppl.trucker, { consignmentId: "FA-2026-1019", from: "warehouse", to: "trucker", kg: manifest.totalKg, at: T0 })),
  keep(aidHandoff(ppl["dist-point-1"], { consignmentId: "FA-2026-1019", from: "trucker", to: "dist-point-1", kg: manifest.totalKg - 150, at: T0 + 5 * H })),
];
const give = (i, over = {}) => aidHandout(ppl["dist-point-1"], { consignmentId: "FA-2026-1019", pointId: "dist-point-1", tag: ents[i].tag, rationKg: ents[i].rationKg, index: i, branch: entitlementProof(tree, i), at: T0 + 6 * H + i * 1000, ...over });
const handouts = ents.slice(0, 590).map((_, i) => keep(give(i)));
handouts.push(give(12)); // same household again
handouts.push(give(40, { tag: householdTag(salt, "HH-99999") })); // not on the list, borrowing a real proof
handouts.push(give(41, { rationKg: 50 })); // inflated ration
const aid = verifyAid({ manifest, handoffs, handouts }, { route, pubs });
out(`  Manifest: ${manifest.households} households, ${manifest.totalKg} kg, list committed as one Merkle root (no names)`);
for (const l of aid.losses) out(`  Loss in custody: ${l.kg} kg while held by ${l.custodian}`);
out(`  Served ${aid.householdsServed} of ${aid.households} households, ${aid.distributedKg} kg; ${aid.undistributedKg} kg still at the point`);
for (const r of aid.rejected) out(`  Rejected handout: ${r.reason} (tag ${r.tag.slice(0, 10)}...)`);
const swapped = [handoffs[0], aidHandoff(ppl.trucker, { ...handoffs[1], kg: manifest.totalKg })];
out(`  Tamper: trucker signs the point's receipt to hide the loss -> ${verifyAid({ manifest, handoffs: swapped, handouts }, { route, pubs }).problems[0]}`);

// ---- 4. Shelter: drought payout -----------------------------------------------------
head("4. SHELTER: parametric drought payout");
const insurer = genKeypair();
const src = Object.fromEntries(["gauge-network", "satellite-estimate", "met-service"].map((n) => [n, genKeypair()]));
const sourcePubs = Object.fromEntries(Object.entries(src).map(([n, k]) => [n, k.pub]));
const pol = keep(droughtPolicy(insurer, { policyId: "DRT-CN-2026", region: "camp-north-district", windowDays: 30, triggerMm: 40, quorum: 2, payoutSats: 50000000, payTo: "1ExampleShelterFundPayeeAddrXXXX" }));
const windowEnd = "2026-10-19";
const read = (n, mm) => rainReading(src[n], { source: n, region: pol.region, windowEnd, windowDays: 30, rainMm: mm });
const readings = [read("gauge-network", 22), read("satellite-estimate", 31), read("met-service", 55)];
keep(...readings);
const ev = evaluate(pol, readings, { sourcePubs, windowEnd });
out(`  Trigger: 30-day rain under ${pol.triggerMm} mm, ${pol.quorum} of 3 sources must agree`);
out(`  Readings: ${ev.readings.map((r) => `${r.source} ${r.rainMm} mm`).join(", ")}`);
out(`  ${ev.below} of ${ev.sourcesCounted} below trigger -> ${ev.triggered ? "TRIGGERED" : "not triggered"}`);
const pay = keep(payout(insurer, pol, ev, { windowEnd, settlementRef: "<txid once paid>" }));
out(`  Payout ${pay.payoutSats} sats to the policy's payee, re-verified by anyone: ${verifyPayout(pol, pay, readings, { sourcePubs }).ok ? "PASS" : "FAIL"}`);
const noisy = [read("gauge-network", 22), read("gauge-network", 70), read("satellite-estimate", 31), read("met-service", 55), rainReading(genKeypair(), { source: "random-blog", region: pol.region, windowEnd, windowDays: 30, rainMm: 5 })];
const ev2 = evaluate(pol, noisy, { sourcePubs, windowEnd });
out(`  Tamper: gauge signs two values + unknown source reports 5 mm -> ${ev2.ignored.map((x) => `${x.source}: ${x.reason}`).join("; ")} -> ${ev2.triggered ? "triggered" : "not triggered"}`);
const redirect = payout(insurer, { ...pol, payTo: "1AttackerAddrXXXXXXXXXXXXXXXXXXXX" }, ev, { windowEnd, settlementRef: "x" });
out(`  Tamper: payout redirected to another address -> ${verifyPayout(pol, { ...redirect, policyClaim: pol.claimId }, readings, { sourcePubs }).reason}`);

// ---- 5. Medicine: triage and supplies after a flood ---------------------------------
head("5. MEDICINE: triage tags and medical supplies after a flood");
const med = Object.fromEntries(["medic-a", "ccp-1", "ambulance-3", "district-hospital"].map((n) => [n, genKeypair()]));
const medPubs = Object.fromEntries(Object.entries(med).map(([n, k]) => [n, k.pub]));
const INC = "flood-cn-1019", F0 = T0 + 3 * H, M = 60000;
const cats = ["red", "red", "red", "yellow", "yellow", "yellow", "yellow", "green", "green", "green", "green", "green"];
const ctags = cats.map((_, i) => casualtyTag("flood-cn-1019-tags", `T-${4100 + i}`));
const triages = cats.map((c, i) => keep(triage(med["medic-a"], { incidentId: INC, tag: ctags[i], category: c, by: "medic-a", at: F0 + i * 2 * M })));
// Casualty 3 gets worse at the casualty collection point and is re-triaged red there.
triages.push(keep(triage(med["ccp-1"], { incidentId: INC, tag: ctags[3], category: "red", by: "ccp-1", at: F0 + 30 * M, prev: triages[3].claimId })));
const moves = [];
const move = (i, from, to, category, atMin) => moves.push(keep(casualtyHandoff(med[to], { incidentId: INC, tag: ctags[i], from, to, category, at: F0 + atMin * M })));
const evacuate = (i, category, [ccp, amb, hosp]) => {
  move(i, "medic-a", "ccp-1", cats[i], ccp);
  move(i, "ccp-1", "ambulance-3", category, amb);
  if (hosp) move(i, "ambulance-3", "district-hospital", category, hosp);
};
evacuate(0, "red", [10, 20, 45]);
evacuate(1, "red", [15, 25, 52]);
evacuate(2, "red", [20, 60, 99]); // waited for the ambulance: late
evacuate(3, "red", [25, 35, 58]);
evacuate(4, "yellow", [30, 70, 110]);
evacuate(5, "yellow", [32, 72, 112]);
evacuate(6, "yellow", [34, 74, null]); // picked up, never signed in at the hospital
for (let i = 7; i < 12; i++) move(i, "medic-a", "ccp-1", "green", 40 + i);
const cas = verifyCasualties({ triages, handoffs: moves }, { incidentId: INC, pubs: medPubs, hospitals: ["district-hospital"] });
const short = (t) => `${t.slice(0, 10)}...`;
out(`  ${cas.casualties.length} casualties tagged (salted tag numbers, no names): ${Object.entries(cas.byCategory).filter(([, n]) => n).map(([c, n]) => `${c} ${n}`).join(", ")}`);
out(`  At hospital ${cas.casualties.filter((c) => c.status === "at hospital").length}, treated on site ${cas.casualties.filter((c) => c.status === "treated on site").length}, chain ${cas.ok ? "INTACT" : "BROKEN"}`);
for (const c of cas.casualties.filter((x) => x.retriagedFrom)) out(`  Re-triaged at the collection point: ${short(c.tag)} ${c.retriagedFrom} -> ${c.category}, signed by ccp-1`);
for (const c of cas.lateRed) out(`  Red casualty ${short(c.tag)} reached hospital after ${c.minutesToHospital} min (limit 60)`);
for (const c of cas.missing) out(`  NOT ACCOUNTED FOR: ${c.category} casualty ${short(c.tag)}, last signed for by ${c.lastHolder}`);
const recheck = (handoffs) => verifyCasualties({ triages, handoffs }, { incidentId: INC, pubs: medPubs, hospitals: ["district-hospital"] }).problems[0];
const downgraded = moves.map((h) => (h.tag === ctags[0] && h.to === "ambulance-3" ? casualtyHandoff(med["ambulance-3"], { ...h, category: "yellow" }) : h));
out(`  Tamper: ambulance logs a red casualty as yellow -> ${recheck(downgraded)}`);
const fakeArrival = casualtyHandoff(med["ambulance-3"], { incidentId: INC, tag: ctags[6], from: "ambulance-3", to: "district-hospital", category: "yellow", at: F0 + 100 * M });
out(`  Tamper: ambulance signs the missing casualty in at the hospital itself -> ${recheck([...moves, fakeArrival])}`);
const backdated = moves.map((h) => (h.tag === ctags[2] && h.to === "district-hospital" ? { ...h, at: F0 + 40 * M } : h));
out(`  Tamper: late arrival time edited to look on time -> ${recheck(backdated)}`);

const reqs = [["SR-1", "IV fluid 1 L", 40], ["SR-2", "tourniquet", 10], ["SR-3", "wound dressing kit", 60]]
  .map(([requestId, item, qty]) => keep(supplyRequest(med["ccp-1"], { incidentId: INC, requestId, station: "ccp-1", item, qty, at: F0 + 15 * M })));
const rcpts = [["SR-1", 30], ["SR-3", 60]]
  .map(([requestId, qtyReceived]) => keep(supplyReceipt(med["ccp-1"], { incidentId: INC, requestId, station: "ccp-1", from: "medical-store", qtyReceived, at: F0 + 80 * M })));
const sup = verifySupplies({ requests: reqs, receipts: rcpts }, { incidentId: INC, pubs: medPubs });
for (const l of sup.lines) out(`  ${l.requestId} ${l.item.padEnd(19)} asked ${String(l.qty).padStart(3)}, received ${String(l.received).padStart(3)}: ${l.status}`);
const storeSigned = supplyReceipt(genKeypair(), { incidentId: INC, requestId: "SR-2", station: "ccp-1", from: "medical-store", qtyReceived: 10, at: F0 + 90 * M });
const sup2 = verifySupplies({ requests: reqs, receipts: [...rcpts, storeSigned] }, { incidentId: INC, pubs: medPubs });
out(`  Tamper: the store marks SR-2 received itself -> ${sup2.problems[0]}, SR-2 still ${sup2.lines.find((l) => l.requestId === "SR-2").status}`);

// ---- 6. Communication: offline store-and-forward ------------------------------------
head("6. COMMUNICATION: offline log, synced when the link returns");
const device = genKeypair(), log = [];
for (const r of allRecords) appendEntry(device, log, { deviceId: "field-tab-1", recordId: r.claimId, at: T0 });
const shuffled = [...log, log[3], log[7], log[100]].sort(() => Math.random() - 0.5);
const re = reassemble(shuffled, { deviceId: "field-tab-1", devicePub: device.pub });
out(`  ${re.received} entries arrived shuffled with resends -> ${re.count} unique, chain ${re.ok ? "INTACT" : "BROKEN"}`);
out(`  Tamper: entry 50 deleted in transit -> ${reassemble(log.filter((e) => e.seq !== 50), { deviceId: "field-tab-1", devicePub: device.pub }).problems.join("; ")}`);
const editedLog = log.map((e) => (e.seq === 9 ? { ...e, recordId: "0xdeadbeef" } : e));
out(`  Tamper: entry 9 edited -> ${reassemble(editedLog, { deviceId: "field-tab-1", devicePub: device.pub }).problems.join("; ")}`);

// ---- Anchor -------------------------------------------------------------------------
head("ANCHOR: the whole day in one Bitcoin BSV output");
const batch = anchorBatch(allRecords.map((r) => r.claimId));
out(`  ${batch.count} signed records -> Merkle root ${batch.root.slice(0, 16)}...`);
out(`  Locking script (${batch.scriptHex.length / 2} bytes): ${batch.scriptHex}`);
const k = allRecords.indexOf(water[0].delivery);
out(`  Proof that delivery WD-1 is in the batch: ${batchProof(batch, k).length} hashes -> ${inBatch(batch.root, water[0].delivery.claimId, k, batchProof(batch, k)) ? "PASS" : "FAIL"}`);
out(`  (Script built here; bin/anchor.mjs signs it, broadcasting is a separate step.)`);

const outAt = process.argv.indexOf("--out");
if (outAt > 0) {
  const dir = process.argv[outAt + 1];
  if (!dir) throw new Error("--out needs a directory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "records.json"), JSON.stringify(allRecords, null, 1) + "\n");
  const meta = { tag: ANCHOR_TAG, root: batch.root, count: batch.count, scriptHex: batch.scriptHex, createdAt: new Date().toISOString() };
  writeFileSync(join(dir, "batch.json"), JSON.stringify(meta, null, 2) + "\n");
  out(`  Saved ${batch.count} records and the batch to ${dir}`);
}
