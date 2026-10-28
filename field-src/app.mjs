// Field health kit page. Everything happens on the phone: keys, signing, the records list
// and the coordinator check. Records leave only when the person saves, copies, shows a QR
// code or plays them as sound. Built into site/field/app.js and site/field/kit.html by
// bin/build-field.mjs.
import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import ggwaveFactory from "ggwave";
import * as F from "../site/field/core.js";
import * as W from "../site/field/wire.js";
import { ggwaveCodec, QUIET, RATE } from "./sound.mjs";

const STORE = "field-health-v1";
const KIT = location.protocol === "file:";
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const short = (tag) => String(tag).slice(0, 8);
const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ROLES = { medic: "Field medic", collection: "Casualty collection point", hospital: "Hospital", clinic: "Clinic", store: "Medical store", coordinator: "Coordinator" };

let state = null, kp = null, judged = null, lastTag = null, report = null, pendingPayload = null;

function read() { try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; } }
function write() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { notice("This browser won't keep records between visits (private window?). Save a records file before closing.", "bad"); } }

function notice(text, kind = "good") {
  const n = $("#notice");
  n.textContent = text; n.className = `notice ${kind}`; n.hidden = false;
}

async function keep(rec) {
  state.records.push(rec);
  state.unsaved = true;
  write();
  render();
  return rec;
}

// ---- Setup ----
async function setUp({ incidentId, salt, station, role, hospitals, redLimit }) {
  const k = await F.genKey();
  kp = k;
  state = {
    incident: { incidentId, salt, hospitals, redLimitMin: redLimit },
    station: { name: station, role }, key: await F.saveKey(k), records: [], unsaved: false, approved: {},
  };
  state.records.push(await F.stationCard(kp, { incidentId, station, role, at: Date.now() }));
  write();
}

$("#setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const hospitals = String(f.get("hospitals") || "").split(",").map((s) => s.trim()).filter(Boolean);
  await setUp({ incidentId: f.get("incidentId").trim(), salt: f.get("salt"), station: f.get("station").trim(), role: f.get("role"), hospitals, redLimit: Number(f.get("redLimit")) || 60 });
  await afterBoot(START[f.get("role")] || "triage");
});

// The sample incident: other stations' keys exist only while it is built, then are dropped.
$("#sample").addEventListener("click", async () => {
  const INC = "SAMPLE-FLOOD", SALT = "sample-salt", M = F.MIN, T0 = Date.now() - 4 * 60 * M;
  await setUp({ incidentId: INC, salt: SALT, station: "coordinator", role: "coordinator", hospitals: ["district-hospital"], redLimit: 60 });
  const s = {};
  const add = (r) => state.records.push(r);
  for (const [name, role] of [["medic-team-2", "medic"], ["collection-point-1", "collection"], ["district-hospital", "hospital"], ["rural-clinic", "clinic"]]) {
    s[name] = await F.genKey();
    add(await F.stationCard(s[name], { incidentId: INC, station: name, role, at: T0 }));
  }
  // A phone that wrongly calls itself the hospital: the check refuses to trust either key
  // for that name until the coordinator confirms the right one by its station code.
  add(await F.stationCard(await F.genKey(), { incidentId: INC, station: "district-hospital", role: "hospital", at: T0 + 30 * M }));
  const tag = (n) => F.casualtyTag(SALT, n);
  const [a, b, c, d] = await Promise.all(["1101", "1102", "1103", "1104"].map(tag));
  add(await F.triage(s["medic-team-2"], { incidentId: INC, tag: a, category: "red", by: "medic-team-2", at: T0 }));
  add(await F.casualtyHandoff(s["collection-point-1"], { incidentId: INC, tag: a, from: "medic-team-2", to: "collection-point-1", category: "red", at: T0 + 25 * M }));
  add(await F.casualtyHandoff(s["district-hospital"], { incidentId: INC, tag: a, from: "collection-point-1", to: "district-hospital", category: "red", at: T0 + 95 * M }));
  add(await F.triage(s["medic-team-2"], { incidentId: INC, tag: b, category: "yellow", by: "medic-team-2", at: T0 + 4 * M }));
  add(await F.casualtyHandoff(s["collection-point-1"], { incidentId: INC, tag: b, from: "medic-team-2", to: "collection-point-1", category: "yellow", at: T0 + 30 * M }));
  const tc = await F.triage(s["medic-team-2"], { incidentId: INC, tag: c, category: "green", by: "medic-team-2", at: T0 + 6 * M });
  add(tc);
  add(await F.casualtyHandoff(s["collection-point-1"], { incidentId: INC, tag: c, from: "medic-team-2", to: "collection-point-1", category: "green", at: T0 + 32 * M }));
  add(await F.triage(s["collection-point-1"], { incidentId: INC, tag: c, category: "red", by: "collection-point-1", at: T0 + 50 * M, prev: tc.claimId }));
  add(await F.casualtyHandoff(s["district-hospital"], { incidentId: INC, tag: c, from: "collection-point-1", to: "district-hospital", category: "red", at: T0 + 85 * M }));
  add(await F.triage(s["medic-team-2"], { incidentId: INC, tag: d, category: "green", by: "medic-team-2", at: T0 + 8 * M }));
  add(await F.supplyRequest(s["collection-point-1"], { incidentId: INC, requestId: "collection-point-1/1", station: "collection-point-1", item: "IV fluids (1 L)", qty: 40, at: T0 + 10 * M }));
  add(await F.supplyReceipt(s["collection-point-1"], { incidentId: INC, requestId: "collection-point-1/1", station: "collection-point-1", from: "medical-store", qtyReceived: 25, at: T0 + 120 * M }));
  add(await F.supplyRequest(s["collection-point-1"], { incidentId: INC, requestId: "collection-point-1/2", station: "collection-point-1", item: "ORS sachets", qty: 300, at: T0 + 12 * M }));
  const rows = ["timestamp,temp_c"];
  for (let i = 0; i <= 72; i++) rows.push(`${new Date(T0 + i * 5 * M).toISOString()},${i >= 30 && i < 45 ? -0.8 : 5}`);
  const { samples } = F.parseLoggerCsv(rows.join("\n"));
  const j = F.judgeLogger(samples);
  add(await F.vaccineReceipt(s["rural-clinic"], { incidentId: INC, shipmentId: "VAX-0117", station: "rural-clinic", vials: 500, arrivalTempC: 3.1, decision: "release", logger: { fingerprint: await F.fingerprint(samples), samples: j.samples, excursionMinutes: j.excursionMinutes, gapMinutes: j.gapMinutes, chargedMinutes: j.chargedMinutes, budgetMinutes: j.budgetMinutes, minC: j.minC, maxC: j.maxC }, at: T0 + 200 * M }));
  state.sampleCodes = { "district-hospital": await F.stationCode(s["district-hospital"].pub) };
  write();
  show("check");
  await runCheck();
});

