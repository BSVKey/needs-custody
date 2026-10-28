// The field health page (site/field/) signs with WebCrypto in the browser. These tests run
// its core in Node and prove its records and the Node modules' records are interchangeable,
// and that its checks catch the same tampering as src/medical.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../site/field/core.js";
import { genKeypair } from "../lib/keys.mjs";
import { verifyRecord } from "../lib/receipt.mjs";
import * as M from "../src/medical.mjs";
import * as W from "../site/field/wire.js";

const INC = "FLOOD-TEST-01", SALT = "s3cret-salt", T0 = Date.parse("2026-10-28T08:00:00Z"), MIN = 60000;

async function field() {
  const st = {};
  for (const name of ["medic-a", "ccp-1", "hospital-1"]) st[name] = await F.genKey();
  const recs = [];
  for (const [name, kp] of Object.entries(st)) recs.push(await F.stationCard(kp, { incidentId: INC, station: name, role: name.split("-")[0], at: T0 }));
  return { st, recs };
}

test("field page records verify under the Node verifier, and Node records under the page", async () => {
  const kp = await F.genKey();
  const tag = await F.casualtyTag(SALT, "0042");
  const rec = await F.triage(kp, { incidentId: INC, tag, category: "red", by: "medic-a", at: T0 });
  assert.equal(tag, M.casualtyTag(SALT, "0042"));
  assert.deepEqual(verifyRecord(rec), { ok: true, signer: kp.pub });
  const nkp = genKeypair();
  const nrec = M.triage(nkp, { incidentId: INC, tag, category: "red", by: "medic-a", at: T0 });
  assert.deepEqual(await F.verifyRecord(nrec), { ok: true, signer: nkp.pub });
  assert.equal(await F.contentId(nrec), nrec.claimId);
});

test("saved keys reload and still sign as the same station", async () => {
  const kp = await F.genKey();
  const back = await F.loadKey(await F.saveKey(kp));
  const rec = await F.supplyRequest(back, { incidentId: INC, requestId: "SR-1", station: "ccp-1", item: "ORS sachets", qty: 200, at: T0 });
  assert.equal(rec.signerPub, kp.pub);
  assert.equal(verifyRecord(rec).ok, true);
});

test("checkAll: page results match src/medical.mjs on the same records", async () => {
  const { st, recs } = await field();
  const tagA = await F.casualtyTag(SALT, "1"), tagB = await F.casualtyTag(SALT, "2"), tagC = await F.casualtyTag(SALT, "3");
  const tA = await F.triage(st["medic-a"], { incidentId: INC, tag: tagA, category: "red", by: "medic-a", at: T0 });
  recs.push(tA,
    await F.casualtyHandoff(st["ccp-1"], { incidentId: INC, tag: tagA, from: "medic-a", to: "ccp-1", category: "red", at: T0 + 20 * MIN }),
    await F.casualtyHandoff(st["hospital-1"], { incidentId: INC, tag: tagA, from: "ccp-1", to: "hospital-1", category: "red", at: T0 + 90 * MIN }),
    await F.triage(st["medic-a"], { incidentId: INC, tag: tagB, category: "yellow", by: "medic-a", at: T0 + 5 * MIN }),
    await F.casualtyHandoff(st["ccp-1"], { incidentId: INC, tag: tagB, from: "medic-a", to: "ccp-1", category: "yellow", at: T0 + 25 * MIN }),
    await F.triage(st["medic-a"], { incidentId: INC, tag: tagC, category: "green", by: "medic-a", at: T0 + 6 * MIN }),
    await F.supplyRequest(st["ccp-1"], { incidentId: INC, requestId: "SR-1", station: "ccp-1", item: "IV fluids (1 L)", qty: 40, at: T0 }),
    await F.supplyReceipt(st["ccp-1"], { incidentId: INC, requestId: "SR-1", station: "ccp-1", from: "medical-store", qtyReceived: 25, at: T0 + 60 * MIN }));
  const res = await F.checkAll(recs, { incidentId: INC, hospitals: ["hospital-1"] });
  assert.deepEqual(res.problems, []);
  assert.equal(res.casualties.ok, true);
  assert.deepEqual(res.casualties.missing.map((c) => c.tag), [tagB]);
  assert.equal(res.casualties.missing[0].lastHolder, "ccp-1");
  assert.deepEqual(res.casualties.lateRed.map((c) => c.tag), [tagA]);
  assert.equal(res.supplies.lines[0].status, "short");

  const of = (k) => recs.filter((r) => r.kind === k);
  const node = M.verifyCasualties({ triages: of("triage/1"), handoffs: of("casualty-handoff/1") }, { incidentId: INC, pubs: res.stations, hospitals: ["hospital-1"] });
  assert.deepEqual(res.casualties, node);
  assert.deepEqual(res.supplies, M.verifySupplies({ requests: of("supply-request/1"), receipts: of("supply-receipt/1") }, { incidentId: INC, pubs: res.stations }));
});

