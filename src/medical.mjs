// Field medicine after a disaster: triage tags and medical supply requests.
//
// A field medic signs a triage record for each casualty, keyed by a salted tag (the number
// on the physical triage tag, salted, never a name). Re-triage is a new signed record that
// names the previous one. Each time a casualty moves, the RECEIVING station signs the
// handoff with the category it was handed, so a casualty can't silently drop out of the
// chain and a category can't change without a signed re-triage. Red and yellow casualties
// must reach a hospital; red ones within a time limit.
//
// Supplies: a station signs what it asks for, and signs again for what actually arrived,
// so a supplier can't mark its own delivery as received.
import { sha256hex } from "../lib/canonical.mjs";
import { signRecord } from "../lib/receipt.mjs";
import { checkSigned, MIN } from "./common.mjs";

export const CATEGORIES = ["red", "yellow", "green", "black"];
export const casualtyTag = (salt, tagNumber) => sha256hex(`${salt}:${tagNumber}`);

export const triage = (kp, { incidentId, tag, category, by, at, prev = null }) =>
  signRecord(kp, { kind: "triage/1", incidentId, tag, category, by, at, prev });

// Signed by the station TAKING the casualty.
export const casualtyHandoff = (kp, { incidentId, tag, from, to, category, at }) =>
  signRecord(kp, { kind: "casualty-handoff/1", incidentId, tag, from, to, category, at });

// pubs: { [medic or station]: pub }. hospitals: station names that count as arrival.
export function verifyCasualties({ triages, handoffs }, { incidentId, pubs, hospitals, redLimitMs = 60 * MIN }) {
  const problems = [], byTag = new Map();
  const slot = (tag) => byTag.get(tag) || byTag.set(tag, { ts: [], hs: [] }).get(tag);
  let r;
  for (const t of triages) {
    if ((r = checkSigned(t, "triage/1", pubs[t?.by]))) { problems.push(`triage ${t?.tag?.slice(0, 8)}: ${r}`); continue; }
    if (t.incidentId !== incidentId) { problems.push(`triage ${t.tag.slice(0, 8)}: other incident`); continue; }
    if (!CATEGORIES.includes(t.category)) { problems.push(`triage ${t.tag.slice(0, 8)}: unknown category`); continue; }
    slot(t.tag).ts.push(t);
  }
  for (const h of handoffs) {
    if ((r = checkSigned(h, "casualty-handoff/1", pubs[h?.to]))) { problems.push(`handoff ${h?.tag?.slice(0, 8)} to ${h?.to}: ${r}`); continue; }
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

export const supplyRequest = (kp, { incidentId, requestId, station, item, qty, at }) =>
  signRecord(kp, { kind: "supply-request/1", incidentId, requestId, station, item, qty, at });

// Signed by the REQUESTING station when the goods arrive.
export const supplyReceipt = (kp, { incidentId, requestId, station, from, qtyReceived, at }) =>
  signRecord(kp, { kind: "supply-receipt/1", incidentId, requestId, station, from, qtyReceived, at });

export function verifySupplies({ requests, receipts }, { incidentId, pubs }) {
  const problems = [], lines = [], asked = new Map(), got = new Map();
  let r;
  for (const q of requests) {
    if ((r = checkSigned(q, "supply-request/1", pubs[q?.station]))) { problems.push(`request ${q?.requestId}: ${r}`); continue; }
    if (q.incidentId !== incidentId) { problems.push(`request ${q.requestId}: other incident`); continue; }
    asked.set(q.requestId, q);
  }
  for (const x of receipts) {
    if ((r = checkSigned(x, "supply-receipt/1", pubs[x?.station]))) { problems.push(`receipt ${x?.requestId}: ${r}`); continue; }
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
