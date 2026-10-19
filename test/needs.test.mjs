import { test } from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../lib/keys.mjs";
import { qualityReading, waterDelivery, waterReceived, verifyWaterDelivery, coverage } from "../src/water.mjs";
import { openChannel, meterState, kioskAccept, settle } from "../src/meter.mjs";
import { householdTag, aidManifest, entitlementProof, aidHandoff, aidHandout, verifyAid } from "../src/aid.mjs";
import { droughtPolicy, rainReading, evaluate, payout, verifyPayout } from "../src/parametric.mjs";
import { appendEntry, reassemble } from "../src/offline.mjs";
import { anchorBatch, batchProof, inBatch } from "../src/anchor.mjs";

const T = Date.parse("2026-10-19T06:00:00Z");

function waterFixture({ frc = 0.4, ntu = 1, ecoli = 0, liters = 10000, received = 10000, readingLagMs = 0 } = {}) {
  const op = genKeypair(), site = genKeypair(), sensor = genKeypair();
  const quality = qualityReading(sensor, { sensorId: "s", siteId: "A", at: T - readingLagMs, frcMgL: frc, turbidityNtu: ntu, eColiCfu: ecoli });
  const delivery = waterDelivery(op, { deliveryId: "D1", operator: "op", siteId: "A", liters, at: T, qualityId: quality.claimId });
  const rec = waterReceived(site, { delivery, litersReceived: received, at: T + 1 });
  return { w: { delivery, received: rec, quality }, pins: { operatorPub: op.pub, sitePub: site.pub, sensorPub: sensor.pub }, op, site, sensor };
}

test("water: honest delivery is safe and fully credited", () => {
  const { w, pins } = waterFixture();
  const r = verifyWaterDelivery(w, pins);
  assert.equal(r.decision, "delivered-safe");
  assert.equal(r.litersCredited, 10000);
});

test("water: each unsafe parameter credits zero liters", () => {
  for (const bad of [{ frc: 0.1 }, { ntu: 5 }, { ecoli: 3 }]) {
    const { w, pins } = waterFixture(bad);
    const r = verifyWaterDelivery(w, pins);
    assert.equal(r.decision, "delivered-unsafe");
    assert.equal(r.litersCredited, 0);
  }
});

test("water: short delivery credits only what the site received", () => {
  const { w, pins } = waterFixture({ received: 6000 });
  const r = verifyWaterDelivery(w, pins);
  assert.equal(r.decision, "short");
  assert.equal(r.litersCredited, 6000);
});

test("water: edits, swapped keys, unlinked or stale readings are unverified", () => {
  const { w, pins, site } = waterFixture();
  assert.equal(verifyWaterDelivery({ ...w, delivery: { ...w.delivery, liters: 20000 } }, pins).decision, "unverified");
  assert.equal(verifyWaterDelivery(w, { ...pins, sitePub: genKeypair().pub }).decision, "unverified");
  const other = waterFixture({ frc: 0.45 }); // different content, so a different claimId
  assert.equal(verifyWaterDelivery({ ...w, quality: other.w.quality }, { ...pins, sensorPub: other.pins.sensorPub }).decision, "unverified");
  const stale = waterFixture({ readingLagMs: 5 * 3600000 });
  assert.equal(verifyWaterDelivery(stale.w, stale.pins).decision, "unverified");
  const forgedReceipt = waterReceived(site, { delivery: { ...w.delivery, claimId: "0x00" }, litersReceived: 10000, at: T });
  assert.equal(verifyWaterDelivery({ ...w, received: forgedReceipt }, pins).decision, "unverified");
});

test("water: coverage against 15 L per person per day", () => {
  assert.equal(coverage([{ litersCredited: 30000 }], { population: 2000 }).meetsStandard, true);
  assert.equal(coverage([{ litersCredited: 29000 }], { population: 2000 }).meetsStandard, false);
});