test("checkAll catches tampering, an impostor and a second key for one station name", async () => {
  const { st, recs } = await field();
  const tag = await F.casualtyTag(SALT, "7");
  const t = await F.triage(st["medic-a"], { incidentId: INC, tag, category: "red", by: "medic-a", at: T0 });
  const edited = { ...t, category: "green" };
  const impostor = await F.casualtyHandoff(await F.genKey(), { incidentId: INC, tag, from: "medic-a", to: "hospital-1", category: "red", at: T0 + 30 * MIN });
  const rival = await F.stationCard(await F.genKey(), { incidentId: INC, station: "hospital-1", role: "hospital", at: T0 + 1 });
  const res = await F.checkAll([...recs, edited, impostor, rival], { incidentId: INC, hospitals: ["hospital-1"] });
  assert.ok(res.problems.some((p) => p.includes("different keys claim this name")));
  assert.equal(res.stations["hospital-1"], undefined, "a contested name is trusted for neither key");
  assert.ok(res.casualties.problems.some((p) => p.includes("claimId_mismatch")));
  assert.ok(res.casualties.problems.some((p) => p.includes("no_pinned_key")), "the contested hospital name pins no key");
  assert.equal(res.casualties.casualties.length, 0, "the edited triage and impostor handoff leave nothing trusted");
});

test("vaccine logger: same totals and fingerprint rules as pharma-custody", async () => {
  const rows = ["timestamp,temp_c"];
  for (let i = 0; i <= 72; i++) {
    const t = T0 + i * 5 * MIN;
    if (i > 20 && i < 29) continue;                          // logger silent 45 min
    rows.push(`${new Date(t).toISOString()},${i >= 40 && i < 47 ? -0.8 : 5}`); // 35 min frozen
  }
  const { samples, rejected } = F.parseLoggerCsv(rows.join("\n"));
  assert.equal(rejected, 0);
  const j = F.judgeLogger(samples);
  assert.equal(j.excursionMinutes, 35);
  assert.equal(j.gapMinutes, 45);
  assert.equal(j.decision, "quarantine");
  assert.equal(j.frozen, true);
  const kp = await F.genKey();
  const fp = await F.fingerprint(samples);
  const rec = await F.vaccineReceipt(kp, { incidentId: INC, shipmentId: "VAX-1", station: "clinic-1", vials: 500, arrivalTempC: 3.1, decision: j.decision, logger: { fingerprint: fp, excursionMinutes: j.excursionMinutes, gapMinutes: j.gapMinutes }, at: T0 });
  assert.equal(verifyRecord(rec).ok, true);
  const card = await F.stationCard(kp, { incidentId: INC, station: "clinic-1", role: "clinic", at: T0 });
  const res = await F.checkAll([card, rec], { incidentId: INC, hospitals: [] });
  assert.equal(res.vaccines.lines.length, 1);
});

test("mergeRecords drops exact copies and junk, but an edited copy can't shadow the genuine one", async () => {
  const { st, recs } = await field();
  const tag = await F.casualtyTag(SALT, "9");
  const t = await F.triage(st["medic-a"], { incidentId: INC, tag, category: "red", by: "medic-a", at: T0 });
  const edited = { ...t, category: "green" };
  const m = await F.mergeRecords([edited], [t, { ...t }, null, [1], { nope: 1 }]);
  assert.equal(m.added, 1);
  assert.equal(m.all.length, 2);
  const res = await F.checkAll([...recs, ...m.all], { incidentId: INC, hospitals: [] });
  assert.equal(res.casualties.casualties.length, 1);
  assert.equal(res.casualties.casualties[0].category, "red");
  assert.ok(res.casualties.problems.some((p) => p.includes("claimId_mismatch")));
});

