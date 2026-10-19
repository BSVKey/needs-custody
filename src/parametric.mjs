// Parametric drought cover: pays out automatically when rainfall data, not a loss
// adjuster, says the trigger was hit. The insurer signs the policy (region, window,
// trigger, quorum, payout, payee). Each independent source signs its reading for the
// window. A payout is valid only when a quorum of DISTINCT pinned sources read below
// the trigger; a source that signs two different values for one window is excluded.
import { signRecord } from "../lib/receipt.mjs";
import { checkSigned } from "./common.mjs";

export const droughtPolicy = (kp, { policyId, region, windowDays, triggerMm, quorum, payoutSats, payTo }) =>
  signRecord(kp, { kind: "policy/1", policyId, region, windowDays, triggerMm, quorum, payoutSats, payTo });

export const rainReading = (kp, { source, region, windowEnd, windowDays, rainMm }) =>
  signRecord(kp, { kind: "rain-reading/1", source, region, windowEnd, windowDays, rainMm });

// sourcePubs: { [source]: pub } the verifier trusts.
export function evaluate(pol, readings, { sourcePubs, windowEnd }) {
  const ignored = [], bySource = new Map();
  for (const x of readings) {
    const r = checkSigned(x, "rain-reading/1", sourcePubs[x?.source]);
    if (r) { ignored.push({ source: x?.source, reason: r === "no_pinned_key" ? "source not pinned" : r }); continue; }
    if (x.region !== pol.region || x.windowDays !== pol.windowDays || x.windowEnd !== windowEnd) {
      ignored.push({ source: x.source, reason: "wrong region or window" }); continue;
    }
    if (!bySource.has(x.source)) bySource.set(x.source, []);
    bySource.get(x.source).push(x);
  }
  const counted = [];
  for (const [source, list] of bySource) {
    if (new Set(list.map((l) => l.rainMm)).size > 1) { ignored.push({ source, reason: "equivocation: two values for one window" }); continue; }
    counted.push(list[0]);
  }
  const below = counted.filter((x) => x.rainMm < pol.triggerMm);
  return {
    triggered: below.length >= pol.quorum, sourcesCounted: counted.length, below: below.length,
    readings: counted.map((x) => ({ source: x.source, rainMm: x.rainMm })),
    evidenceIds: below.map((x) => x.claimId).sort(), ignored,
  };
}

export const payout = (kp, pol, ev, { windowEnd, settlementRef }) =>
  signRecord(kp, {
    kind: "payout/1", policyId: pol.policyId, policyClaim: pol.claimId, windowEnd,
    evidenceIds: ev.evidenceIds, payoutSats: pol.payoutSats, payTo: pol.payTo, settlementRef,
  });

// Anyone holding the policy, the readings and the pinned source keys can re-run the
// decision and confirm the payout matches it.
export function verifyPayout(pol, pay, readings, { sourcePubs }) {
  let r;
  if ((r = checkSigned(pol, "policy/1"))) return { ok: false, reason: `policy: ${r}` };
  if ((r = checkSigned(pay, "payout/1", pol.signerPub))) return { ok: false, reason: `payout: ${r}` };
  if (pay.policyClaim !== pol.claimId) return { ok: false, reason: "payout cites another policy" };
  const ev = evaluate(pol, readings, { sourcePubs, windowEnd: pay.windowEnd });
  if (!ev.triggered) return { ok: false, reason: "trigger not met by the evidence" };
  if (JSON.stringify(ev.evidenceIds) !== JSON.stringify([...pay.evidenceIds].sort())) return { ok: false, reason: "evidence does not match" };
  if (pay.payoutSats !== pol.payoutSats) return { ok: false, reason: "amount differs from policy" };
  if (pay.payTo !== pol.payTo) return { ok: false, reason: "payee differs from policy" };
  return { ok: true };
}