test("meter: per-mL billing, newest state wins, forgeries and over-deposit rejected", () => {
  const buyer = genKeypair(), kiosk = genKeypair();
  const open = openChannel(buyer, { channelId: "C", kioskId: "K", kioskPub: kiosk.pub, depositSats: 1000, priceMsatPerLiter: 1500 });
  const s1 = meterState(buyer, open, { seq: 1, milliliters: 333 });
  assert.equal(s1.owedMsat, 500); // 0.333 L * 1.5 sats, rounded up to the millisat
  assert.deepEqual(kioskAccept(open, null, s1), { ok: true });
  const s2 = meterState(buyer, open, { seq: 2, milliliters: 1000 });
  assert.equal(kioskAccept(open, s1, s2).ok, true);
  assert.equal(kioskAccept(open, s2, meterState(buyer, open, { seq: 4, milliliters: 2000 })).reason, "not the next seq");
  assert.equal(kioskAccept(open, s2, meterState(buyer, open, { seq: 3, milliliters: 10 })).reason, "volume went down");
  const st = settle(open, [s1, s2]);
  assert.equal(st.seq, 2);
  assert.equal(st.kioskSats, 2); // 1500 msat -> 2 whole sats
  assert.equal(st.buyerRefundSats, 998);
  const forged = meterState(kiosk, open, { seq: 9, milliliters: 5000 });
  assert.equal(settle(open, [s2, forged]).seq, 2);
  assert.equal(settle(open, [meterState(buyer, open, { seq: 3, milliliters: 10000000 })]).ok, false);
});

function aidFixture() {
  const k = { warehouse: genKeypair(), trucker: genKeypair(), point: genKeypair() };
  const pubs = Object.fromEntries(Object.entries(k).map(([n, x]) => [n, x.pub]));
  const route = ["warehouse", "trucker", "point"];
  const ents = Array.from({ length: 7 }, (_, i) => ({ tag: householdTag("s", `H${i}`), rationKg: 25 }));
  const { manifest, tree } = aidManifest(k.warehouse, { consignmentId: "X", entitlements: ents });
  const handoffs = [
    aidHandoff(k.trucker, { consignmentId: "X", from: "warehouse", to: "trucker", kg: 175, at: T }),
    aidHandoff(k.point, { consignmentId: "X", from: "trucker", to: "point", kg: 150, at: T }),
  ];
  const give = (i, o = {}) => aidHandout(k.point, { consignmentId: "X", pointId: "point", tag: ents[i].tag, rationKg: 25, index: i, branch: entitlementProof(tree, i), at: T, ...o });
  return { k, pubs, route, ents, manifest, tree, handoffs, give };
}

test("aid: loss pinned to the holder, entitlements proven, double and fake claims rejected", () => {
  const f = aidFixture();
  const handouts = [f.give(0), f.give(1), f.give(2), f.give(0), f.give(3, { tag: householdTag("s", "nobody") }), f.give(4, { rationKg: 50 }), f.give(5, { index: 6 })];
  const v = verifyAid({ manifest: f.manifest, handoffs: f.handoffs, handouts }, { route: f.route, pubs: f.pubs });
  assert.equal(v.authentic, true);
  assert.deepEqual(v.losses, [{ custodian: "trucker", kg: 25 }]);
  assert.equal(v.householdsServed, 3);
  assert.deepEqual(v.rejected.map((r) => r.reason), ["double claim", "not entitled", "not entitled", "not entitled"]);
  assert.equal(v.undistributedKg, 75);
});

test("aid: wrong signer, chain break, or missing pin fails closed", () => {
  const f = aidFixture();
  const byGiver = [f.handoffs[0], aidHandoff(f.k.trucker, { ...f.handoffs[1] })];
  assert.equal(verifyAid({ manifest: f.manifest, handoffs: byGiver, handouts: [] }, f).authentic, false);
  const skip = [f.handoffs[0], aidHandoff(f.k.point, { consignmentId: "X", from: "warehouse", to: "point", kg: 175, at: T })];
  assert.match(verifyAid({ manifest: f.manifest, handoffs: skip, handouts: [] }, f).problems[0], /chain break/);
  const { trucker, ...noTrucker } = f.pubs;
  assert.match(verifyAid({ manifest: f.manifest, handoffs: f.handoffs, handouts: [] }, { route: f.route, pubs: noTrucker }).problems[0], /no_pinned_key/);
});

function rainFixture(values) {
  const ins = genKeypair();
  const keys = Object.fromEntries(Object.keys(values).map((n) => [n, genKeypair()]));
  const sourcePubs = Object.fromEntries(Object.entries(keys).map(([n, x]) => [n, x.pub]));
  const pol = droughtPolicy(ins, { policyId: "P", region: "R", windowDays: 30, triggerMm: 40, quorum: 2, payoutSats: 1000, payTo: "1Payee" });
  const read = (n, mm, kp = keys[n]) => rainReading(kp, { source: n, region: "R", windowEnd: "2026-10-19", windowDays: 30, rainMm: mm });
  return { ins, pol, sourcePubs, read, readings: Object.entries(values).map(([n, mm]) => read(n, mm)) };
}

