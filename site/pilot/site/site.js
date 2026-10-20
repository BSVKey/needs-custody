// Public page for one pilot site. Loads every day's records, checks each one (content id,
// signature, and that the signer is an enrolled person whose role may sign that kind of record),
// checks each day's seal against the Bitcoin BSV transaction, and draws the day as object cards.
"use strict";
(() => {
  const { el, fmt, api, KIND_ROLES } = NC;
  const $ = (id) => document.getElementById(id);
  const WOC = "https://api.whatsonchain.com/v1/bsv/main";
  const siteId = location.hash.slice(1);
  let site, days = [], records = [], ok = new Map(), sealState = {}, pick = "all";

  const ICONS = {
    truck: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    tap: '<path d="M4 9h9a3 3 0 0 1 3 3v1h-4v-1H4zM8 6h3v3H8z"/><path d="M14 16c0 1.5 1 2.5 1 3.5a1 1 0 0 1-2 0c0-1 1-2 1-3.5z"/>',
    sack: '<path d="M8 4h8l-1.5 3c3 1.5 4.5 5 4.5 8a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5c0-3 1.5-6.5 4.5-8z"/>',
    rain: '<path d="M7 14a4 4 0 0 1 0-8 5 5 0 0 1 9.6 1.4A3.3 3.3 0 0 1 17 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
    seal: '<path d="M5 5h14v10l-7 5-7-5z"/><path d="M9 10l2 2 4-4"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  };
  const narrow = window.matchMedia("(max-width: 640px)");
  function card({ icon, title, lines, stamp, tone, compact }) {
    const d = el("details", { class: `obj ${tone}${compact ? " compact" : ""}` });
    d.innerHTML = `<summary><span class="obj-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg></span><span class="obj-head"><span class="obj-title"></span><span class="stamp"></span></span><span class="chev" aria-hidden="true"></span></summary><ul></ul>`;
    d.querySelector(".obj-title").textContent = title;
    d.querySelector(".stamp").textContent = stamp;
    d.querySelector("ul").append(...lines.map((l) => el("li", { text: l })));
    d.open = !narrow.matches || tone === "warn" || tone === "bad";
    d.querySelector("summary").addEventListener("click", (e) => { if (!narrow.matches) e.preventDefault(); });
    return d;
  }
  function group(title, summary, cls, cards) {
    return el("div", { class: "group" }, el("div", { class: "group-head" }, el("h3", { text: title }), summary ? el("p", { text: summary }) : null), el("div", { class: cls }, cards));
  }

  async function load() {
    if (!/^ns_[0-9a-f]{18}$/.test(siteId)) { $("name").textContent = "This pilot link is not valid"; $("status").textContent = ""; return; }
    if (!(await NC.ed25519Supported())) { $("status").textContent = "This browser can't run the checks. Try a current Chrome, Edge, Firefox or Safari."; }
    const r = await api(`/needs/public/sites/${siteId}`);
    if (!r.ok) { $("name").textContent = "This pilot isn't public yet"; $("status").textContent = ""; return; }
    site = r.json.site;
    document.title = `${site.name} · Needs Custody`;
    $("name").textContent = site.name;
    const total = site.activatedAt && site.until ? Math.round((site.until - Date.parse(site.activatedAt)) / 86400000) : 90;
    const dayNo = site.activatedAt ? Math.min(total, Math.floor((Date.now() - Date.parse(site.activatedAt)) / 86400000) + 1) : 0;
    $("meta").textContent = `${site.plan === "test" ? "Test pilot" : "Live pilot"} · ${fmt(site.population)} people · ${site.status === "ended" ? "pilot ended" : `day ${dayNo} of ${total}`}`;
    if (site.plan === "test") $("name").after(el("p", { class: "test-banner", text: `This is a $5 test pilot: ${total} days, up to ${fmt(site.recordCap)} receipts. Every receipt and seal on this page is real.` }));
    days = site.days;
    $("status").textContent = `Checking ${fmt(site.recordCount)} receipts...`;
    const loaded = await Promise.all(days.map((d) => api(`/needs/public/sites/${siteId}/days/${d.day}`)));
    loaded.forEach((x, i) => { if (x.ok) for (const rec of x.json.day.records) { records.push(rec); dayOfRec.set(rec, days[i].day); } });
    const members = Object.fromEntries(site.members.map((m) => [m.id, m]));
    for (const rec of records) {
      const m = members[rec.memberId];
      const pinned = m && m.pub === rec.signerPub && (KIND_ROLES[rec.kind] || []).includes(m.role) && rec.siteId === site.id;
      ok.set(rec, pinned && (await NC.verify(rec)));
    }
    tabs();
    await render();
    checkSeals();
  }

  function tabs() {
    const btn = (value, label) => el("button", { type: "button", "aria-pressed": String(pick === value), onclick: () => { pick = value; tabs(); render(); } }, label);
    $("days").replaceChildren(btn("all", "All days"), ...days.slice().reverse().slice(0, 14).map((d) => btn(d.day, new Date(`${d.day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }))));
  }

  const dayOfRec = new Map();
  async function render() {
    const inDay = (rec) => pick === "all" || dayOfRec.get(rec) === pick;
    const sel = records.filter(inDay);
    const good = (r) => ok.get(r);
    const byId = new Map(records.map((r) => [r.claimId, r]));
    const of = (kind, list = sel) => list.filter((r) => r.kind === kind);
    const altered = sel.filter((r) => !good(r)).length;
    const board = $("board");
    board.replaceChildren();

    // Water trucks
    const trucks = [];
    let safe = 0, counted = 0;
    for (const d of of("water-delivery/1").sort((a, b) => b.at - a.at)) {
      const rec = records.find((r) => r.kind === "water-received/1" && r.deliveryClaim === d.claimId);
      const q = d.qualityId ? byId.get(d.qualityId) : null;
      const lines = [`Billed ${fmt(d.liters)} L`, rec ? `Camp signed for ${fmt(rec.litersReceived)} L` : "Camp hasn't confirmed yet"];
      let stamp = "Safe", tone = "good";
      if (!good(d) || (rec && !good(rec)) || (q && !good(q))) { stamp = "Record altered"; tone = "bad"; }
      else if (!q || q.kind !== "water-quality/1") { stamp = "Not tested"; tone = "warn"; lines.push("No water test, so not counted as safe"); }
      else if (q.frcMgL < 0.2 || q.turbidityNtu >= 5 || q.eColiCfu > 0) { stamp = "Unsafe"; tone = "bad"; lines.push(q.frcMgL < 0.2 ? "Chlorine too low" : q.eColiCfu > 0 ? "Bacteria found" : "Too cloudy"); }
      else if (!rec) { stamp = "Waiting for camp"; tone = "wait"; }
      else if (rec.litersReceived < d.liters * 0.98) { stamp = `Short ${fmt(d.liters - rec.litersReceived)} L`; tone = "warn"; counted += rec.litersReceived; }
      else { safe++; counted += rec.litersReceived; }
      trucks.push(card({ icon: "truck", title: d.deliveryId, lines, stamp, tone, compact: true }));
    }
    if (trucks.length) {
      const span = pick === "all" ? Math.max(1, days.length) : 1;
      const per = Math.round((counted / site.population / span) * 10) / 10;
      const shown = trucks.slice(0, 24);
      const g = group("Water trucks", `${safe} of ${trucks.length} safe and complete. ${fmt(counted)} L of safe water counted, ${per} L per person per day (15 L needed).`, "trucks", shown);
      if (trucks.length > 24) g.append(el("button", { class: "btn ghost small-btn", type: "button", onclick: (e) => { g.querySelector(".trucks").append(...trucks.slice(24)); e.target.remove(); } }, `Show all ${trucks.length} deliveries`));
      board.append(g);
    }

    const rest = [];
    // Kiosks
    const sales = of("kiosk-sale/1");
    const kiosks = new Map();
    for (const s of sales) (kiosks.get(s.memberId) || kiosks.set(s.memberId, []).get(s.memberId)).push(s);
    for (const [mid, list] of kiosks) {
      const intact = list.every(good);
      const money = {};
      for (const s of list) money[s.currency] = (money[s.currency] || 0) + s.price;
      rest.push(card({ icon: "tap", title: site.members.find((m) => m.id === mid)?.label || "Water kiosk", tone: intact ? "good" : "bad", stamp: intact ? "Sales recorded" : "Record altered",
        lines: [`${list.length} sale${list.length === 1 ? "" : "s"}, ${fmt(list.reduce((a, s) => a + s.liters, 0), 1)} L`, `Takings: ${Object.entries(money).map(([c, v]) => `${fmt(v, 2)} ${c}`).join(", ")}`] }));
    }

    // Food, per consignment (manifests from any day, activity in the chosen days)
    for (const m of of("aid-manifest/1", records)) {
      const hand = of("aid-handoff/1").filter((h) => h.consignmentId === m.consignmentId);
      const outs = of("aid-handout/1").filter((h) => h.consignmentId === m.consignmentId);
      if (pick !== "all" && !hand.length && !outs.length && dayOfRec.get(m) !== pick) continue;
      const allHand = of("aid-handoff/1", records).filter((h) => h.consignmentId === m.consignmentId);
      const toCarrier = allHand.find((h) => h.to === "carrier"), toPoint = allHand.find((h) => h.to === "distribution");
      const lines = [`${fmt(m.totalKg, 1)} kg sent for ${fmt(m.households)} households`];
      let lost = 0;
      if (toCarrier && m.totalKg - toCarrier.kg > 0.01) { lines.push(`${fmt(m.totalKg - toCarrier.kg, 1)} kg missing at pickup`); lost += m.totalKg - toCarrier.kg; }
      if (toCarrier && toPoint && toCarrier.kg - toPoint.kg > 0.01) { lines.push(`${fmt(toCarrier.kg - toPoint.kg, 1)} kg missing with the carrier`); lost += toCarrier.kg - toPoint.kg; }
      if (!toPoint) lines.push("Not at the distribution point yet");
      const tags = new Set(); let doubles = 0, bad = 0, kg = 0;
      for (const o of of("aid-handout/1", records).filter((h) => h.consignmentId === m.consignmentId).sort((a, b) => a.at - b.at)) {
        if (!(await NC.verifyProof(await NC.entitlementLeaf(o), o.branch, o.index, m.root))) { bad++; continue; }
        if (tags.has(o.tag)) { doubles++; continue; }
        tags.add(o.tag); kg += o.rationKg;
      }
      lines.push(`${fmt(tags.size)} of ${fmt(m.households)} families served (${fmt(kg, 1)} kg)`);
      if (doubles) lines.push(`${doubles} double claim${doubles > 1 ? "s" : ""} flagged`);
      if (bad) lines.push(`${bad} handout${bad > 1 ? "s" : ""} not on the list`);
      const intact = [m, ...allHand, ...outs].every(good);
      rest.push(card({ icon: "sack", title: `Food ${m.consignmentId}`, lines, tone: !intact || doubles || bad ? "bad" : lost ? "warn" : "good",
        stamp: !intact ? "Record altered" : doubles || bad ? "Problems flagged" : lost ? "Loss traced" : tags.size >= m.households ? "All families served" : "In progress" }));
    }

    // Drought cover: the latest window, latest reading per source
    const rain = of("rain-reading/1", records);
    if (rain.length) {
      const end = rain.map((r) => r.windowEnd).sort().at(-1);
      const latest = new Map();
      for (const r of rain.filter((x) => x.windowEnd === end).sort((a, b) => a.at - b.at)) latest.set(r.source, r);
      const list = [...latest.values()], dry = list.filter((r) => r.rainMm < site.drought.triggerMm);
      const intact = list.every(good), met = dry.length >= site.drought.quorum;
      rest.push(card({ icon: "rain", title: "Drought cover", tone: !intact ? "bad" : met ? "warn" : "good", stamp: !intact ? "Record altered" : met ? "Trigger met" : "No drought",
        lines: [...list.map((r) => `${r.source}: ${r.rainMm} mm in ${r.windowDays} days`), `${dry.length} of ${list.length} sources under ${site.drought.triggerMm} mm (${site.drought.quorum} needed)`, met ? "Release the drought funds by your own process" : `Up to ${end}`] }));
    }

    // Phones: every person's records arrive as an unbroken chain
    if (pick === "all") {
      const byMember = new Map();
      for (const r of records) (byMember.get(r.memberId) || byMember.set(r.memberId, []).get(r.memberId)).push(r);
      let missing = 0;
      for (const list of byMember.values()) {
        list.sort((a, b) => a.seq - b.seq);
        list.forEach((r, i) => { if (r.seq !== i + 1 || r.prev !== (i ? list[i - 1].claimId : null)) missing++; });
      }
      const people = site.members.filter((m) => !m.revokedAt).length;
      rest.push(card({ icon: "phone", title: "Field phones", tone: missing ? "bad" : "good", stamp: missing ? "Records missing" : "Nothing missing",
        lines: [`${people} people recording`, `${fmt(records.length)} receipts in all`, missing ? `${missing} receipts are out of order or missing` : "Every phone's receipts arrive in an unbroken chain"] }));
    }

    // Seal
    const chosen = pick === "all" ? days : days.filter((d) => d.day === pick);
    const sealedN = chosen.filter((d) => d.seal).length;
    const broken = chosen.filter((d) => sealState[d.day] === "broken").length;
    const checked = chosen.filter((d) => sealState[d.day] === "ok").length;
    const today = NC.today();
    rest.push(card({ icon: "seal", title: "Public seal", tone: broken ? "bad" : sealedN && checked === sealedN ? "good" : "wait",
      stamp: broken ? "Seal broken" : sealedN && checked === sealedN ? "Seal intact" : sealedN ? "Checking..." : "Seals tonight",
      lines: [`${sealedN} of ${chosen.length} day${chosen.length === 1 ? "" : "s"} sealed on Bitcoin BSV`, chosen.some((d) => d.day === today && !d.seal) ? "Today seals after midnight UTC" : "Can't be changed, even by us"] }));

    if (rest.length) board.append(group("Kiosk, food, drought cover, phones and the seal", "", "others", rest));
    if (!records.length) board.append(el("p", { class: "fine", text: "No receipts yet. They appear here as soon as the first phone sends one." }));
    $("status").textContent = altered ? `${altered} receipt${altered === 1 ? " was" : "s were"} changed or signed by someone not on this pilot, and flagged below.` : "Every receipt checked in your browser just now. Nothing was sent anywhere.";
  }

  async function checkSeals() {
    for (const d of days.filter((x) => x.seal)) {
      const list = records.filter((r) => dayOfRec.get(r) === d.day);
      const tree = await NC.buildTree(await Promise.all(list.map((r) => NC.claimLeaf(r.claimId))));
      if (tree.root !== d.seal.root) { sealState[d.day] = "broken"; continue; }
      try {
        const r = await fetch(`${WOC}/tx/hash/${d.seal.txid}`);
        const tx = r.ok ? await r.json() : null;
        sealState[d.day] = tx && (tx.vout || []).some((o) => String(o?.scriptPubKey?.hex || "").toLowerCase() === NC.anchorScript(d.seal.root)) ? "ok" : tx ? "broken" : "unknown";
      } catch { sealState[d.day] = "unknown"; }
      await new Promise((r) => setTimeout(r, 350)); // stay under the public API's rate limit
    }
    render();
  }

  load().catch((e) => { $("status").textContent = `Could not load this pilot (${e.message}).`; });
})();