$("#reset").addEventListener("click", () => {
  if (state?.unsaved && !confirm("This phone has records you haven't passed on yet. Start over and lose them?")) return;
  if (!state?.unsaved && !confirm("Start over? This removes this station and its key from this phone.")) return;
  try { localStorage.removeItem(STORE); } catch { /* nothing kept */ }
  state = null; kp = null;
  boot();
});

// ---- Forms ----
const inc = () => state.incident.incidentId;
const me = () => state.station.name;

$("#f-triage").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const tag = await F.casualtyTag(state.incident.salt, f.get("tagNumber"));
  const earlier = state.records.filter((r) => r.kind === "triage/1" && r.tag === tag && r.incidentId === inc()).sort((a, b) => a.at - b.at).at(-1);
  await keep(await F.triage(kp, { incidentId: inc(), tag, category: f.get("category"), by: me(), at: Date.now(), prev: earlier ? earlier.claimId : null }));
  notice(earlier ? `Re-triage signed: ${earlier.category} to ${f.get("category")}, linked to the earlier record.` : `Triage signed for tag ${f.get("tagNumber")} (${f.get("category")}).`);
  lastTag = tag;
  $("#handover-tag").textContent = f.get("tagNumber");
  $("#handover").hidden = false;
  e.target.reset();
});

async function take(tag, from, category) {
  await keep(await F.casualtyHandoff(kp, { incidentId: inc(), tag, from, to: me(), category, at: Date.now() }));
}

$("#f-take").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const tag = await F.casualtyTag(state.incident.salt, f.get("tagNumber"));
  await take(tag, f.get("from").trim(), f.get("category"));
  notice(`Signed: ${me()} has the casualty with tag ${f.get("tagNumber")}.`);
  e.target.reset();
});

$("#f-request").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const n = state.records.filter((r) => r.kind === "supply-request/1" && r.station === me()).length + 1;
  await keep(await F.supplyRequest(kp, { incidentId: inc(), requestId: `${me()}/${n}`, station: me(), item: f.get("item").trim(), qty: Number(f.get("qty")), at: Date.now() }));
  notice(`Request ${me()}/${n} signed. Pass it to the store on Share (QR, sound or file).`);
  e.target.reset();
});

