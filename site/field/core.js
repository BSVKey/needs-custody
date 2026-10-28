// Field health kit, the part that has to be right: canonical JSON, content ids, Ed25519
// signatures and the checks. Runs in the browser and in Node 20+ (both have WebCrypto),
// and produces records byte-for-byte compatible with lib/receipt.mjs and src/medical.mjs:
// claimId = "0x" + sha256(canonical JSON of the content), sig = Ed25519 over the claimId
// text (base64), signerPub = base64 SPKI DER. test/field.test.mjs proves it both ways.
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
const b64 = (buf) => { let s = ""; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

export const MIN = 60000;
export const CATEGORIES = ["red", "yellow", "green", "black"];

function sortKeysDeep(v, depth = 0) {
  if (depth > 32) throw new Error("nesting exceeds max depth 32");
  if (Array.isArray(v)) return v.map((x) => sortKeysDeep(x, depth + 1));
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k], depth + 1);
    return out;
  }
  return v;
}
export const canonicalize = (v) => JSON.stringify(sortKeysDeep(v));
export const sha256hex = async (text) => hex(await subtle.digest("SHA-256", enc.encode(text)));
const CREDENTIALS = new Set(["claimId", "sig", "signerPub"]);
export async function contentId(obj) {
  const c = {};
  for (const k of Object.keys(obj)) if (!CREDENTIALS.has(k)) c[k] = obj[k];
  return "0x" + (await sha256hex(canonicalize(c)));
}

// ---- Keys: { priv: CryptoKey, pub: base64 SPKI }, saved as { priv: base64 PKCS8, pub } ----
export async function genKey() {
  const k = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { priv: k.privateKey, pub: b64(await subtle.exportKey("spki", k.publicKey)) };
}
export const saveKey = async (kp) => ({ priv: b64(await subtle.exportKey("pkcs8", kp.priv)), pub: kp.pub });
export const loadKey = async (s) => ({ priv: await subtle.importKey("pkcs8", unb64(s.priv), { name: "Ed25519" }, true, ["sign"]), pub: s.pub });

export async function signRecord(kp, content) {
  const claimId = await contentId(content);
  const sig = b64(await subtle.sign({ name: "Ed25519" }, kp.priv, enc.encode(claimId)));
  return { ...content, claimId, sig, signerPub: kp.pub };
}

export async function verifyRecord(rec) {
  if (rec === null || typeof rec !== "object") return { ok: false, reason: "not_an_object" };
  if ((await contentId(rec)).toLowerCase() !== String(rec.claimId).toLowerCase()) return { ok: false, reason: "claimId_mismatch" };
  if (!rec.signerPub || !rec.sig) return { ok: false, reason: "missing_credential" };
  try {
    const pub = await subtle.importKey("spki", unb64(rec.signerPub), { name: "Ed25519" }, false, ["verify"]);
    if (await subtle.verify({ name: "Ed25519" }, pub, unb64(rec.sig), enc.encode(String(rec.claimId)))) return { ok: true, signer: rec.signerPub };
  } catch { /* bad key or signature encoding */ }
  return { ok: false, reason: "signature_invalid" };
}

// Same rule as src/common.mjs: a pin asked for but unknown fails closed.
export async function checkSigned(rec, kind, ...pin) {
  if (rec === null || typeof rec !== "object") return "missing_record";
  if (rec.kind !== kind) return "wrong_kind";
  const v = await verifyRecord(rec);
  if (!v.ok) return v.reason;
  if (pin.length && !pin[0]) return "no_pinned_key";
  if (pin.length && v.signer !== pin[0]) return "signer_not_pinned";
  return null;
}

// ---- Records (same kinds and fields as src/medical.mjs) ----
export const casualtyTag = (salt, tagNumber) => sha256hex(`${salt}:${String(tagNumber).trim()}`);
export const triage = (kp, { incidentId, tag, category, by, at, prev = null }) =>
  signRecord(kp, { kind: "triage/1", incidentId, tag, category, by, at, prev });
