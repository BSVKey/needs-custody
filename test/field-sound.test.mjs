// Records as sound, end to end in Node: a casualty bundle is cut into frames, each frame is
// encoded by ggwave exactly as the page plays it, the audio is resampled to 44.1 kHz (a common
// phone microphone rate) with noise added, then decoded and reassembled. Needs the page's dev
// dependencies (npm install); skipped without them.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../site/field/core.js";
import * as W from "../site/field/wire.js";
import { ggwaveCodec, QUIET, RATE } from "../field-src/sound.mjs";

// The ggwave module loads once per process and holds only a few instances, so one sending
// and one receiving codec serve every test.
let tx = null, rx = null;
try {
  const gg = await (await import("ggwave")).default(QUIET);
  tx = ggwaveCodec(gg); rx = ggwaveCodec(gg, { inputRate: 44100 });
} catch { /* not installed */ }

// Linear resample from 48 kHz to `rate`, plus a little white noise.
function capture(x, rate, noise) {
  const step = RATE / rate, out = new Float32Array(Math.floor(x.length / step));
  for (let i = 0; i < out.length; i++) {
    const p = i * step, j = Math.floor(p), f = p - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? 0) * f + (Math.random() * 2 - 1) * noise;
  }
  return out;
}

// The four sound types the page offers.
for (const speed of ["fast", "fastest", "dt-fast", "dt-normal"]) {
  test(`sound: a casualty bundle survives ggwave ${speed} at 44.1 kHz with noise`, { skip: !tx && "ggwave not installed" }, async () => {
    const medic = await F.genKey();
    const tag = await F.casualtyTag("salt", "77");
    const bundle = [
      await F.stationCard(medic, { incidentId: "INC", station: "medic-a", role: "medic", at: 1 }),
      await F.triage(medic, { incidentId: "INC", tag, category: "red", by: "medic-a", at: 2 }),
    ];
    const frames = await W.toFrames(await W.packRecords(bundle), W.SOUND_CHUNK);
    const silence = new Float32Array(RATE / 2);
    const audio = [];
    for (const f of frames) audio.push(tx.encode(f, speed), silence);
    const all = new Float32Array(audio.reduce((n, a) => n + a.length, 0));
    let o = 0; for (const a of audio) { all.set(a, o); o += a.length; }
    // Dual-tone occasionally misses one message (about 1 in 24 in measurements, whatever the
    // noise), so the page offers "Play again" and keeps the parts it has. Up to two plays here.
    const asm = W.assembler();
    let payload = null;
    for (let play = 0; play < 2 && !payload; play++) {
      const mic = capture(all, 44100, 0.02);
      for (let i = 0; i < mic.length && !payload; i += 4096) {
        for (const text of rx.decode(mic.subarray(i, i + 4096))) {
          const f = W.parseFrame(text);
          const r = f && await asm.add(f);
          if (r?.payload) payload = r.payload;
        }
      }
    }
    assert.ok(payload, `decoded all ${frames.length} frames within two plays`);
    const back = await W.unpackRecords(payload);
    assert.deepEqual(back.map((r) => r.claimId), bundle.map((r) => r.claimId));
    for (const r of back) assert.equal((await F.verifyRecord(r)).ok, true);
  });
}