test("station names: a contested name fails closed until the coordinator confirms one key", async () => {
  const { st, recs } = await field();
  const rival = await F.stationCard(await F.genKey(), { incidentId: INC, station: "hospital-1", role: "hospital", at: T0 - 1 });
  const tag = await F.casualtyTag(SALT, "5");
  const all = [rival, ...recs,
    await F.triage(st["medic-a"], { incidentId: INC, tag, category: "red", by: "medic-a", at: T0 }),
    await F.casualtyHandoff(st["hospital-1"], { incidentId: INC, tag, from: "medic-a", to: "hospital-1", category: "red", at: T0 + 30 * MIN })];
  const before = await F.checkAll(all, { incidentId: INC, hospitals: ["hospital-1"] });
  assert.ok(before.casualties.problems.some((p) => p.includes("no_pinned_key")));
  assert.deepEqual(before.stationList.filter((s) => s.name === "hospital-1").map((s) => s.status), ["conflict", "conflict"]);
  const after = await F.checkAll(all, { incidentId: INC, hospitals: ["hospital-1"], approved: { "hospital-1": st["hospital-1"].pub } });
  assert.equal(after.casualties.ok, true);
  assert.equal(after.casualties.casualties[0].status, "at hospital");
  const confirmed = after.stationList.filter((s) => s.name === "hospital-1");
  assert.deepEqual(confirmed.map((s) => [s.status, s.trusted]).sort(), [["confirmed", false], ["confirmed", true]]);
  assert.match(confirmed[0].code, /^[0-9A-F]{3}-[0-9A-F]{3}$/);
});

test("QR and sound frames: any order, repeats ignored, records come back verifiable", async () => {
  const { st, recs } = await field();
  const tag = await F.casualtyTag(SALT, "12");
  const t = await F.triage(st["medic-a"], { incidentId: INC, tag, category: "yellow", by: "medic-a", at: T0 });
  const bundle = W.casualtyBundle([...recs, t], tag);
  assert.deepEqual(bundle.map((r) => r.kind), ["station/1", "triage/1"]);
  for (const size of [W.QR_CHUNK, W.SOUND_CHUNK]) {
    const frames = await W.toFrames(await W.packRecords(bundle), size);
    assert.ok(frames.every((f) => f.length <= size + 20));
    if (size === W.SOUND_CHUNK) assert.ok(frames.every((f) => f.length <= 140), "one ggwave message holds 140 characters");
    const asm = W.assembler();
    let done;
    for (const f of [...frames.slice().reverse(), frames[0]]) { const r = await asm.add(W.parseFrame(f)); if (r.payload) done = r.payload; }
    const back = await W.unpackRecords(done);
    assert.deepEqual(back.map((r) => r.claimId), bundle.map((r) => r.claimId));
    for (const r of back) assert.equal(verifyRecord(r).ok, true);
    assert.deepEqual(W.casualtyState(back, tag), { tag, category: "yellow", holder: "medic-a" });
  }
  const one = await W.toFrames(await W.packRecords([t]), W.QR_CHUNK);
  assert.equal(one.length, 1);
  assert.ok(W.parseFrame(`https://needs.bsvkey.com/field/#${one[0]}`), "a link from a phone camera app parses");
});

test("frames from two transfers can't be mixed, and an edited record is caught after transfer", async () => {
  const { st, recs } = await field();
  const a = await W.toFrames(await W.packRecords(recs), 60), b = await W.toFrames(await W.packRecords(recs.slice(1)), 60);
  const asm = W.assembler();
  const mixed = { ...W.parseFrame(a[0]), data: W.parseFrame(b[0]).data };
  await asm.add(mixed);
  let r;
  for (const f of a.slice(1)) r = await asm.add(W.parseFrame(f));
  assert.deepEqual(r, { corrupt: true });
  const t = await F.triage(st["medic-a"], { incidentId: INC, tag: "ab", category: "red", by: "medic-a", at: T0 });
  const [back] = await W.unpackRecords(await W.packRecords([{ ...t, category: "green" }]));
  const res = await F.checkAll([...recs, back], { incidentId: INC, hospitals: [] });
  assert.ok(res.casualties.problems.some((p) => p.includes("signature_invalid")));
});
