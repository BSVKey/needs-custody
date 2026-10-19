// Food aid from a warehouse to households. The warehouse signs a manifest committing a
// Merkle root over household entitlements, keyed by a salted household tag (never a
// name or ID number, so the list itself reveals nobody). At each handoff the RECEIVER
// signs the weight it took, so any loss is pinned to the custodian who held the food.
// The distribution point signs one record per handout, carrying a Merkle proof that
// the tag is entitled to that ration; double claims and unlisted tags are rejected.
import { canonicalize, sha256hex } from "../lib/canonical.mjs";
import { leafHash, buildTree, proof, verifyProof } from "../lib/merkle.mjs";
import { signRecord } from "../lib/receipt.mjs";
import { checkSigned } from "./common.mjs";

export const householdTag = (salt, householdId) => sha256hex(`${salt}:${householdId}`);
const entitlementLeaf = ({ tag, rationKg }) => leafHash(Buffer.from(canonicalize({ tag, rationKg })));

export function aidManifest(kp, { consignmentId, entitlements }) {
  const tree = buildTree(entitlements.map(entitlementLeaf));
  const totalKg = entitlements.reduce((s, e) => s + e.rationKg, 0);
  const manifest = signRecord(kp, { kind: "aid-manifest/1", consignmentId, root: tree.root, households: entitlements.length, totalKg });
  return { manifest, tree };
}

export const entitlementProof = (tree, index) => proof(tree, index);

// Signed by the custodian TAKING the consignment.
export const aidHandoff = (kp, { consignmentId, from, to, kg, at }) =>
  signRecord(kp, { kind: "aid-handoff/1", consignmentId, from, to, kg, at });

export const aidHandout = (kp, { consignmentId, pointId, tag, rationKg, index, branch, at }) =>
  signRecord(kp, { kind: "aid-handout/1", consignmentId, pointId, tag, rationKg, index, branch, at });

// route: custodian names in order, warehouse first, distribution point last.
// pubs: { [name]: pub } for every custodian on the route.
export function verifyAid({ manifest, handoffs, handouts }, { route, pubs, lossToleranceKg = 0 }) {
  const problems = [];
  let r;
  if ((r = checkSigned(manifest, "aid-manifest/1", pubs[route[0]]))) return { authentic: false, problems: [`manifest: ${r}`] };
  if (handoffs.length !== route.length - 1) return { authentic: false, problems: ["wrong number of handoffs for route"] };

  const losses = [];
  let heldKg = manifest.totalKg;
  handoffs.forEach((h, i) => {
    const from = route[i], to = route[i + 1];
    if ((r = checkSigned(h, "aid-handoff/1", pubs[to]))) return problems.push(`handoff ${i + 1}: ${r}`);
    if (h.consignmentId !== manifest.consignmentId) return problems.push(`handoff ${i + 1}: other consignment`);
    if (h.from !== from || h.to !== to) return problems.push(`handoff ${i + 1}: custody chain break`);
    if (heldKg - h.kg > lossToleranceKg) losses.push({ custodian: from, kg: Math.round((heldKg - h.kg) * 10) / 10 });
    heldKg = h.kg;
  });
  if (problems.length) return { authentic: false, problems };

  const point = route[route.length - 1];
  const seen = new Set(), rejected = [];
  let distributedKg = 0;
  for (const o of handouts) {
    if ((r = checkSigned(o, "aid-handout/1", pubs[point]))) { rejected.push({ tag: o.tag, reason: r }); continue; }
    if (o.consignmentId !== manifest.consignmentId) { rejected.push({ tag: o.tag, reason: "other consignment" }); continue; }
    const leaf = entitlementLeaf({ tag: o.tag, rationKg: o.rationKg });
    if (!verifyProof(leaf, o.branch, o.index, manifest.root)) { rejected.push({ tag: o.tag, reason: "not entitled" }); continue; }
    if (seen.has(o.tag)) { rejected.push({ tag: o.tag, reason: "double claim" }); continue; }
    seen.add(o.tag);
    distributedKg += o.rationKg;
  }
  return {
    authentic: true, problems, losses, receivedAtPointKg: heldKg,
    householdsServed: seen.size, households: manifest.households,
    distributedKg, undistributedKg: Math.round((heldKg - distributedKg) * 10) / 10, rejected,
  };
}
