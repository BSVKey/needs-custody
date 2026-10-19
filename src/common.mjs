// Shared check used by every module: the record verifies, is the expected kind, and
// (when a pinned key is asked for) was signed by that key. Returns null or a reason.
// Passing a third argument that is undefined means "pin required but none known",
// which fails closed rather than skipping the signer check.
import { verifyRecord } from "../lib/receipt.mjs";

export function checkSigned(rec, kind, ...pin) {
  if (rec === null || typeof rec !== "object") return "missing_record";
  if (rec.kind !== kind) return "wrong_kind";
  const v = verifyRecord(rec);
  if (!v.ok) return v.reason;
  if (pin.length && !pin[0]) return "no_pinned_key";
  if (pin.length && v.signer !== pin[0]) return "signer_not_pinned";
  return null;
}

export const MIN = 60000;
export const H = 60 * MIN;