$("#f-receive").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await keep(await F.supplyReceipt(kp, { incidentId: inc(), requestId: f.get("requestId"), station: me(), from: f.get("from").trim(), qtyReceived: Number(f.get("qtyReceived")), at: Date.now() }));
  notice(`Receipt signed: ${f.get("qtyReceived")} arrived for ${f.get("requestId")}.`);
  e.target.reset();
});

$("#f-vax").file.addEventListener("change", async (e) => {
  const box = $("#vax-judge");
  judged = null;
  const file = e.target.files[0];
  if (!file) { box.hidden = true; return; }
  try {
    const { samples, rejected } = F.parseLoggerCsv(await file.text());
    const j = F.judgeLogger(samples);
    judged = { fingerprint: await F.fingerprint(samples), samples: j.samples, excursionMinutes: j.excursionMinutes, gapMinutes: j.gapMinutes, chargedMinutes: j.chargedMinutes, budgetMinutes: j.budgetMinutes, minC: j.minC, maxC: j.maxC };
    box.className = `notice ${j.decision === "release" ? "good" : "bad"}`;
    box.textContent = `${j.samples} readings, ${j.minC} to ${j.maxC} °C. Outside 2 to 8 °C: ${j.excursionMinutes} min. Logger silent: ${j.gapMinutes} min. Counted against the ${j.budgetMinutes}-minute budget: ${j.chargedMinutes} min, so the logger says ${j.decision.toUpperCase()}.${j.frozen ? " The box went below 0 °C: do a shake test on freeze-sensitive vaccines." : ""}${rejected ? ` ${rejected} unreadable rows were skipped.` : ""}`;
    e.target.form.decision.value = j.decision;
  } catch (err) {
    box.className = "notice bad"; box.textContent = `Couldn't read that file: ${err.message}`;
  }
  box.hidden = false;
});

$("#f-vax").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (!judged && !confirm("No logger file was loaded, so the receipt will carry your decision with nothing to back it. Sign anyway?")) return;
  await keep(await F.vaccineReceipt(kp, { incidentId: inc(), shipmentId: f.get("shipmentId").trim(), station: me(), vials: Number(f.get("vials")), arrivalTempC: Number(f.get("arrivalTempC")), decision: f.get("decision"), logger: judged, at: Date.now() }));
  notice(`Vaccine receipt signed for ${f.get("shipmentId")}: ${f.get("decision")}.`);
  e.target.reset(); judged = null; $("#vax-judge").hidden = true;
});

// ---- Files ----
const fileText = () => JSON.stringify({ format: "needs-custody/field-records/1", incidentId: inc(), from: me(), savedAt: new Date().toISOString(), records: state.records }, null, 1);

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");

$("#save").addEventListener("click", () => {
  download(`${inc()}-${me()}-${stamp()}.json`, fileText(), "application/json");
  state.unsaved = false; write(); render();
  notice("Records file saved. Pass it to the next station or the coordinator.");
});

$("#copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(fileText()); state.unsaved = false; write(); render(); notice("Records copied. Paste them into a message or a note."); }
  catch { $("#paste").value = fileText(); notice("Couldn't copy here. The text is in the box below: select it and copy it by hand.", "bad"); }
});

async function addList(list) {
  const { all, added } = await F.mergeRecords(state.records, list);
  state.records = all; write(); render();
  return added;
}
async function addRecords(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("that isn't a records file"); }
  const list = Array.isArray(data) ? data : data?.records;
  if (!Array.isArray(list)) throw new Error("no records in it");
  return addList(list);
}

$("#load").addEventListener("change", async (e) => {
  let total = 0;
  try { for (const file of e.target.files) total += await addRecords(await file.text()); notice(`Added ${total} new records. Records already on this phone were skipped.`); }
  catch (err) { notice(`Couldn't add records: ${err.message}.`, "bad"); }
  e.target.value = "";
});
$("#add").addEventListener("click", async () => {
  try { const n = await addRecords($("#paste").value); $("#paste").value = ""; notice(`Added ${n} new records.`); }
  catch (err) { notice(`Couldn't add records: ${err.message}.`, "bad"); }
});

// ---- QR and sound: one sheet for showing, playing, scanning and listening ----
let stopper = null, codecPromise = null, audio = null;
function audioCtx() { audio ??= new (window.AudioContext || window.webkitAudioContext)(); return audio; }
const codec = () => (codecPromise ??= ggwaveFactory(QUIET).then((gg) => ggwaveCodec(gg, { inputRate: audioCtx().sampleRate })));

