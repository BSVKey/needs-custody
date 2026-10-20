// Field app: one screen per role. Every record is signed on this phone with its own key, chained
// (seq + prev) and kept in an offline outbox until the server accepts it. If the server refuses a
// record, the rest of the queue is re-chained after the last accepted record and sent again.
"use strict";
(() => {
  const { el, fmt, api, message, ROLES } = NC;
  const $ = (id) => document.getElementById(id);
  let ids = {}, me = null, cache = { records: [], manifests: {}, site: null, at: 0 }, syncing = false, lastSync = null, blocked = null;

  const notice = (text, tone = "info") => { const n = $("notice"); n.hidden = !text; n.textContent = text || ""; n.className = `notice ${tone}`; };
  const saveMe = async () => { ids[me.memberId] = me; await NC.kvSet("identities", ids); };
  const recentKey = () => `recent:${me.memberId}`;
  const time = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const labelOf = (memberId) => cache.site?.members?.find((m) => m.id === memberId)?.label || "someone";

  // ---- signing and the outbox ------------------------------------------------------------------
  async function record(content, summary) {
    const rec = await NC.sign(me.key, { siteId: me.siteId, memberId: me.memberId, seq: me.seq + 1, prev: me.prev, at: Date.now(), ...content });
    me.seq = rec.seq; me.prev = rec.claimId;
    await saveMe();
    await NC.outboxPut({ claimId: rec.claimId, memberId: me.memberId, seq: rec.seq, rec, summary });
    const recent = (await NC.kvGet(recentKey())) || [];
    recent.unshift({ claimId: rec.claimId, summary, at: rec.at, status: "waiting" });
    await NC.kvSet(recentKey(), recent.slice(0, 50));
    renderRecent();
    sync();
    return rec;
  }

  async function setStatus(claimIds, status) {
    for (const id of Object.keys(ids)) {
      const k = `recent:${id}`, list = (await NC.kvGet(k)) || [];
      let changed = false;
      for (const r of list) if (claimIds.has(r.claimId)) { r.status = status; changed = true; }
      if (changed) await NC.kvSet(k, list);
    }
  }

  const STOP = /removed|ended|not paid|used all/;
  const CHAIN = /^(gap|fork)/;
  let again = false;
  async function sync() {
    if (syncing) { again = true; return renderSync(); } // something was queued mid-sync: run once more after
    if (!navigator.onLine) return renderSync();
    syncing = true; again = false; renderSync();
    try {
      // Food lists first: the server only needs the signed manifest to check them.
      const lists = (await NC.kvGet("pending-lists")) || [];
      const left = [];
      for (const l of lists) {
        const r = await api("/needs/lists", { method: "POST", body: { siteId: l.siteId, manifest: l.manifest, entitlements: l.entitlements } });
        if (r.status !== 201) left.push(l);
      }
      await NC.kvSet("pending-lists", left);

      const all = (await NC.outboxAll()).sort((a, b) => (a.memberId === b.memberId ? a.seq - b.seq : a.memberId < b.memberId ? -1 : 1));
      const bySite = new Map();
      for (const e of all) { if (ids[e.memberId]?.blocked) continue; const s = e.rec.siteId; (bySite.get(s) || bySite.set(s, []).get(s)).push(e); }
      for (const [siteId, entries] of bySite) {
        for (let i = 0; i < entries.length; i += 100) {
          const batch = entries.slice(i, i + 100);
          const r = await api("/needs/records", { method: "POST", body: { siteId, records: batch.map((e) => e.rec) } });
          if (!r.ok) throw new Error(message(r, "the server did not accept the batch"));
          const done = new Set([...r.json.accepted, ...r.json.duplicate]);
          await NC.outboxDel([...done]);
          await setStatus(done, "sent");
          if (r.json.rejected.length) { await repair(siteId, r.json.rejected); break; }
        }
      }
      lastSync = { at: Date.now(), ok: true };
    } catch (e) {
      lastSync = { at: Date.now(), ok: false, error: e.message };
    } finally {
      syncing = false;
      renderSync(); renderRecent();
      if (again) sync();
    }
  }

  // Drop records the server can never accept, then re-chain the rest after the server's last one.
  async function repair(siteId, rejected) {
    const byMember = new Map();
    for (const x of rejected) if (x.memberId) (byMember.get(x.memberId) || byMember.set(x.memberId, []).get(x.memberId)).push(x);
    for (const [memberId, list] of byMember) {
      const who = ids[memberId];
      if (!who) continue;
      const stop = list.find((x) => STOP.test(x.reason));
      if (stop) { who.blocked = stop.reason; ids[memberId] = who; await NC.kvSet("identities", ids); if (me.memberId === memberId) blocked = stop.reason; continue; }
      const fatal = new Set(list.filter((x) => !CHAIN.test(x.reason)).map((x) => x.claimId));
      if (fatal.size) { await setStatus(fatal, "refused"); notice(`A record was refused: ${list.find((x) => fatal.has(x.claimId)).reason}.`, "bad"); }
      const st = await api(`/needs/member/${siteId}/${memberId}`);
      if (!st.ok) continue;
      let seq = st.json.member.lastSeq, prev = st.json.member.lastClaim;
      const mine = (await NC.outboxAll()).filter((e) => e.memberId === memberId).sort((a, b) => a.seq - b.seq);
      const drop = [], put = [], renamed = new Map();
      for (const e of mine) {
        drop.push(e.claimId);
        if (fatal.has(e.claimId)) continue;
        const { claimId, sig, signerPub, ...content } = e.rec;
        const rec = await NC.sign(who.key, { ...content, seq: ++seq, prev });
        prev = rec.claimId;
        put.push({ claimId: rec.claimId, memberId, seq: rec.seq, rec, summary: e.summary });
        renamed.set(claimId, rec.claimId);
      }
      await NC.outboxReplace(drop, put);
      who.seq = seq; who.prev = prev; ids[memberId] = who;
      await NC.kvSet("identities", ids);
      if (me.memberId === memberId) { me.seq = seq; me.prev = prev; }
      const k = `recent:${memberId}`, recent = (await NC.kvGet(k)) || [];
      for (const r of recent) if (renamed.has(r.claimId)) r.claimId = renamed.get(r.claimId);
      await NC.kvSet(k, recent);
    }
    setTimeout(sync, 500); // send the re-chained queue once this sync has finished
  }

  // ---- what others have recorded (for picking a reading, a delivery or a consignment) -----------
  async function refresh() {
    const saved = await NC.kvGet(`cache:${me.siteId}`);
    if (saved) cache = saved;
    if (!navigator.onLine) return;
    try {
      const s = await api(`/needs/public/sites/${me.siteId}`);
      if (!s.ok) return;
      const days = s.json.site.days.map((d) => d.day).slice(-14);
      const records = [];
      for (const d of days) { const r = await api(`/needs/public/sites/${me.siteId}/days/${d}`); if (r.ok) records.push(...r.json.day.records); }
      const manifests = { ...(cache.manifests || {}) };
      for (const r of records) if (r.kind === "aid-manifest/1") manifests[r.claimId] = r;
      cache = { site: s.json.site, records, manifests, at: Date.now() };
      await NC.kvSet(`cache:${me.siteId}`, cache);
    } catch { /* offline or slow: keep the saved copy */ }
  }
  async function known(kind) {
    const local = (await NC.outboxAll()).filter((e) => e.rec.siteId === me.siteId).map((e) => e.rec);
    const all = [...cache.records, ...local];
    if (kind === "aid-manifest/1") all.push(...Object.values(cache.manifests || {}));
    const seen = new Set();
    return all.filter((r) => r.kind === kind && !seen.has(r.claimId) && seen.add(r.claimId)).sort((a, b) => b.at - a.at);
  }

  // ---- forms -----------------------------------------------------------------------------------
  const field = (label, input, hint) => el("label", {}, label, input, hint ? el("span", { class: "fine", text: hint }) : null);
  const numIn = (name, attrs = {}) => el("input", { name, type: "number", inputmode: "decimal", step: "any", required: true, class: "big-input", ...attrs });
  function form(title, kids, onsubmit, button = "Sign and save") {
    const f = el("form", { class: "card" }, el("h3", { text: title }), kids, el("button", { class: "btn", type: "submit" }, button));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (blocked) return notice(`This phone can't add records: ${blocked}.`, "bad");
      const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      try { const msg = await onsubmit(new FormData(f), f); if (msg) { notice(msg, "good"); f.reset(); await draw(); } }
      catch (err) { notice(err.message, "bad"); }
      finally { btn.disabled = false; }
    });
    return f;
  }
  const must = (ok, msg) => { if (!ok) throw new Error(msg); };
  const n = (v) => Number(String(v).replace(",", "."));

  const ROLE_FORMS = {
    tester: () => [form("Water test", [
      field("Free chlorine (mg/L)", numIn("frc", { min: 0, max: 50 })),
      field("Turbidity (NTU)", numIn("ntu", { min: 0, max: 1000 })),
      field("E. coli per 100 mL", numIn("ecoli", { min: 0, step: 1, value: 0 })),
    ], async (f) => {
      const frcMgL = n(f.get("frc")), turbidityNtu = n(f.get("ntu")), eColiCfu = n(f.get("ecoli"));
      must([frcMgL, turbidityNtu, eColiCfu].every(Number.isFinite), "Fill in all three numbers.");
      await record({ kind: "water-quality/1", frcMgL, turbidityNtu, eColiCfu }, `Water test: chlorine ${frcMgL} mg/L, turbidity ${turbidityNtu} NTU, E. coli ${eColiCfu}`);
      return "Test saved.";
    })],

    driver: async () => {
      const tests = (await known("water-quality/1")).filter((r) => Date.now() - r.at < 36 * 3600000);
      const sel = el("select", { name: "quality" }, tests.map((t) => el("option", { value: t.claimId, text: `${time(t.at)}: chlorine ${t.frcMgL} mg/L, by ${labelOf(t.memberId)}` })), el("option", { value: "", text: "No water test available" }));
      const count = (await known("water-delivery/1")).filter((r) => r.memberId === me.memberId).length;
      return [form("Water delivery", [
        field("Delivery number", el("input", { name: "id", required: true, maxlength: 64, value: `${me.label.split(/\s+/).map((w) => w[0]).join("").toUpperCase() || "D"}-${NC.today()}-${count + 1}` })),
        field("Liters delivered", numIn("liters", { min: 1, max: 1000000, step: 1 })),
        field("Water test for this load", sel, "Pick the test done on this water. Without one, the water can't count as safe."),
      ], async (f) => {
        const liters = n(f.get("liters"));
        must(liters >= 1, "Enter the liters delivered.");
        await record({ kind: "water-delivery/1", deliveryId: String(f.get("id")).trim(), liters, qualityId: f.get("quality") || null }, `Delivery ${f.get("id")}: ${fmt(liters)} L`);
        return "Delivery saved. The camp will confirm what it received.";
      })];
    },

    camp: async () => {
      const got = new Set((await known("water-received/1")).map((r) => r.deliveryClaim));
      const open = (await known("water-delivery/1")).filter((d) => !got.has(d.claimId));
      if (!open.length) return [el("div", { class: "card" }, el("h3", { text: "Confirm a delivery" }), el("p", { class: "fine", text: "No deliveries are waiting for you. When a driver records one it shows up here (pull to refresh)." }))];
      const sel = el("select", { name: "delivery", required: true }, open.map((d) => el("option", { value: d.claimId, text: `${d.deliveryId}: ${fmt(d.liters)} L billed, ${time(d.at)}` })));
      return [form("Confirm a delivery", [
        field("Delivery", sel),
        field("Liters actually received", numIn("liters", { min: 0, max: 1000000, step: 1 }), "Count what arrived, not what was billed."),
      ], async (f) => {
        const d = open.find((x) => x.claimId === f.get("delivery")), liters = n(f.get("liters"));
        must(d && Number.isFinite(liters), "Pick a delivery and enter the liters received.");
        await record({ kind: "water-received/1", deliveryId: d.deliveryId, deliveryClaim: d.claimId, litersReceived: liters }, `Received ${d.deliveryId}: ${fmt(liters)} of ${fmt(d.liters)} L`);
        return "Saved. Thank you.";
      }, "Sign receipt")];
    },

    kiosk: async () => {
      const cur = (await NC.kvGet(`currency:${me.memberId}`)) || "USD";
      return [form("Water sale", [
        field("Liters poured", numIn("liters", { min: 0.01, max: 100000 })),
        field("Price paid", numIn("price", { min: 0 })),
        field("Currency", el("input", { name: "currency", required: true, maxlength: 8, value: cur })),
      ], async (f) => {
        const liters = n(f.get("liters")), price = n(f.get("price")), currency = String(f.get("currency")).trim().toUpperCase();
        must(liters > 0 && price >= 0 && currency, "Enter liters, price and currency.");
        await NC.kvSet(`currency:${me.memberId}`, currency);
        await record({ kind: "kiosk-sale/1", liters, price, currency }, `Sale: ${liters} L for ${price} ${currency}`);
        return "Sale saved.";
      })];
    },

    warehouse: () => [form("Send a food consignment", [
      field("Consignment number", el("input", { name: "id", required: true, maxlength: 64, placeholder: "e.g. FA-2026-11-01" })),
      field("Household list", el("textarea", { name: "list", required: true, placeholder: "One household per line: ration card number, ration kg\nRC-1001, 25\nRC-1002, 12.5" }), "Card numbers are turned into private codes on this phone. Names and numbers are never published."),
    ], async (f) => {
      const lines = String(f.get("list")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const seen = new Set(), ents = [];
      for (const [i, line] of lines.entries()) {
        const [card, kg] = line.split(/[,;\t]/).map((x) => x.trim());
        must(card && Number.isFinite(n(kg)) && n(kg) > 0, `Line ${i + 1} needs a card number and a ration in kg.`);
        must(!seen.has(card), `Card ${card} appears twice.`);
        seen.add(card);
        ents.push({ tag: await NC.householdTag(me.site.salt, card), rationKg: n(kg) });
      }
      must(ents.length, "Add at least one household.");
      const tree = await NC.buildTree(await Promise.all(ents.map(NC.entitlementLeaf)));
      const totalKg = Math.round(ents.reduce((a, e) => a + e.rationKg, 0) * 1000) / 1000;
      const manifest = await record({ kind: "aid-manifest/1", consignmentId: String(f.get("id")).trim(), root: tree.root, households: ents.length, totalKg }, `Consignment ${f.get("id")}: ${ents.length} households, ${fmt(totalKg, 1)} kg`);
      const pending = (await NC.kvGet("pending-lists")) || [];
      pending.push({ siteId: me.siteId, manifest, entitlements: ents });
      await NC.kvSet("pending-lists", pending);
      sync();
      return `Consignment saved: ${ents.length} households, ${fmt(totalKg, 1)} kg.`;
    }, "Sign consignment")],

    carrier: async () => [await receiveForm("warehouse", "carrier")],

    distribution: async () => [await receiveForm("carrier", "distribution"), await handoutForm()],

    rain: async () => {
      const src = (await NC.kvGet(`source:${me.memberId}`)) || "";
      const d = me.site.drought;
      return [form("Rain reading", [
        field("Source", el("input", { name: "source", required: true, maxlength: 64, value: src, placeholder: "e.g. Camp gauge 1, Met service" })),
        field(`Rain in the last ${d.windowDays} days (mm)`, numIn("mm", { min: 0, max: 5000 })),
        field("Up to (date)", el("input", { name: "end", type: "date", required: true, value: NC.today() })),
      ], async (f) => {
        const source = String(f.get("source")).trim(), rainMm = n(f.get("mm"));
        must(source && Number.isFinite(rainMm), "Enter the source and the rain in mm.");
        await NC.kvSet(`source:${me.memberId}`, source);
        await record({ kind: "rain-reading/1", source, rainMm, windowDays: d.windowDays, windowEnd: String(f.get("end")) }, `Rain: ${rainMm} mm in ${d.windowDays} days (${source})`);
        return rainMm < d.triggerMm ? `Saved. ${rainMm} mm is under the ${d.triggerMm} mm trigger.` : "Saved.";
      })];
    },
  };

  async function receiveForm(from, to) {
    const mans = await known("aid-manifest/1");
    if (!mans.length) return el("div", { class: "card" }, el("h3", { text: "Receive food" }), el("p", { class: "fine", text: "No consignments yet. They appear once the warehouse records one." }));
    return form(`Receive food from the ${from}`, [
      field("Consignment", el("select", { name: "c", required: true }, mans.map((m) => el("option", { value: m.consignmentId, text: `${m.consignmentId}: ${fmt(m.totalKg, 1)} kg for ${m.households} households` })))),
      field("Kilograms you received", numIn("kg", { min: 0, max: 10000000 }), "Weigh it. Any difference is recorded against whoever held it before you."),
    ], async (f) => {
      const kg = n(f.get("kg"));
      must(Number.isFinite(kg), "Enter the kilograms received.");
      await record({ kind: "aid-handoff/1", consignmentId: f.get("c"), from, to, kg }, `Received ${f.get("c")} from the ${from}: ${fmt(kg, 1)} kg`);
      return "Saved.";
    }, "Sign receipt");
  }

  const trees = new Map();
  async function handoutForm() {
    const mans = await known("aid-manifest/1");
    if (!mans.length) return el("span");
    const served = new Set((await known("aid-handout/1")).map((h) => `${h.consignmentId}:${h.tag}`));
    return form("Hand out a ration", [
      field("Consignment", el("select", { name: "c", required: true }, mans.map((m) => el("option", { value: m.claimId, text: m.consignmentId })))),
      field("Ration card number", el("input", { name: "card", required: true, autocomplete: "off", class: "big-input" })),
    ], async (f) => {
      const m = mans.find((x) => x.claimId === f.get("c"));
      let t = trees.get(m.root);
      if (!t) {
        let list = await NC.kvGet(`list:${m.root}`);
        if (!list) {
          const r = await api(`/needs/public/sites/${me.siteId}/lists/${m.root}`);
          must(r.ok, "The household list isn't available yet. Connect to the internet once, then try again.");
          list = r.json.list; await NC.kvSet(`list:${m.root}`, list);
        }
        const tree = await NC.buildTree(await Promise.all(list.entitlements.map(NC.entitlementLeaf)));
        must(tree.root === m.root, "The household list doesn't match the consignment.");
        t = { tree, list }; trees.set(m.root, t);
      }
      const tag = await NC.householdTag(me.site.salt, f.get("card"));
      const index = t.list.entitlements.findIndex((e) => e.tag === tag);
      must(index >= 0, "That card is not on the list for this consignment.");
      must(!served.has(`${m.consignmentId}:${tag}`), "That household has already received this ration.");
      const rationKg = t.list.entitlements[index].rationKg;
      await record({ kind: "aid-handout/1", consignmentId: m.consignmentId, tag, rationKg, index, branch: NC.proof(t.tree, index) }, `Handed out ${fmt(rationKg, 1)} kg (${m.consignmentId})`);
      served.add(`${m.consignmentId}:${tag}`);
      return `Give ${fmt(rationKg, 1)} kg. Recorded.`;
    }, "Check and record");
  }

  // ---- screen ------------------------------------------------------------------------------------
  async function draw() {
    $("site-name").textContent = me.site.name;
    $("who-name").textContent = me.label;
    $("who-role").textContent = ROLES[me.role];
    blocked = me.blocked || null;
    if (blocked) notice(`This phone can't add records: ${blocked}.`, "bad");
    const make = ROLE_FORMS[me.role];
    $("forms").replaceChildren(...(await make()));
    renderRecent(); renderSync();
  }
  async function renderRecent() {
    if (!me) return;
    const list = (await NC.kvGet(recentKey())) || [];
    $("recent").replaceChildren(...(list.length ? list.slice(0, 20).map((r) => el("li", {}, `${time(r.at)} · ${r.summary} · `, el("strong", { text: r.status === "sent" ? "sent" : r.status === "refused" ? "refused" : "waiting to send" }))) : [el("li", { text: "Nothing yet." })]));
  }
  async function renderSync() {
    const waiting = (await NC.outboxAll()).length;
    $("dot").className = `dot ${navigator.onLine ? "on" : "off"}`;
    $("sync-text").textContent = syncing ? "Sending..." : `${navigator.onLine ? "Online" : "No signal"} · ${waiting ? `${waiting} waiting to send` : "everything sent"}${lastSync && !lastSync.ok ? " · last try failed" : ""}`;
  }

  async function start() {
    if (!(await NC.ed25519Supported())) { $("none").hidden = false; $("none").querySelector("h1").textContent = "Please update this browser"; return; }
    ids = (await NC.kvGet("identities")) || {};
    const cur = await NC.kvGet("current");
    me = ids[cur] || Object.values(ids)[0];
    if (!me) { $("none").hidden = false; return; }
    $("main").hidden = false;
    const others = Object.values(ids);
    if (others.length > 1) {
      const sw = $("switch"); sw.hidden = false;
      sw.replaceChildren(...others.map((x) => el("option", { value: x.memberId, text: `${x.label} (${x.site.name})`, selected: x.memberId === me.memberId })));
      sw.onchange = async () => { await NC.kvSet("current", sw.value); location.reload(); };
    }
    await refresh();
    await draw();
    $("send").onclick = async () => { await sync(); await refresh(); await draw(); };
    window.addEventListener("online", () => { renderSync(); sync(); });
    window.addEventListener("offline", renderSync);
    setInterval(() => sync(), 30000);
    sync();
    navigator.serviceWorker?.register("/pilot/app/sw.js", { scope: "/pilot/app/" }).catch(() => {});
  }
  start();
})();
