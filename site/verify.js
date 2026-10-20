// Turns the anchored day into things people recognize: water trucks, a kiosk, food
// sacks, rain gauges and a sealed record. Underneath, every object is checked with the
// same rules as bin/verify.mjs (content hash, Ed25519 signature, the day's Merkle root
// and the Bitcoin BSV transaction that carries it), using only WebCrypto and fetch.
// The page shows the outcome in plain words; the proof details live on GitHub.
"use strict";
(() => {
  const TXID = document.body.dataset.txid;
  const WOC = "https://api.whatsonchain.com/v1/bsv/main";
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const sha = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const fmt = (n) => Math.round(n).toLocaleString("en-US");

  // ---- the same checks as the command-line verifier ---------------------------------
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
  const keys = new Map();
  async function signed(rec) {
    try {
      if ((await contentId(rec)) !== rec.claimId) return false;
      let k = keys.get(rec.signerPub);
      if (!k) { k = await crypto.subtle.importKey("spki", b64(rec.signerPub), { name: "Ed25519" }, false, ["verify"]); keys.set(rec.signerPub, k); }
      return await crypto.subtle.verify({ name: "Ed25519" }, k, b64(rec.sig), enc.encode(rec.claimId));
    } catch { return false; }
  }
  async function merkleRoot(ids) {
    let layer = await Promise.all(ids.map((id) => sha(cat(new Uint8Array([0]), unhex(id.replace(/^0x/, ""))))));
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) next.push(await sha(cat(new Uint8Array([1]), layer[i], layer[i + 1] || layer[i])));
      layer = next;
    }
    return hex(layer[0]);
  }
  const push = (bytes) => bytes.length.toString(16).padStart(2, "0") + hex(bytes);

  // ---- drawing ----------------------------------------------------------------------
  const ICONS = {
    truck: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    tap: '<path d="M4 9h9a3 3 0 0 1 3 3v1h-4v-1H4zM8 6h3v3H8z"/><path d="M14 16c0 1.5 1 2.5 1 3.5a1 1 0 0 1-2 0c0-1 1-2 1-3.5z"/>',
    sack: '<path d="M8 4h8l-1.5 3c3 1.5 4.5 5 4.5 8a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5c0-3 1.5-6.5 4.5-8z"/>',
    rain: '<path d="M7 14a4 4 0 0 1 0-8 5 5 0 0 1 9.6 1.4A3.3 3.3 0 0 1 17 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
    seal: '<path d="M5 5h14v10l-7 5-7-5z"/><path d="M9 10l2 2 4-4"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  // Phones show each card collapsed to icon, name and stamp, with an arrow to open it;
  // cards with a problem start open so issues show without tapping. Wider screens show
  // every card open and the arrow is hidden.
  const narrow = window.matchMedia("(max-width: 640px)");
  function applyMode() {
    for (const d of document.querySelectorAll("details.obj")) d.open = !narrow.matches || d.classList.contains("warn") || d.classList.contains("bad");
  }
  narrow.addEventListener?.("change", applyMode);

  // tone: good | warn | bad | wait
  function card({ icon: ic, title, lines, stamp, tone, compact }) {
    const d = document.createElement("details");
    d.className = `obj ${tone}${compact ? " compact" : ""}`;
    d.innerHTML = `<summary><span class="obj-icon">${icon(ic)}</span><span class="obj-head"><span class="obj-title"></span><span class="stamp"></span></span><span class="chev" aria-hidden="true"></span></summary><ul></ul>`;
    d.querySelector(".obj-title").textContent = title;
    d.querySelector(".stamp").textContent = stamp;
    for (const l of lines) { const li = document.createElement("li"); li.textContent = l; d.querySelector("ul").append(li); }
    d.querySelector("summary").addEventListener("click", (e) => { if (!narrow.matches) e.preventDefault(); });
    return d;
  }
  function group(title, summary, cls) {
    const g = document.createElement("div");
    g.className = "group";
    const h = document.createElement("div"); h.className = "group-head";
    const t = document.createElement("h3"); t.textContent = title;
    const s = document.createElement("p"); s.textContent = summary;
    h.append(t, s);
    const grid = document.createElement("div"); grid.className = cls;
    g.append(h, grid);
    return { el: g, grid };
  }

  // ---- reading the day as objects ---------------------------------------------------
  async function build() {
    const board = $("board"), status = $("status");
    const population = Number(board.dataset.population) || 0;
    board.replaceChildren();
    status.textContent = "Checking every record...";
    let records, batch;
    try {
      [records, batch] = await Promise.all([fetch("day/records.json").then((r) => r.json()), fetch("day/batch.json").then((r) => r.json())]);
    } catch { status.textContent = "Could not load the day. Please reload."; return; }
    try { await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "Ed25519" }, false, ["verify"]); }
    catch { status.textContent = "This browser can't run the check. Try a current Chrome, Edge, Firefox or Safari."; return; }

    const ok = new Map();
    for (const r of records) ok.set(r, await signed(r));
    const allOk = (...recs) => recs.every((r) => r && ok.get(r));
    const of = (kind) => records.filter((r) => r.kind === kind);
    const byId = new Map(records.map((r) => [r.claimId, r]));
    const altered = [...ok.values()].filter((v) => !v).length;

    // Water trucks: one compact card each, under a summary of the day's safe water.
    const trucks = [];
    let safeTrucks = 0, countedL = 0;
    for (const d of of("water-delivery/1")) {
      const rec = records.find((r) => r.kind === "water-received/1" && r.deliveryClaim === d.claimId);
      const q = byId.get(d.qualityId);
      const lines = [`Billed ${fmt(d.liters)} L`, rec ? `Signed for ${fmt(rec.litersReceived)} L` : "Never signed for"];
      let stamp = "Safe", tone = "good";
      if (!allOk(d, rec, q)) { stamp = "Record altered"; tone = "bad"; }
      else if (q.frcMgL < 0.2 || q.turbidityNtu >= 5 || q.eColiCfu > 0) {
        stamp = "Unsafe"; tone = "bad";
        lines.push(q.frcMgL < 0.2 ? "Chlorine too low" : q.eColiCfu > 0 ? "Bacteria found" : "Too cloudy");
      } else if (rec.litersReceived < d.liters * 0.98) {
        stamp = `Short ${fmt(d.liters - rec.litersReceived)} L`; tone = "warn"; countedL += rec.litersReceived;
      } else { safeTrucks++; countedL += rec.litersReceived; }
      trucks.push(card({ icon: "truck", title: `Truck ${d.deliveryId.replace("WD-", "#")}`, lines, stamp, tone, compact: true }));
    }
    if (trucks.length) {
      const perPerson = population ? Math.round((countedL / population) * 10) / 10 : null;
      const sum = `${safeTrucks} of ${trucks.length} safe and complete. ${fmt(countedL)} L of safe water counted` +
        (perPerson !== null ? `, ${perPerson} L per person (15 L needed).` : ".");
      const g = group("Water trucks", sum, "trucks");
      g.grid.append(...trucks);
      board.append(g.el);
    }

    const rest = group("Kiosk, food, drought cover and the seal", "", "others");
    rest.el.querySelector("p").remove();
    board.append(rest.el);
    const add = (c) => rest.grid.append(c);

    // Kiosk
    const open = of("meter-open/1")[0], st = of("meter-state/1").sort((a, b) => b.seq - a.seq)[0];
    if (open && st) {
      const paid = Math.ceil(st.owedMsat / 1000), good = allOk(open, st);
      add(card({
        icon: "tap", title: "Water kiosk", tone: good ? "good" : "bad", stamp: good ? "Fair to both sides" : "Record altered",
        lines: [`${(st.milliliters / 1000).toLocaleString("en-US")} L poured over ${st.seq} visits`, `Charged ${fmt(paid)} sats, exactly what was poured`, `${fmt(open.depositSats - paid)} sats refunded`],
      }));
    }

    // Food
    const m = of("aid-manifest/1")[0], hand = of("aid-handoff/1"), outs = of("aid-handout/1");
    if (m) {
      const intact = allOk(m, ...hand, ...outs);
      let held = m.totalKg, lost = 0, who = "";
      for (const h of hand) { if (held - h.kg > 0) { lost += held - h.kg; who = h.from; } held = h.kg; }
      const served = new Set(outs.map((o) => o.tag)).size;
      add(card({
        icon: "sack", title: "Food aid", tone: !intact ? "bad" : lost ? "warn" : "good",
        stamp: !intact ? "Record altered" : lost ? "Loss traced" : "All accounted for",
        lines: [lost ? `${fmt(m.totalKg)} kg sent, ${fmt(lost)} kg missing with the ${who}` : `${fmt(m.totalKg)} kg sent, none missing`, `${served} of ${m.households} families served`, "Checked against the list, no names shown"],
      }));
    }

    // Rain
    const pol = of("policy/1")[0], rain = of("rain-reading/1"), pay = of("payout/1")[0];
    if (pol) {
      const dry = rain.filter((r) => r.rainMm < pol.triggerMm), intact = allOk(pol, ...rain, ...(pay ? [pay] : []));
      const mm = rain.map((r) => r.rainMm);
      const list = mm.length > 1 ? `${mm.slice(0, -1).join(", ")} and ${mm[mm.length - 1]}` : `${mm[0]}`;
      add(card({
        icon: "rain", title: "Drought cover", tone: intact ? "good" : "bad",
        stamp: !intact ? "Record altered" : pay ? "Paid automatically" : "Not triggered",
        lines: [`Rain in ${pol.windowDays} days: ${list} mm`, `${dry.length} of ${rain.length} sources say drought (${pol.quorum} needed)`, pay ? `${(pay.payoutSats / 1e8).toLocaleString("en-US")} BSV released for shelter` : "No payout due"],
      }));
    }

    // Seal
    const root = await merkleRoot(records.map((r) => r.claimId));
    const script = "006a" + push(enc.encode(batch.tag)) + push(unhex(root));
    const sealMatches = root === batch.root && script === batch.scriptHex;
    const base = [`${fmt(records.length)} receipts sealed together`];
    let seal = card({ icon: "seal", title: "Public seal", lines: base, stamp: "Checking...", tone: "wait" });
    add(seal);
    const setSeal = (lines, stamp, tone) => { const n = card({ icon: "seal", title: "Public seal", lines: [...base, ...lines], stamp, tone }); seal.replaceWith(n); seal = n; };
    if (!sealMatches || altered) setSeal(["Something changed after sealing"], "Seal broken", "bad");
    else {
      try {
        const res = await fetch(`${WOC}/tx/hash/${TXID}`);
        const tx = res.ok ? await res.json() : null;
        const onChain = tx && (tx.vout || []).some((o) => String(o?.scriptPubKey?.hex || "").toLowerCase() === script);
        if (!tx) setSeal(["The public record didn't answer. Try again shortly."], "Not checked yet", "wait");
        else if (!onChain) setSeal(["The public record holds a different seal"], "Seal broken", "bad");
        else {
          const when = tx.blocktime ? new Date(tx.blocktime * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : null;
          setSeal([when ? `Sealed on Bitcoin BSV, ${when}` : "On Bitcoin BSV, waiting for its first block", "Can't be changed, even by us"], "Seal intact", "good");
        }
      } catch { setSeal(["The public record didn't answer. Try again shortly."], "Not checked yet", "wait"); }
    }

    applyMode();
    status.textContent = altered
      ? `${altered} receipt${altered === 1 ? " was" : "s were"} changed after signing, and ${altered === 1 ? "it is" : "they are"} flagged below.`
      : "Every receipt checked in your browser just now. Nothing was sent anywhere.";
    // Arriving on a link to this section: land on it now that the cards have their height.
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  }

  $("recheck").addEventListener("click", build);
  build();
})();