function sheet(title) {
  stopSheet();
  $("#xfer-title").textContent = title;
  for (const id of ["#xfer-qr", "#xfer-video", "#xfer-meter", "#xfer-again", "#xfer-steps"]) $(id).hidden = true;
  $("#xfer").hidden = false;
}
function sheetStatus(text, kind = "") { const s = $("#xfer-status"); s.textContent = text; s.className = `notice ${kind}`; }
function stopSheet() { stopper?.(); stopper = null; }
$("#xfer-close").addEventListener("click", () => { stopSheet(); $("#xfer").hidden = true; });

async function framesFor(records, size) { return W.toFrames(await W.packRecords(records), size); }
// A single code is a link, so a phone camera app opens this page straight onto it.
const qrText = (frame, n) => (n === 1 && /^https?:$/.test(location.protocol) ? `${location.origin}/field/#${frame}` : frame);

async function showQr(records, title) {
  sheet(title);
  const frames = await framesFor(records, W.QR_CHUNK);
  const box = $("#xfer-qr"); box.hidden = false;
  let i = 0;
  const draw = () => {
    const q = qrcode(0, "L"); q.addData(qrText(frames[i], frames.length), "Byte"); q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    sheetStatus(frames.length === 1 ? `${records.length} records in one code. The other phone scans it on Take casualty or Share.` : `Code ${i + 1} of ${frames.length}, changing by itself. The other phone keeps scanning until it has them all.`);
    i = (i + 1) % frames.length;
  };
  draw();
  if (frames.length > 1) { const t = setInterval(draw, 900); stopper = () => clearInterval(t); }
}

async function playSound(records, title) {
  sheet(title);
  const speed = $("#speed").value;
  const frames = await framesFor(records, W.SOUND_CHUNK);
  sheetStatus("Getting the sound ready...");
  const c = await codec(), ctx = audioCtx();
  await ctx.resume();
  const clips = frames.map((f) => c.encode(f, speed));
  const gap = 0.5, total = clips.reduce((n, x) => n + x.length / RATE + gap, 0);
  const play = () => {
    let t = ctx.currentTime + 0.2;
    const nodes = clips.map((x) => {
      const buf = ctx.createBuffer(1, x.length, RATE); buf.copyToChannel(x, 0);
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start(t);
      t += x.length / RATE + gap;
      return src;
    });
    stopper = () => nodes.forEach((n) => { try { n.stop(); } catch { /* already ended */ } });
    sheetStatus(`Playing ${frames.length} sound messages, about ${Math.round(total)} seconds. Hold the phone to the other phone's microphone, or key the radio and hold it to the speaker.`);
    const again = $("#xfer-again"); again.hidden = true;
    setTimeout(() => { again.hidden = false; sheetStatus("Done. If the other phone missed a part, play again: it keeps the parts it already has."); }, total * 1000 + 300);
  };
  $("#xfer-again").onclick = play;
  play();
}

// Collects frames from the camera or the microphone and hands complete sets to onPayload.
function collector(onPayload) {
  const asm = W.assembler(), seen = new Set();
  return async (text) => {
    const f = W.parseFrame(text);
    if (!f || seen.has(text)) return;
    seen.add(text);
    const r = await asm.add(f);
    if (r.payload) { stopSheet(); return onPayload(r.payload); }
    if (r.corrupt) sheetStatus("Those codes didn't fit together. Start again from the first one.", "bad");
    else sheetStatus(`Got ${r.have} of ${r.of}. Keep going.`, "");
  };
}

function mediaError(what, e) {
  if (e?.name === "NotAllowedError") return `The ${what} was blocked. Allow it for this page in the browser's settings and try again.`;
  if (!navigator.mediaDevices) return `This browser can't use the ${what} here. Open the page over https, or use a records file instead.`;
  return `Couldn't start the ${what}: ${e?.message || e}.`;
}