test("parametric: quorum of distinct pinned sources triggers a verifiable payout", () => {
  const f = rainFixture({ a: 10, b: 30, c: 60 });
  const ev = evaluate(f.pol, f.readings, { sourcePubs: f.sourcePubs, windowEnd: "2026-10-19" });
  assert.equal(ev.triggered, true);
  const pay = payout(f.ins, f.pol, ev, { windowEnd: "2026-10-19", settlementRef: "t" });
  assert.deepEqual(verifyPayout(f.pol, pay, f.readings, { sourcePubs: f.sourcePubs }), { ok: true });
});

test("parametric: one source cannot make quorum alone, unpinned sources and equivocators are ignored", () => {
  const f = rainFixture({ a: 10, b: 50, c: 60 });
  const extra = [f.read("a", 11), f.read("a", 10), rainReading(genKeypair(), { source: "z", region: "R", windowEnd: "2026-10-19", windowDays: 30, rainMm: 1 })];
  const ev = evaluate(f.pol, [...f.readings, ...extra], { sourcePubs: f.sourcePubs, windowEnd: "2026-10-19" });
  assert.equal(ev.triggered, false);
  assert.deepEqual(ev.ignored.map((x) => x.reason).sort(), ["equivocation: two values for one window", "source not pinned"]);
  const forgedA = f.read("b", 5, genKeypair()); // claims to be b, signed by someone else
  assert.equal(evaluate(f.pol, [...f.readings, forgedA], { sourcePubs: f.sourcePubs, windowEnd: "2026-10-19" }).triggered, false);
});

test("parametric: payouts not matching the evidence or the policy fail", () => {
  const f = rainFixture({ a: 10, b: 30, c: 60 });
  const ev = evaluate(f.pol, f.readings, { sourcePubs: f.sourcePubs, windowEnd: "2026-10-19" });
  const ok = payout(f.ins, f.pol, ev, { windowEnd: "2026-10-19", settlementRef: "t" });
  assert.equal(verifyPayout(f.pol, ok, f.readings.slice(0, 1), { sourcePubs: f.sourcePubs }).ok, false);
  const big = payout(f.ins, { ...f.pol, payoutSats: 9999 }, ev, { windowEnd: "2026-10-19", settlementRef: "t" });
  assert.equal(verifyPayout(f.pol, { ...big, policyClaim: f.pol.claimId }, f.readings, { sourcePubs: f.sourcePubs }).ok, false);
  const notInsurer = payout(genKeypair(), f.pol, ev, { windowEnd: "2026-10-19", settlementRef: "t" });
  assert.equal(verifyPayout(f.pol, notInsurer, f.readings, { sourcePubs: f.sourcePubs }).ok, false);
});

test("offline: shuffled resends reassemble; deletion, edit and fork are caught", () => {
  const d = genKeypair(), log = [];
  for (let i = 0; i < 20; i++) appendEntry(d, log, { deviceId: "dev", recordId: `0x${i}`, at: T });
  const ctx = { deviceId: "dev", devicePub: d.pub };
  const r = reassemble([...log].reverse().concat(log[2], log[5]), ctx);
  assert.equal(r.ok, true);
  assert.equal(r.count, 20);
  assert.deepEqual(r.recordIds, log.map((e) => e.recordId));
  assert.deepEqual(reassemble(log.filter((e) => e.seq !== 7), ctx).problems, ["missing seq 7"]);
  assert.equal(reassemble(log.slice(0, 19), ctx).ok, true); // a truncated tail looks complete; the anchor covers that
  const fork = [];
  for (let i = 0; i < 3; i++) appendEntry(d, fork, { deviceId: "dev", recordId: `0xf${i}`, at: T });
  assert.match(reassemble([...log, fork[0]], ctx).problems[0], /fork at seq 1/);
  assert.equal(reassemble(log, { deviceId: "dev", devicePub: genKeypair().pub }).ok, false);
});

test("anchor: 50-byte OP_FALSE OP_RETURN script; inclusion proofs bind to position", () => {
  const ids = Array.from({ length: 13 }, (_, i) => "0x" + String(i).padStart(64, "0"));
  const b = anchorBatch(ids);
  assert.equal(b.scriptHex.length / 2, 50);
  assert.ok(b.scriptHex.startsWith("006a0e"));
  for (let i = 0; i < ids.length; i++) assert.equal(inBatch(b.root, ids[i], i, batchProof(b, i)), true);
  assert.equal(inBatch(b.root, ids[3], 4, batchProof(b, 3)), false);
  assert.equal(inBatch(b.root, "0x" + "f".repeat(64), 3, batchProof(b, 3)), false);
});
