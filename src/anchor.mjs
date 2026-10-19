// Daily anchor: one Merkle root over every record's claimId, written to Bitcoin BSV in
// a single OP_FALSE OP_RETURN output, so one small transaction timestamps a whole day
// of deliveries, handouts and readings. Any record can later be shown to be in that
// batch with a short Merkle branch. This module builds the locking script; it does not
// broadcast it.
import { leafHash, buildTree, proof, verifyProof } from "../lib/merkle.mjs";

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