async function scan(onPayload) {
  sheet("Scan a code");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const video = $("#xfer-video"); video.srcObject = stream; video.hidden = false;
    await video.play();
    const detector = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
    const canvas = document.createElement("canvas"), g = canvas.getContext("2d", { willReadFrequently: true });
    const feed = collector(onPayload);
    let live = true;
    stopper = () => { live = false; stream.getTracks().forEach((t) => t.stop()); video.hidden = true; };
    sheetStatus("Point the camera at the other phone's code.");
    const tick = async () => {
      if (!live) return;
      let text = null;
      if (video.videoWidth) {
        if (detector) text = (await detector.detect(video).catch(() => []))[0]?.rawValue ?? null;
        else { canvas.width = video.videoWidth; canvas.height = video.videoHeight; g.drawImage(video, 0, 0); const img = g.getImageData(0, 0, canvas.width, canvas.height); text = jsQR(img.data, img.width, img.height)?.data ?? null; }
      }
      if (text) await feed(text);
      if (live) requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { sheetStatus(mediaError("camera", e), "bad"); stopSheet(); }
}

async function listen(onPayload) {
  sheet("Listen for records");
  try {
    sheetStatus("Starting the microphone...");
    const c = await codec(), ctx = audioCtx();
    await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), sink = ctx.createGain();
    sink.gain.value = 0; // keeps the node running without playing the microphone back
    const meter = $("#xfer-meter"), bar = meter.firstElementChild; meter.hidden = false;
    const feed = collector(onPayload);
    proc.onaudioprocess = (ev) => {
      const x = ev.inputBuffer.getChannelData(0);
      let peak = 0; for (let i = 0; i < x.length; i += 16) peak = Math.max(peak, Math.abs(x[i]));
      bar.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
      for (const text of c.decode(Float32Array.from(x), ctx.sampleRate)) feed(text);
    };
    src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    stopper = () => { proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); meter.hidden = true; };
    sheetStatus(`Listening. Hold this phone near the other phone's speaker, or near the radio. Choose the same sound type on both phones (${$("#speed").selectedOptions[0].textContent}).`);
  } catch (e) { sheetStatus(mediaError("microphone", e), "bad"); stopSheet(); }
}

// What arrived: add it, then offer to sign for any casualty this phone doesn't hold yet.
async function receivedPayload(payload, { forTake = false } = {}) {
  let list;
  try { list = await W.unpackRecords(payload); } catch (e) { sheetStatus(e.message, "bad"); return; }
  const n = await addList(list);
  sheetStatus(`Got ${list.length} record${list.length === 1 ? "" : "s"} (${n} new). Every one is checked again by signature when the coordinator runs Check.`, "good");
  const tags = [...new Set(list.filter((r) => r.kind === "triage/1" && r.incidentId === inc()).map((r) => r.tag))];
  const offers = tags.map((t) => W.casualtyState(state.records, t)).filter((c) => c && c.holder !== me());
  if (offers.length && (forTake || state.station.role !== "coordinator")) { $("#xfer").hidden = true; show("take"); showPending(offers); }
}

function showPending(offers) {
  const box = $("#pending");
  box.replaceChildren(...offers.map((o) => {
    const card = el("div", "card pending");
    card.append(el("p", null, `Casualty tag code ${short(o.tag)}, category ${o.category}, held by ${o.holder}.`));
    const b = el("button", "btn", "Sign: we have this casualty"); b.type = "button";
    b.addEventListener("click", async () => {
      await take(o.tag, o.holder, o.category);
      card.replaceChildren(el("p", "fine", `Signed: ${me()} has tag code ${short(o.tag)} from ${o.holder}.`));
    });
    card.append(b);
    return card;
  }));
}

const casualtyRecords = (opts) => (lastTag ? W.casualtyBundle(state.records, lastTag, opts) : []);
const sendSet = () => ($("#send-what").value === "mine" ? state.records.filter((r) => r.signerPub === state.key.pub) : state.records);
$("#ho-qr").addEventListener("click", () => showQr(casualtyRecords(), "Hand over this casualty"));
$("#ho-sound").addEventListener("click", () => playSound(casualtyRecords({ cards: false }), "Hand over this casualty"));
$("#take-scan").addEventListener("click", () => scan((p) => receivedPayload(p, { forTake: true })));
$("#take-listen").addEventListener("click", () => listen((p) => receivedPayload(p, { forTake: true })));
$("#send-qr").addEventListener("click", async () => { try { await showQr(sendSet(), "Send records"); state.unsaved = false; write(); render(); } catch (e) { sheetStatus(e.message, "bad"); } });
$("#send-sound").addEventListener("click", async () => { try { await playSound(sendSet(), "Send records"); } catch (e) { sheetStatus(e.message, "bad"); } });
$("#recv-scan").addEventListener("click", () => scan((p) => receivedPayload(p)));
$("#recv-listen").addEventListener("click", () => listen((p) => receivedPayload(p)));
$("#speed").addEventListener("change", () => { try { localStorage.setItem("field-speed", $("#speed").value); } catch { /* fine */ } });
try { const sp = localStorage.getItem("field-speed"); if (sp) $("#speed").value = sp; } catch { /* fine */ }

// ---- Check ----
$("#run").addEventListener("click", () => runCheck());

