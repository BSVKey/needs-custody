// Pay-per-liter at a water kiosk over a prepaid channel. The buyer locks a deposit,
// then signs a cumulative state after every dispense (milliliters so far, amount owed
// in millisatoshis so partial containers bill exactly). The kiosk accepts a state only
// if it is the next seq and never lowers the volume, so the kiosk always holds the
// newest one. Only the buyer's key can raise what is owed; at close the highest valid
// seq settles, so a buyer closing on an old state loses to the kiosk's newer one.
import { signRecord } from "../lib/receipt.mjs";
import { checkSigned } from "./common.mjs";

export const openChannel = (buyerKp, { channelId, kioskId, kioskPub, depositSats, priceMsatPerLiter }) =>
  signRecord(buyerKp, { kind: "meter-open/1", channelId, kioskId, kioskPub, depositSats, priceMsatPerLiter });

const owedFor = (open, milliliters) => Math.ceil((milliliters * open.priceMsatPerLiter) / 1000);

export const meterState = (buyerKp, open, { seq, milliliters }) =>
  signRecord(buyerKp, {
    kind: "meter-state/1", channelId: open.channelId, openId: open.claimId, seq, milliliters,
    owedMsat: owedFor(open, milliliters),
  });

// A state is valid if the buyer who opened the channel signed it, it belongs to this
// channel, the amount matches the price, and it fits inside the deposit.
export function verifyState(open, state) {
  let r;
  if ((r = checkSigned(open, "meter-open/1"))) return `open: ${r}`;
  if ((r = checkSigned(state, "meter-state/1", open.signerPub))) return `state: ${r}`;
  if (state.openId !== open.claimId || state.channelId !== open.channelId) return "state is for another channel";
  if (!Number.isInteger(state.seq) || state.seq < 1) return "bad seq";
  if (state.owedMsat !== owedFor(open, state.milliliters)) return "owed does not match price";
  if (state.owedMsat > open.depositSats * 1000) return "owed exceeds deposit";
  return null;
}

// Kiosk side: accept the next state before dispensing more.
export function kioskAccept(open, prev, next) {
  const bad = verifyState(open, next);
  if (bad) return { ok: false, reason: bad };
  const prevSeq = prev ? prev.seq : 0, prevMl = prev ? prev.milliliters : 0;
  if (next.seq !== prevSeq + 1) return { ok: false, reason: "not the next seq" };
  if (next.milliliters < prevMl) return { ok: false, reason: "volume went down" };
  return { ok: true };
}

// Settle from every state either party presents. On chain only whole satoshis move,
// so the kiosk receives the owed amount rounded up and the buyer gets the rest back.
export function settle(open, presented) {
  const valid = presented.filter((s) => verifyState(open, s) === null);
  const rejected = presented.length - valid.length;
  if (!valid.length) return { ok: false, reason: "no valid state", rejected };
  const final = valid.reduce((a, b) => (b.seq > a.seq ? b : a));
  const kioskSats = Math.ceil(final.owedMsat / 1000);
  return { ok: true, seq: final.seq, liters: final.milliliters / 1000, kioskSats, buyerRefundSats: open.depositSats - kioskSats, rejected };
}