export const casualtyHandoff = (kp, { incidentId, tag, from, to, category, at }) =>
  signRecord(kp, { kind: "casualty-handoff/1", incidentId, tag, from, to, category, at });
export const supplyRequest = (kp, { incidentId, requestId, station, item, qty, at }) =>
  signRecord(kp, { kind: "supply-request/1", incidentId, requestId, station, item, qty, at });
export const supplyReceipt = (kp, { incidentId, requestId, station, from, qtyReceived, at }) =>
  signRecord(kp, { kind: "supply-receipt/1", incidentId, requestId, station, from, qtyReceived, at });
// A clinic's signed receipt for a vaccine delivery, with the fingerprint of the logger file
// it judged, so the national store can check it against the raw export (pharma-custody).
export const vaccineReceipt = (kp, { incidentId, shipmentId, station, vials, arrivalTempC, decision, logger, at }) =>
  signRecord(kp, { kind: "vaccine-receipt/1", incidentId, shipmentId, station, vials, arrivalTempC, decision, logger, at });
// A station card: who a station is. The coordinator pins these keys before checking.
export const stationCard = (kp, { incidentId, station, role, at }) =>
  signRecord(kp, { kind: "station/1", incidentId, station, role, at });

// ---- Checks: ported line for line from src/medical.mjs, async because WebCrypto is ----
export async function verifyCasualties({ triages, handoffs }, { incidentId, pubs, hospitals, redLimitMs = 60 * MIN }) {
  const problems = [], byTag = new Map();
  const slot = (tag) => byTag.get(tag) || byTag.set(tag, { ts: [], hs: [] }).get(tag);
  let r;
  for (const t of triages) {
    if ((r = await checkSigned(t, "triage/1", pubs[t?.by]))) { problems.push(`triage ${t?.tag?.slice(0, 8)}: ${r}`); continue; }
    if (t.incidentId !== incidentId) { problems.push(`triage ${t.tag.slice(0, 8)}: other incident`); continue; }
    if (!CATEGORIES.includes(t.category)) { problems.push(`triage ${t.tag.slice(0, 8)}: unknown category`); continue; }
    slot(t.tag).ts.push(t);
  }
  for (const h of handoffs) {
    if ((r = await checkSigned(h, "casualty-handoff/1", pubs[h?.to]))) { problems.push(`handoff ${h?.tag?.slice(0, 8)} to ${h?.to}: ${r}`); continue; }
    if (h.incidentId !== incidentId) { problems.push(`handoff ${h.tag.slice(0, 8)}: other incident`); continue; }
    slot(h.tag).hs.push(h);
  }
  const casualties = [];
  for (const [tag, { ts, hs }] of byTag) {
    const id = tag.slice(0, 8);
    ts.sort((a, b) => a.at - b.at);
    hs.sort((a, b) => a.at - b.at);
    if (!ts.length) { problems.push(`${id}: moved without a triage record`); continue; }
    if (ts.some((t, i) => t.prev !== (i ? ts[i - 1].claimId : null))) { problems.push(`${id}: re-triage chain break`); continue; }
    let holder = ts[0].by, broken = false;
    for (const h of hs) {
      const known = ts.filter((t) => t.at <= h.at).at(-1);
      if (h.from !== holder) { problems.push(`${id}: handed over by ${h.from} but held by ${holder}`); broken = true; break; }
      if (!known || h.category !== known.category) { problems.push(`${id}: ${known?.category ?? "untriaged"} -> ${h.category} at ${h.to} without a signed re-triage`); broken = true; break; }
      holder = h.to;
    }
    if (broken) continue;
    const category = ts.at(-1).category;
    const arrival = hs.find((h) => hospitals.includes(h.to));
    const status = arrival ? "at hospital" : category === "red" || category === "yellow" ? "not accounted for" : category === "black" ? "no transport" : "treated on site";
    casualties.push({
      tag, category, status, lastHolder: holder, retriagedFrom: ts.length > 1 ? ts[0].category : null,
      minutesToHospital: arrival ? Math.round((arrival.at - ts[0].at) / MIN) : null,
      late: category === "red" && !!arrival && arrival.at - ts[0].at > redLimitMs,
    });
  }
  return {
    ok: problems.length === 0, problems, casualties,
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, casualties.filter((x) => x.category === c).length])),
    missing: casualties.filter((c) => c.status === "not accounted for"),
    lateRed: casualties.filter((c) => c.late),
  };
}

