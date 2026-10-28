// Records over QR codes and sound. A set of records is packed small (claimIds dropped, since
// the receiver recomputes them from the content, then deflate and base64url) and cut into
// frames that each fit one QR code or one ggwave sound message:
//
//   FH1/<part>/<count>/<first 8 hex of sha256(payload)>/<base64url data>
//
// Frames arrive in any order, repeats are ignored, and the whole payload is checked against
// its id before anything is read, so a frame from another transfer can't slip in. Nothing
// here is trusted: every record still has to pass the signature check on the receiving phone.
import { contentId, sha256hex } from "./core.js";

const b64url = (bytes) => { let s = ""; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// Known kinds travel as a positional array, [kind number, ...values, sig, key], so no field
// names go over the air, and the key loses its fixed 12-byte Ed25519 SPKI prefix. Anything
// else (another kind, an extra or missing field) travels as the plain object. A decoding
// mistake can't pass unnoticed: the receiver recomputes the claimId and checks the signature.
const KINDS = [
  ["station/1", ["at", "incidentId", "role", "station"]],
  ["triage/1", ["at", "by", "category", "incidentId", "prev", "tag"]],
  ["casualty-handoff/1", ["at", "category", "from", "incidentId", "tag", "to"]],
  ["supply-request/1", ["at", "incidentId", "item", "qty", "requestId", "station"]],
  ["supply-receipt/1", ["at", "from", "incidentId", "qtyReceived", "requestId", "station"]],
  ["vaccine-receipt/1", ["arrivalTempC", "at", "decision", "incidentId", "logger", "shipmentId", "station", "vials"]],
];
const SPKI = "MCowBQYDK2VwAyEA";
function lean(r) {
  const { claimId, sig, signerPub, kind, ...rest } = r;
  const k = KINDS.findIndex(([name]) => name === kind);
  const keys = Object.keys(rest).sort();
  if (k < 0 || typeof signerPub !== "string" || !signerPub.startsWith(SPKI) || keys.join() !== KINDS[k][1].join()) {
    const { claimId: _, ...obj } = r;
    return obj;
  }
  return [k, ...KINDS[k][1].map((f) => rest[f]), sig, signerPub.slice(SPKI.length)];
}
function unlean(x) {
  if (!Array.isArray(x)) return x && typeof x === "object" ? x : null;
  const [name, fields] = KINDS[x[0]] || [];
  if (!name || x.length !== fields.length + 3) return null;
  const r = { kind: name };
  fields.forEach((f, i) => { r[f] = x[i + 1]; });
  return { ...r, sig: x.at(-2), signerPub: SPKI + x.at(-1) };
}

export async function packRecords(records) {
  return b64url(await pipe(new TextEncoder().encode(JSON.stringify(records.map(lean))), new CompressionStream("deflate-raw")));
}

export async function unpackRecords(payload) {
  let list;
  try { list = JSON.parse(new TextDecoder().decode(await pipe(unb64url(payload), new DecompressionStream("deflate-raw")))); }
  catch { throw new Error("the codes didn't decode into records"); }
  if (!Array.isArray(list)) throw new Error("no records in the codes");
  const out = [];
  for (const x of list) { const r = unlean(x); if (r) out.push({ ...r, claimId: await contentId(r) }); }
  return out;
}

// QR codes hold about 700 characters comfortably at low error correction; one ggwave
// message holds 140, so sound frames carry 120 characters of data after the header.
export const QR_CHUNK = 700, SOUND_CHUNK = 120;

export async function toFrames(payload, size) {
  const id = (await sha256hex(payload)).slice(0, 8), n = Math.max(1, Math.ceil(payload.length / size));
  if (n > 99) throw new Error(`too much for one transfer (${n} codes); send fewer records or save a file instead`);
  return Array.from({ length: n }, (_, i) => `FH1/${i + 1}/${n}/${id}/${payload.slice(i * size, (i + 1) * size)}`);
}

// Accepts a bare frame or a link carrying one after "#" (what the phone camera app opens).
export function parseFrame(text) {
  const s = String(text ?? "");
  const m = s.slice(s.lastIndexOf("FH1/")).match(/^FH1\/(\d{1,2})\/(\d{1,2})\/([0-9a-f]{8})\/([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const part = Number(m[1]), of = Number(m[2]);
  return part >= 1 && part <= of ? { part, of, id: m[3], data: m[4] } : null;
}

export function assembler() {
  const sets = new Map();
  return {
    // -> { have, of } while collecting, { payload } when complete, { corrupt: true } on a bad set
    async add(f) {
      const k = `${f.id}/${f.of}`;
      let got = sets.get(k);
      if (!got) sets.set(k, (got = new Map()));
      got.set(f.part, f.data);
      if (got.size < f.of) return { have: got.size, of: f.of };
      sets.delete(k);
      const payload = Array.from({ length: f.of }, (_, i) => got.get(i + 1)).join("");
      if ((await sha256hex(payload)).slice(0, 8) !== f.id) return { corrupt: true };
      return { payload };
    },
  };
}

// What travels when one casualty is handed over: every triage and handoff for that tag code,
// so the receiver can sign for them and re-triage on the chain, plus (unless `cards` is
// false, as for slow sound links) the station cards of whoever signed them.
export function casualtyBundle(records, tag, { cards = true } = {}) {
  const own = records.filter((r) => (r.kind === "triage/1" || r.kind === "casualty-handoff/1") && r.tag === tag);
  const signers = new Set(own.map((r) => r.signerPub));
  return [...(cards ? records.filter((r) => r.kind === "station/1" && signers.has(r.signerPub)) : []), ...own];
}

// Who holds a casualty and in what category, by the records alone (the receiver's prefill).
export function casualtyState(records, tag) {
  const ts = records.filter((r) => r.kind === "triage/1" && r.tag === tag).sort((a, b) => a.at - b.at);
  const hs = records.filter((r) => r.kind === "casualty-handoff/1" && r.tag === tag).sort((a, b) => a.at - b.at);
  if (!ts.length) return null;
  return { tag, category: ts.at(-1).category, holder: hs.length ? hs.at(-1).to : ts[0].by };
}
