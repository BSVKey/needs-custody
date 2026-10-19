// Water delivery receipts. A water-quality sensor signs its reading at the site, the
// truck or kiosk operator signs what it delivered (and which reading it relied on),
// and the site's water committee countersigns what it received. A verifier with the
// three pinned keys decides: delivered and safe, delivered but unsafe, short, or
// unverified (a record is forged, edited, or does not link).
import { signRecord } from "../lib/receipt.mjs";
import { checkSigned, H } from "./common.mjs";

// Sphere Handbook (2018), water supply standards 2.1 and 2.2: at least 15 L per person
// per day, free residual chlorine at least 0.2 mg/L at the point of delivery, turbidity
// below 5 NTU, and no E. coli per 100 mL.
export const SPHERE = { litersPerPersonDay: 15, frcMinMgL: 0.2, turbidityMaxNtu: 5, eColiMaxCfu: 0 };

export const qualityReading = (kp, { sensorId, siteId, at, frcMgL, turbidityNtu, eColiCfu }) =>
  signRecord(kp, { kind: "water-quality/1", sensorId, siteId, at, frcMgL, turbidityNtu, eColiCfu });

export const waterDelivery = (kp, { deliveryId, operator, siteId, liters, at, qualityId }) =>
  signRecord(kp, { kind: "water-delivery/1", deliveryId, operator, siteId, liters, at, qualityId });

export const waterReceived = (kp, { delivery, litersReceived, at }) =>
  signRecord(kp, {
    kind: "water-received/1", deliveryId: delivery.deliveryId, deliveryClaim: delivery.claimId,
    siteId: delivery.siteId, litersReceived, at,
  });

export function qualityProblems(q, std = SPHERE) {
  const p = [];
  if (q.frcMgL < std.frcMinMgL) p.push(`free chlorine ${q.frcMgL} mg/L, below ${std.frcMinMgL}`);
  if (q.turbidityNtu >= std.turbidityMaxNtu) p.push(`turbidity ${q.turbidityNtu} NTU, not below ${std.turbidityMaxNtu}`);
  if (q.eColiCfu > std.eColiMaxCfu) p.push(`E. coli ${q.eColiCfu} CFU/100 mL`);
  return p;
}

// { authentic, decision, problems, litersCredited }. Only safe, received liters count.
export function verifyWaterDelivery({ delivery, received, quality },
  { operatorPub, sitePub, sensorPub, maxReadingAgeMs = 2 * H, shortTolerance = 0.02, std = SPHERE }) {
  const fail = (reason) => ({ authentic: false, decision: "unverified", problems: [reason], litersCredited: 0 });
  let r;
  if ((r = checkSigned(delivery, "water-delivery/1", operatorPub))) return fail(`delivery: ${r}`);
  if ((r = checkSigned(received, "water-received/1", sitePub))) return fail(`receipt: ${r}`);
  if ((r = checkSigned(quality, "water-quality/1", sensorPub))) return fail(`quality: ${r}`);
  if (received.deliveryClaim !== delivery.claimId) return fail("receipt is for a different delivery record");
  if (received.siteId !== delivery.siteId || quality.siteId !== delivery.siteId) return fail("site mismatch");
  if (delivery.qualityId !== quality.claimId) return fail("delivery does not cite this quality reading");
  if (Math.abs(delivery.at - quality.at) > maxReadingAgeMs) return fail("quality reading too far from delivery time");

  const unsafe = qualityProblems(quality, std);
  if (unsafe.length) return { authentic: true, decision: "delivered-unsafe", problems: unsafe, litersCredited: 0 };
  if (received.litersReceived < delivery.liters * (1 - shortTolerance)) {
    const missing = delivery.liters - received.litersReceived;
    return { authentic: true, decision: "short", problems: [`${missing} L claimed but not received`], litersCredited: received.litersReceived };
  }
  return { authentic: true, decision: "delivered-safe", problems: [], litersCredited: received.litersReceived };
}

// Liters of safe water per person per day across verified deliveries.
export function coverage(results, { population, days = 1, std = SPHERE }) {
  const liters = results.reduce((s, x) => s + x.litersCredited, 0);
  const perPersonDay = liters / population / days;
  return { liters, perPersonDay: Math.round(perPersonDay * 10) / 10, meetsStandard: perPersonDay >= std.litersPerPersonDay };
}