function table(head, rows) {
  const wrap = el("div", "table-wrap"), t = el("table"), tr = el("tr");
  for (const h of head) tr.append(el("th", null, h));
  t.append(tr);
  for (const r of rows) { const row = el("tr"); for (const c of r) row.append(c instanceof Node ? c : el("td", null, c)); t.append(row); }
  wrap.append(t);
  return wrap;
}
const pill = (text, kind) => { const td = el("td"); td.append(el("span", `pill ${kind}`, text)); return td; };

function stationsCard(res) {
  const box = el("div", `card ${res.stationList.some((s) => s.status === "conflict") ? "alert" : ""}`);
  box.append(el("h3", null, "Stations"));
  box.append(el("p", "fine", "Ask each station for the code on its screen (by voice, radio or phone call) and confirm the matching key here. Where two phones claim one name, neither is trusted until you confirm one."));
  // One row per key, stacked so it fits a phone: name and role, the code to compare, then status
  // and the Confirm button.
  const list = el("ul", "station-list");
  for (const s of res.stationList) {
    const li = el("li", "station-row"), who = el("div");
    who.append(el("strong", null, s.name), el("span", "fine", ROLES[s.role] || s.role));
    const label = s.status === "confirmed" ? (s.trusted ? "confirmed" : "not this one") : s.status === "conflict" ? "two keys: pick one" : "not confirmed yet";
    const act = el("div", "station-act");
    act.append(el("span", `pill ${s.status === "confirmed" && s.trusted ? "active" : s.status === "conflict" || !s.trusted ? "bad" : "draft"}`, label));
    if (s.status !== "confirmed") {
      const b = el("button", "btn ghost small-btn", "Confirm"); b.type = "button";
      b.setAttribute("aria-label", `Confirm ${s.name} with code ${s.code}`);
      b.addEventListener("click", async () => { state.approved = { ...(state.approved || {}), [s.name]: s.pub }; write(); await runCheck(); });
      act.append(b);
    }
    li.append(who, el("code", "station-code", s.code), act);
    list.append(li);
  }
  box.append(list);
  if (state.sampleCodes) box.append(el("p", "fine", `Sample only: the real district-hospital phone shows code ${state.sampleCodes["district-hospital"]}. Confirm that one and run the check again.`));
  return box;
}