export async function verifySupplies({ requests, receipts }, { incidentId, pubs }) {
  const problems = [], lines = [], asked = new Map(), got = new Map();
  let r;
  for (const q of requests) {
    if ((r = await checkSigned(q, "supply-request/1", pubs[q?.station]))) { problems.push(`request ${q?.requestId}: ${r}`); continue; }
    if (q.incidentId !== incidentId) { problems.push(`request ${q.requestId}: other incident`); continue; }
    asked.set(q.requestId, q);
  }
  for (const x of receipts) {
    if ((r = await checkSigned(x, "supply-receipt/1", pubs[x?.station]))) { problems.push(`receipt ${x?.requestId}: ${r}`); continue; }
    const q = asked.get(x.requestId);
    if (!q || x.incidentId !== incidentId || x.station !== q.station) { problems.push(`receipt ${x.requestId}: no matching request`); continue; }
    got.set(x.requestId, (got.get(x.requestId) || 0) + x.qtyReceived);
  }
  for (const q of asked.values()) {
    const received = got.get(q.requestId) || 0;
    lines.push({ requestId: q.requestId, station: q.station, item: q.item, qty: q.qty, received, status: received === 0 ? "unfilled" : received < q.qty ? "short" : "filled" });
  }
  return { ok: problems.length === 0, problems, lines };
}

// ---- Vaccine logger files: same parsing and rules as pharma-custody src/logger.mjs ----
export function parseLoggerCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("no data rows in the logger file");
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const ti = head.findIndex((h) => ["timestamp", "time", "datetime", "date_time"].includes(h));
  const ci = head.findIndex((h) => ["temp_c", "temperature", "temp", "celsius", "temperature_c"].includes(h));
  if (ti < 0 || ci < 0) throw new Error("the logger file needs a time column and a temperature column");
  const samples = [];
  let rejected = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const raw = cells[ti]?.trim();
    const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
    const c = Number(cells[ci]);
    if (!Number.isFinite(t) || !Number.isFinite(c)) { rejected++; continue; }
    samples.push([t, Math.round(c * 100) / 100]);
  }
  samples.sort((a, b) => a[0] - b[0]);
  return { samples, rejected };
}
export const fingerprint = async (samples) => "0x" + (await sha256hex(canonicalize(samples)));

// Gaps count against the budget (the conservative default in pharma-custody).
export function judgeLogger(samples, { minC = 2, maxC = 8, intervalMs = 5 * MIN, budgetMinutes = 60 } = {}) {
  if (!samples.length) throw new Error("no readings in the logger file");
  const mins = (ms) => Math.round((ms / MIN) * 10) / 10;
  const from = samples[0][0], to = samples.at(-1)[0];
  let excursion = 0, run = null, gap = 0;
  for (const [t, c] of samples) {
    const out = c < minC || c > maxC;
    if (out && run === null) run = t;
    if (!out && run !== null) { excursion += t - run; run = null; }
  }
  if (run !== null) excursion += to - run;
  for (let i = 1; i < samples.length; i++) { const d = samples[i][0] - samples[i - 1][0]; if (d > 2 * intervalMs) gap += d; }
  const temps = samples.map(([, c]) => c);
  const charged = mins(excursion) + mins(gap);
  return {
    from, to, samples: samples.length, minC: Math.min(...temps), maxC: Math.max(...temps),
    excursionMinutes: mins(excursion), gapMinutes: mins(gap), chargedMinutes: Math.round(charged * 10) / 10,
    budgetMinutes, frozen: Math.min(...temps) < 0, decision: charged <= budgetMinutes ? "release" : "quarantine",
  };
}

