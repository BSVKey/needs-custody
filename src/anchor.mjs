// Daily anchor: one Merkle root over every record's claimId, written to Bitcoin BSV in
// a single OP_FALSE OP_RETURN output, so one small transaction timestamps a whole day
// of deliveries, handouts and readings. Any record can later be shown to be in that
// batch with a short Merkle branch. This module builds the locking script and checks an
// anchor read-only on WhatsOnChain; it never broadcasts. Signing a transaction needs
// @bsv/sdk and a funded key, and lives in bin/anchor.mjs.
import { leafHash, buildTree, proof, verifyProof } from "../lib/merkle.mjs";

export const WOC = "https://api.whatsonchain.com/v1/bsv/main";
export const ANCHOR_TAG = "bsvkey.needs/1";
const idLeaf = (claimId) => leafHash(Buffer.from(String(claimId).replace(/^0x/, ""), "hex"));

function push(buf) {
  if (buf.length > 75) throw new Error("push longer than 75 bytes");
  return buf.length.toString(16).padStart(2, "0") + buf.toString("hex");
}

export function anchorBatch(claimIds) {
  const tree = buildTree(claimIds.map(idLeaf));
  const scriptHex = "006a" + push(Buffer.from(ANCHOR_TAG)) + push(Buffer.from(tree.root, "hex"));
  return { root: tree.root, count: claimIds.length, scriptHex, tree };
}

export const batchProof = (batch, index) => proof(batch.tree, index);
export const inBatch = (root, claimId, index, branch) => verifyProof(idLeaf(claimId), branch, index, root);

const strip0x = (h) => String(h).replace(/^0x/i, "").toLowerCase();

// Does a WhatsOnChain tx JSON carry exactly this anchor script (tag + root) in an
// OP_RETURN output? Pure, no network.
export function opReturnCarriesRoot(txJson, root) {
  const r = strip0x(root);
  if (!/^[0-9a-f]{64}$/.test(r)) return false;
  const want = "006a" + push(Buffer.from(ANCHOR_TAG)) + push(Buffer.from(r, "hex"));
  return (txJson?.vout || []).some((o) => String(o?.scriptPubKey?.hex || "").toLowerCase() === want);
}

export async function verifyAnchorOnChain(txid, root, { wocBase = WOC } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(txid))) return { ok: false, reason: "bad_txid" };
  let j;
  try {
    const res = await fetch(`${wocBase}/tx/hash/${txid}`);
    if (!res.ok) return { ok: false, reason: `chain_read_http_${res.status}`, txid };
    j = await res.json();
  } catch (e) {
    return { ok: false, reason: `chain_read_failed: ${e.message}`, txid };
  }
  const ok = opReturnCarriesRoot(j, root);
  return {
    ok, txid, root: strip0x(root),
    confirmations: Number(j.confirmations) || 0,
    blocktime: j.blocktime ? new Date(j.blocktime * 1000).toISOString() : null,
    reason: ok ? undefined : "root_not_in_op_return",
  };
}