async function runCheck() {
  const out = $("#report");
  out.replaceChildren(el("p", "fine", "Checking every signature..."));
  const res = await F.checkAll(state.records, { incidentId: inc(), hospitals: state.incident.hospitals, redLimitMs: state.incident.redLimitMin * F.MIN, approved: state.approved || {} });
  report = res;
  const c = res.casualties, all = [...res.problems, ...c.problems, ...res.supplies.problems, ...res.vaccines.problems];
  out.replaceChildren();

  const sum = el("div", "card");
  sum.append(el("h2", null, "What the records show"));
  const stats = el("div", "stats");
  for (const [k, v] of [["Stations trusted", Object.keys(res.stations).length], ["Casualties tracked", c.casualties.length], ["Not accounted for", c.missing.length], ["Red, late to hospital", c.lateRed.length], ["Supply orders short or unfilled", res.supplies.lines.filter((l) => l.status !== "filled").length], ["Records that failed", all.length]]) {
    const s = el("div", "stat"); s.append(el("span", null, k), el("strong", null, String(v))); stats.append(s);
  }
  sum.append(stats);
  sum.append(el("p", "fine", `By category: ${F.CATEGORIES.map((k) => `${k} ${c.byCategory[k]}`).join(", ")}. Hospitals counted: ${state.incident.hospitals.join(", ") || "none set"}.`));
  const csv = el("button", "btn ghost small-btn", "Save this report as a spreadsheet (CSV)"); csv.type = "button";
  csv.addEventListener("click", saveCsv);
  sum.append(csv);
  out.append(sum);

  out.append(stationsCard(res));

  if (c.missing.length) {
    const box = el("div", "card alert");
    box.append(el("h3", null, "Not accounted for: red or yellow casualties who never signed in at a hospital"));
    box.append(table(["Tag code", "Category", "Last station that signed for them"], c.missing.map((m) => [short(m.tag), m.category, m.lastHolder])));
    box.append(el("p", "fine", "Start the search at the last station listed. Tag codes are salted; the coordinator's salt turns a tag number back into its code to look one up."));
    out.append(box);
  }

  if (c.casualties.length) {
    const box = el("div", "card");
    box.append(el("h3", null, "Every casualty"));
    box.append(table(["Tag code", "Category", "Where"], c.casualties.map((x) => {
      const where = el("td");
      where.append(el("span", null, x.status === "at hospital" ? `${x.lastHolder}, after ${x.minutesToHospital} min` : `${x.status}, ${x.lastHolder}`));
      if (x.late) where.append(el("br"), el("span", "pill bad", `late, over ${state.incident.redLimitMin} min`));
      return [short(x.tag), x.retriagedFrom ? `${x.category} (was ${x.retriagedFrom})` : x.category, where];
    })));
    out.append(box);
  }

  if (res.supplies.lines.length) {
    const box = el("div", "card");
    box.append(el("h3", null, "Supply orders"));
    box.append(table(["Order", "Arrived"], res.supplies.lines.map((l) => {
      const order = el("td"); order.append(el("strong", null, l.item), el("br"), el("span", "fine", l.requestId));
      const got = el("td"); got.append(el("span", null, `${l.received} of ${l.qty} `), el("span", `pill ${l.status === "filled" ? "active" : "bad"}`, l.status));
      return [order, got];
    })));
    out.append(box);
  }

  if (res.vaccines.lines.length) {
    const box = el("div", "card");
    box.append(el("h3", null, "Vaccine deliveries"));
    // Four columns so it fits a phone: the verdict sits under the clinic's decision.
    box.append(table(["Shipment", "Logger", "Clinic decided"], res.vaccines.lines.map((v) => {
      const lg = v.logger, says = lg ? (lg.chargedMinutes <= lg.budgetMinutes ? "release" : "quarantine") : null;
      const flag = !lg ? el("span", "pill draft", "no logger file") : says !== v.decision ? el("span", "pill bad", `logger says ${says}`) : el("span", "pill active", "matches logger");
      const ship = el("td"); ship.append(el("strong", null, v.shipmentId), el("br"), el("span", "fine", `${v.station}, ${v.vials} vials`));
      const dec = el("td"); dec.append(el("span", null, v.decision), el("br"), flag);
      return [ship, lg ? `${lg.chargedMinutes} of ${lg.budgetMinutes} min outside 2 to 8 °C or unlogged (${lg.minC} to ${lg.maxC} °C)` : "none", dec];
    })));
    box.append(el("p", "fine", "Each receipt carries the logger file's fingerprint. The national store can check it against the raw logger export with pharma-custody."));
    out.append(box);
  }

  const pbox = el("div", `card ${all.length ? "alert" : ""}`);
  pbox.append(el("h3", null, all.length ? "Records that failed the check" : "Every record passed"));
  if (all.length) { const ul = el("ul"); for (const p of all) ul.append(el("li", null, p)); pbox.append(ul, el("p", "fine", "A failed record was changed after signing, signed by a key no trusted station card vouches for, or breaks the chain of who held a casualty. It is left out of the counts above.")); }
  else pbox.append(el("p", "fine", "Every signature checks out and every handoff links to the station that held the casualty before."));
  out.append(pbox);
}

function saveCsv() {
  if (!report) return;
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["section", "id", "category or item", "status", "station", "minutes to hospital or qty asked", "late or qty arrived"]];
  for (const x of report.casualties.casualties) rows.push(["casualty", short(x.tag), x.category, x.status, x.lastHolder, x.minutesToHospital ?? "", x.late ? "late" : ""]);
  for (const l of report.supplies.lines) rows.push(["supply", l.requestId, l.item, l.status, l.station, l.qty, l.received]);
  for (const v of report.vaccines.lines) rows.push(["vaccine", v.shipmentId, `${v.vials} vials`, v.decision, v.station, v.logger ? `${v.logger.chargedMinutes} of ${v.logger.budgetMinutes} min` : "no logger", ""]);
  for (const p of [...report.problems, ...report.casualties.problems, ...report.supplies.problems, ...report.vaccines.problems]) rows.push(["failed record", "", "", p, "", "", ""]);
  download(`${inc()}-report-${stamp()}.csv`, rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n", "text/csv");
}

// ---- Render ----
function describe(r) {
  switch (r.kind) {
    case "station/1": return `Station card: ${r.station} (${ROLES[r.role] || r.role})`;
    case "triage/1": return `${r.prev ? "Re-triage" : "Triage"} ${r.category}, tag code ${short(r.tag)}, by ${r.by}`;
    case "casualty-handoff/1": return `${r.to} took tag code ${short(r.tag)} (${r.category}) from ${r.from}`;
    case "supply-request/1": return `${r.station} asked for ${r.qty} × ${r.item} (${r.requestId})`;
    case "supply-receipt/1": return `${r.station} received ${r.qtyReceived} for ${r.requestId} from ${r.from}`;
    case "vaccine-receipt/1": return `${r.station} received ${r.vials} vials, ${r.shipmentId}: ${r.decision}`;
    default: return r.kind || "unknown record";
  }
}