export async function verifyVaccines(receipts, { incidentId, pubs }) {
  const problems = [], lines = [];
  for (const v of receipts) {
    const r = await checkSigned(v, "vaccine-receipt/1", pubs[v?.station]);
    if (r) { problems.push(`vaccine receipt ${v?.shipmentId} at ${v?.station}: ${r}`); continue; }
    if (v.incidentId !== incidentId) { problems.push(`vaccine receipt ${v.shipmentId}: other incident`); continue; }
    lines.push(v);
  }
  return { ok: problems.length === 0, problems, lines };
}

// A short code for a station's key, for people to compare by voice or radio: "4F1-9C2".
export const stationCode = async (pub) => { const h = (await sha256hex(pub)).slice(0, 6).toUpperCase(); return `${h.slice(0, 3)}-${h.slice(3)}`; };

// Station keys come only from signed station cards. `approved` ({ name: pub }) is what the
// coordinator confirmed by comparing station codes; it always wins. An unconfirmed name with
// one key is used but listed as unconfirmed. A name claimed by two or more keys is used by
// NONE of them until the coordinator confirms one: arrival order never decides.
export async function resolveStations(records, { incidentId, approved = {} }) {
  const claims = new Map(), problems = [];
  for (const c of records.filter((x) => x?.kind === "station/1")) {
    const bad = await checkSigned(c, "station/1");
    if (bad) { problems.push(`station card ${c.station}: ${bad}`); continue; }
    if (c.incidentId !== incidentId) continue;
    const set = claims.get(c.station) || claims.set(c.station, new Map()).get(c.station);
    if (!set.has(c.signerPub)) set.set(c.signerPub, { role: c.role, code: await stationCode(c.signerPub) });
  }
  const pubs = {}, stations = [];
  for (const [name, keys] of claims) {
    const ok = approved[name] && keys.has(approved[name]) ? approved[name] : null;
    const status = ok ? "confirmed" : keys.size === 1 ? "unconfirmed" : "conflict";
    if (ok) pubs[name] = ok;
    else if (keys.size === 1) pubs[name] = [...keys.keys()][0];
    else problems.push(`station ${name}: ${keys.size} different keys claim this name; none is trusted until you confirm one by its station code`);
    for (const [pub, k] of keys) stations.push({ name, pub, role: k.role, code: k.code, status, trusted: pubs[name] === pub });
  }
  return { pubs, stations, problems };
}

export async function checkAll(records, { incidentId, hospitals, redLimitMs, approved }) {
  const { pubs, stations: stationList, problems } = await resolveStations(records, { incidentId, approved });
  const of = (k) => records.filter((x) => x?.kind === k);
  const casualties = await verifyCasualties({ triages: of("triage/1"), handoffs: of("casualty-handoff/1") }, { incidentId, pubs, hospitals, redLimitMs });
  const supplies = await verifySupplies({ requests: of("supply-request/1"), receipts: of("supply-receipt/1") }, { incidentId, pubs });
  const vaccines = await verifyVaccines(of("vaccine-receipt/1"), { incidentId, pubs });
  return { stations: pubs, stationList, problems, casualties, supplies, vaccines };
}

// Records travel as one JSON file; exact copies collapse on import. The key is the claimId
// recomputed from the content plus the signature, never the claimId a record carries, so an
// edited copy that arrives first can't shadow the genuine record: both are kept, and only
// the edited one fails the check.
const mergeKey = async (r) => `${await contentId(r)}|${r.sig}`;
export async function mergeRecords(have, incoming) {
  const seen = new Set(await Promise.all(have.map(mergeKey)));
  const added = [];
  for (const r of incoming) {
    if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.claimId !== "string") continue;
    const k = await mergeKey(r);
    if (!seen.has(k)) { seen.add(k); added.push(r); }
  }
  return { all: [...have, ...added], added: added.length };
}
