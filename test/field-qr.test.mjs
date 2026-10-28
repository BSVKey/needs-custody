// Records as QR codes, end to end in Node: frames are drawn with qrcode-generator exactly as
// the page draws them, rasterised, and read back with jsQR (the page's camera fallback).
// Needs the page's dev dependencies (npm install); skipped without them.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../site/field/core.js";
import * as W from "../site/field/wire.js";

let qrcode = null, jsQR = null;
try { qrcode = (await import("qrcode-generator")).default; jsQR = (await import("jsqr")).default; } catch { /* not installed */ }

function read(text, px = 4) {
  const q = qrcode(0, "L"); q.addData(text, "Byte"); q.make();
  const n = q.getModuleCount(), quiet = 4, size = (n + 2 * quiet) * px, img = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c))
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) { const i = (((r + quiet) * px + y) * size + (c + quiet) * px + x) * 4; img[i] = img[i + 1] = img[i + 2] = 0; }
  return { modules: n, text: jsQR(img, size, size)?.data ?? null };
}

test("QR: a casualty handover link and a multi-code transfer read back exactly", { skip: !jsQR && "QR libraries not installed" }, async () => {
  const medic = await F.genKey(), recs = [await F.stationCard(medic, { incidentId: "FLOOD-2026-11-A", station: "medic-team-2", role: "medic", at: 1 })];
  for (let i = 0; i < 12; i++) recs.push(await F.triage(medic, { incidentId: "FLOOD-2026-11-A", tag: await F.casualtyTag("salt", String(i)), category: F.CATEGORIES[i % 4], by: "medic-team-2", at: 2 + i }));
  const one = await W.toFrames(await W.packRecords(W.casualtyBundle(recs, recs[1].tag)), W.QR_CHUNK);
  assert.equal(one.length, 1);
  const link = `https://needs.bsvkey.com/field/#${one[0]}`;
  const got = read(link);
  assert.equal(got.text, link);
  assert.ok(got.modules <= 101, `a phone screen shows ${got.modules} modules comfortably`);

  const many = await W.toFrames(await W.packRecords(recs), W.QR_CHUNK);
  assert.ok(many.length > 1);
  const asm = W.assembler();
  let payload;
  for (const f of many) { const r = await asm.add(W.parseFrame(read(f).text)); if (r.payload) payload = r.payload; }
  const back = await W.unpackRecords(payload);
  assert.deepEqual(back.map((r) => r.claimId), recs.map((r) => r.claimId));
});
