// In-browser check of the anchored day: every record's content address and Ed25519
// signature, the Merkle root over all claimIds, and the Bitcoin BSV transaction that
// carries that root. Same rules as bin/verify.mjs, using only WebCrypto and fetch.
"use strict";
(() => {
  const TXID = document.body.dataset.txid;
  const WOC = "https://api.whatsonchain.com/v1/bsv/main";
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
  const sha = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const cat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

  function sortDeep(v) {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]); return o; }
    return v;
  }
  async function contentId(rec) {
    const c = {};
    for (const k of Object.keys(rec)) if (k !== "claimId" && k !== "sig" && k !== "signerPub") c[k] = rec[k];
    return "0x" + hex(await sha(enc.encode(JSON.stringify(sortDeep(c)))));
  }
  const keyCache = new Map();
  async function verifySig(pubB64, claimId, sigB64) {
    let key = keyCache.get(pubB64);
    if (!key) {
      key = await crypto.subtle.importKey("spki", Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]);
      keyCache.set(pubB64, key);
    }
    return crypto.subtle.verify({ name: "Ed25519" }, key, Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0)), enc.encode(claimId));
  }
  async function merkleRoot(claimIds) {
    let layer = await Promise.all(claimIds.map((id) => sha(cat(new Uint8Array([0]), unhex(id.replace(/^0x/, ""))))));
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) next.push(await sha(cat(new Uint8Array([1]), layer[i], layer[i + 1] || layer[i])));
      layer = next;
    }
    return hex(layer[0]);
  }
  const push = (bytes) => bytes.length.toString(16).padStart(2, "0") + hex(bytes);

  function row(label, value, state) {
    const li = document.createElement("li");
    li.className = state;
    const b = document.createElement("strong"); b.textContent = label;
    const s = document.createElement("span"); s.textContent = value;
    li.append(b, s);
    $("results").append(li);
  }

  async function run() {
    const btn = $("verify-btn");
    btn.disabled = true; btn.textContent = "Checking...";
    $("results").replaceChildren();
    try {
      try {
        await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "Ed25519" }, false, ["verify"]);
      } catch {
        row("Browser", "This browser has no Ed25519 in WebCrypto. Try a current Chrome, Edge, Firefox or Safari.", "bad");
        return;
      }
      const [records, batch] = await Promise.all([fetch("day/records.json").then((r) => r.json()), fetch("day/batch.json").then((r) => r.json())]);
      let bad = 0;
      const kinds = {};
      for (const r of records) {
        const ok = (await contentId(r)) === r.claimId && (await verifySig(r.signerPub, r.claimId, r.sig));
        if (!ok) bad++;
        kinds[r.kind] = (kinds[r.kind] || 0) + 1;
      }
      row("Signatures", `${records.length - bad} of ${records.length} records: content hash and signature both check`, bad ? "bad" : "good");
      row("Record types", Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", "), "info");
      const root = await merkleRoot(records.map((r) => r.claimId));
      const script = "006a" + push(enc.encode(batch.tag)) + push(unhex(root));
      const rootOk = root === batch.root && script === batch.scriptHex;
      row("Merkle root", `${rootOk ? "recomputed here, matches" : "MISMATCH"}: ${root}`, rootOk ? "good" : "bad");
      if (!TXID) { row("Anchor", "Not broadcast yet.", "info"); return; }
      const res = await fetch(`${WOC}/tx/hash/${TXID}`);
      if (!res.ok) { row("Anchor", `WhatsOnChain returned ${res.status} for ${TXID}. If it was just sent, try again in a minute.`, "info"); return; }
      const tx = await res.json();
      const onChain = (tx.vout || []).some((o) => String(o?.scriptPubKey?.hex || "").toLowerCase() === script);
      const when = tx.blocktime ? `, block time ${new Date(tx.blocktime * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC` : ", not yet in a block";
      row("Bitcoin BSV anchor", onChain ? `tx ${TXID.slice(0, 12)}... carries exactly this root${when}, ${tx.confirmations || 0} confirmation${tx.confirmations === 1 ? "" : "s"}` : `tx ${TXID} does NOT carry this root`, onChain ? "good" : "bad");
    } catch (e) {
      row("Error", e.message, "bad");
    } finally {
      btn.disabled = false; btn.textContent = "Verify again";
    }
  }
  $("verify-btn").addEventListener("click", run);
})();