function nextStep() {
  const own = state.records.filter((r) => r.signerPub === state.key.pub && r.kind !== "station/1").length;
  if (state.unsaved && own) return "Next: pass your records on. Open Share and show a QR code, play them as sound over a radio, or save a file.";
  const role = state.station.role;
  if (role === "coordinator") return state.records.length > 1 ? "Next: open Check. Confirm each station by its code, then see who is not accounted for." : "Next: collect each station's records on Share (scan, listen or add a file), then open Check.";
  if (role === "medic") return "Next: tag each casualty on Triage, then hand them over with a QR code or sound.";
  if (role === "clinic") return "Next: when a vaccine box arrives, open Vaccines and load its logger file.";
  if (role === "store") return "Next: stations sign their own receipts. Use Supplies to place your own orders.";
  return "Next: when a casualty arrives, open Take casualty and scan the code on the other phone.";
}

function render() {
  $("#inc-name").textContent = `Incident ${state.incident.incidentId}`;
  $("#st-name").textContent = state.station.name;
  F.stationCode(state.key.pub).then((code) => { $("#st-role").textContent = `${ROLES[state.station.role] || state.station.role}. Station code ${code}: read it to the coordinator so they can confirm this phone.`; });
  $("#next").textContent = nextStep();
  $("#count").textContent = String(state.records.length);
  const reqs = state.records.filter((r) => r.kind === "supply-request/1" && r.station === me());
  const sel = $("#f-receive").requestId;
  sel.replaceChildren(...(reqs.length ? reqs.map((r) => { const o = el("option", null, `${r.requestId}: ${r.qty} × ${r.item}`); o.value = r.requestId; return o; }) : [el("option", null, "Ask for supplies first")]));
  sel.disabled = !reqs.length;
  const names = [...new Set(state.records.filter((r) => r.kind === "station/1").map((r) => r.station))];
  $("#stations").replaceChildren(...names.map((n) => { const o = el("option"); o.value = n; return o; }));
  const list = $("#recent");
  list.replaceChildren(...state.records.slice().sort((a, b) => b.at - a.at).slice(0, 40).map((r) => {
    const li = el("li");
    li.append(el("span", null, describe(r)), el("span", "fine", `${when(r.at)}${r.signerPub === state.key.pub ? " · signed here" : ""}`));
    return li;
  }));
}

function show(tab) {
  $("#setup").hidden = true; $("#main").hidden = false;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-current", String(b.dataset.tab === tab));
  for (const t of document.querySelectorAll(".tab")) t.hidden = t.id !== `tab-${tab}`;
  $("#notice").hidden = true;
  render();
}
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => show(b.dataset.tab));

const START = { medic: "triage", collection: "take", hospital: "take", clinic: "vaccines", store: "supplies", coordinator: "share" };

// A phone camera app opened a single-code link: take it in once this phone is set up.
async function afterBoot(tab) {
  show(tab);
  if (!pendingPayload) return;
  const p = pendingPayload; pendingPayload = null;
  history.replaceState(null, "", location.pathname);
  $("#xfer").hidden = false; $("#xfer-title").textContent = "Records from a code";
  await receivedPayload(p, { forTake: true });
}

async function boot() {
  const f = W.parseFrame(decodeURIComponent(location.hash.slice(1)));
  if (f && f.of === 1) { const r = await W.assembler().add(f); if (r.payload) pendingPayload = r.payload; }
  state = read();
  if (state?.key) {
    try { kp = await F.loadKey(state.key); await afterBoot(START[state.station.role] || "triage"); return; }
    catch { notice("The saved key on this phone couldn't be loaded.", "bad"); }
  }
  state = null;
  $("#main").hidden = true; $("#setup").hidden = false;
  if (pendingPayload) $("#setup-note").hidden = false;
}

function net() { const n = $("#net"); n.textContent = navigator.onLine ? "Online" : "Offline: still works"; n.className = `pill ${navigator.onLine ? "active" : "draft"}`; }
addEventListener("online", net); addEventListener("offline", net); net();

if (KIT) { for (const a of document.querySelectorAll("[data-web-only]")) a.hidden = true; for (const a of document.querySelectorAll('a[href^="/"]')) a.href = "#"; }
if (!globalThis.crypto?.subtle || !globalThis.CompressionStream) { $("#setup").hidden = false; $("#setup-note").hidden = false; $("#setup-note").textContent = "This browser can't sign records. Use a current Chrome, Safari, Edge or Firefox."; }
else boot();
if (!KIT && "serviceWorker" in navigator) navigator.serviceWorker.register("/field/sw.js", { scope: "/field/" }).catch(() => {});
