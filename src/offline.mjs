// Store-and-forward log for sites with no steady link. A field device appends every
// record it makes to a hash-linked log (seq + prev). When a link comes back, entries can
// arrive late, out of order or more than once (delay-tolerant links resend); the
// receiver de-duplicates and sorts them, and a deleted, edited or forked entry shows up
// as a broken chain.
import { signRecord } from "../lib/receipt.mjs";
import { checkSigned } from "./common.mjs";

export function appendEntry(kp, log, { deviceId, recordId, at }) {
  const prev = log.length ? log[log.length - 1].claimId : null;
  const e = signRecord(kp, { kind: "log/1", deviceId, seq: log.length + 1, prev, recordId, at });
  log.push(e);
  return e;
}

export function reassemble(entries, { deviceId, devicePub }) {
  const problems = [], byId = new Map();
  for (const e of entries) {
    const r = checkSigned(e, "log/1", devicePub);
    if (r) { problems.push(`entry seq ${e?.seq}: ${r === "claimId_mismatch" ? "edited after signing" : r}`); continue; }
    if (e.deviceId !== deviceId) { problems.push(`entry seq ${e.seq}: other device`); continue; }
    byId.set(e.claimId, e); // duplicates collapse here
  }
  const sorted = [...byId.values()].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i], want = i + 1;
    if (e.seq !== want) {
      problems.push(e.seq === sorted[i - 1]?.seq ? `fork at seq ${e.seq}` : `missing seq ${want}${e.seq - want > 1 ? ` to ${e.seq - 1}` : ""}`);
      break;
    }
    if (e.prev !== (i ? sorted[i - 1].claimId : null)) { problems.push(`chain break at seq ${e.seq}`); break; }
  }
  return { ok: problems.length === 0, count: sorted.length, received: entries.length, recordIds: sorted.map((e) => e.recordId), problems };
}
