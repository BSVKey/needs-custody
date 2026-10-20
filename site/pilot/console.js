// Owner console: account, pilot sites, payment, invites, people, seals and export.
"use strict";
(() => {
  const { api, message, el, fmt, money, ROLES } = NC;
  const $ = (id) => document.getElementById(id);
  const KEY = "needs-pilot-key";
  const store = { get: () => { try { return localStorage.getItem(KEY); } catch { return null; } }, set: (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* private mode */ } } };
  let key = store.get(), account = null, price = 25000;

  function notice(text, tone = "info") {
    const n = $("notice");
    n.hidden = !text; n.textContent = text || ""; n.className = `notice ${tone}`;
    if (text) n.scrollIntoView({ block: "nearest" });
  }

  // ---- account ---------------------------------------------------------------------------------
  $("create").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), btn = e.target.querySelector("button");
    btn.disabled = true;
    const r = await api("/accounts", { method: "POST", body: { name: f.get("name"), email: f.get("email") } });
    btn.disabled = false;
    if (r.status !== 201) return notice(message(r, "Could not create the account."), "bad");
    showNewKey(r.json.apiKey, r.json.account);
  });
  function showNewKey(k, acct) {
    $("acct-out").hidden = true; $("newkey").hidden = false;
    $("newkey-val").textContent = k;
    let saved = false;
    const guard = (ev) => { if (!saved) { ev.preventDefault(); ev.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    $("newkey-copy").onclick = () => navigator.clipboard?.writeText(k).then(() => notice("Key copied.", "good"));
    $("newkey-dl").onclick = () => {
      const blob = new Blob([JSON.stringify({ service: "BSVKey credits (Needs Custody pilot)", url: "https://needs.bsvkey.com/pilot/", accountId: acct.id, name: acct.name, email: acct.email, key: k }, null, 2)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: `needs-pilot-key-${acct.id}.json` }); a.click();
    };
    $("newkey-ok").onclick = () => { saved = true; window.removeEventListener("beforeunload", guard); key = k; store.set(k); $("newkey").hidden = true; load(); };
  }
  $("signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const k = String(new FormData(e.target).get("key") || "").trim();
    const r = await api("/account", { key: k });
    if (!r.ok) return notice("That key was not recognised.", "bad");
    key = k; store.set(k); load();
  });
  $("signout").addEventListener("click", (e) => { e.preventDefault(); store.set(null); location.href = "/pilot/"; });

  async function load() {
    if (!key) return;
    const r = await api("/account", { key });
    if (!r.ok) { store.set(null); key = null; return notice("Please sign in again.", "info"); }
    account = r.json.account;
    $("acct-out").hidden = true; $("acct-in").hidden = false; $("signout").hidden = false; $("sites").hidden = false;
    $("acct-name").textContent = account.name || account.email;
    $("acct-bal").textContent = money(account.balanceCents);
    await loadSites();
  }

  // ---- sites -----------------------------------------------------------------------------------
  $("site-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = await api("/needs/sites", { method: "POST", key, body: { plan: f.get("plan") || "test", name: f.get("name"), population: Number(f.get("population")), drought: { triggerMm: Number(f.get("triggerMm")), windowDays: Number(f.get("windowDays")), quorum: Number(f.get("quorum")) } } });
    if (r.status !== 201) return notice(message(r, "Could not create the site."), "bad");
    e.target.reset(); $("new-site").open = false;
    await loadSites();
  });

  async function loadSites() {
    const r = await api("/needs/sites", { key });
    if (!r.ok) return notice(message(r, "Could not load your sites."), "bad");
    price = r.json.priceCents || price;
    const list = $("site-list");
    list.replaceChildren(...(r.json.sites.length ? r.json.sites.map(siteCard) : [el("p", { class: "fine" }, "No pilot sites yet. Add one below.")]));
    if (!r.json.sites.length) $("new-site").open = true;
    return r.json.sites;
  }

  const daysLeft = (s) => Math.max(0, Math.ceil((s.until - Date.now()) / 86400000));
  function siteCard(s) {
    const card = el("article", { class: `card site ${s.status}` });
    const pub = `${location.origin}/pilot/site/#${s.id}`;
    card.append(el("div", { class: "site-head" }, el("h3", { text: s.name }), el("span", { class: `pill ${s.status}`, text: `${s.plan === "test" ? "Test pilot · " : ""}${s.status === "draft" ? "Not paid yet" : s.status === "active" ? `${daysLeft(s)} day${daysLeft(s) === 1 ? "" : "s"} left` : "Ended"}` })));
    card.append(el("p", { class: "fine" }, `${fmt(s.population)} people · drought trigger: under ${s.drought.triggerMm} mm in ${s.drought.windowDays} days, ${s.drought.quorum} sources agree`));

    if (s.status === "draft") {
      const cost = s.priceCents, canBalance = account.balanceCents >= cost;
      card.append(el("div", { class: "row" },
        el("button", { class: "btn", type: "button", onclick: () => payCard(s) }, `Pay ${money(cost)} by card`),
        el("button", { class: "btn ghost", type: "button", disabled: !canBalance, onclick: () => payBalance(s) }, `Pay from balance (${money(account.balanceCents)})`)));
      card.append(el("p", { class: "fine" }, "Paying in Bitcoin BSV: add credits on ", el("a", { href: "https://paywall.bsvkey.com/credits" }, "the credits page"), " with the same key, then come back and pay from your balance."));
      return card;
    }

    if (s.plan === "test") {
      // The server adds the $5 test credit before charging $250, so the balance needs only the upgrade price.
      const up = s.upgradeCents, counted = up < price;
      card.append(el("div", { class: "upgrade" },
        el("p", {}, el("strong", { text: "This is a test pilot. " }), `Upgrade to the full 90-day pilot for ${money(up)}${counted ? " (your $5 test counts toward the $250)" : ""}. You keep this site, its people and its receipts.`),
        el("div", { class: "row" },
          el("button", { class: "btn", type: "button", onclick: () => payCard(s) }, `Upgrade for ${money(up)} by card`),
          el("button", { class: "btn ghost", type: "button", disabled: account.balanceCents < up, onclick: () => upgradeBalance(s) }, `Upgrade from balance (${money(account.balanceCents)})`))));
    }
    card.append(el("div", { class: "stats" },
      stat("Receipts", `${fmt(s.recordCount)} of ${fmt(s.recordCap)}`),
      stat("People", String(s.members.filter((m) => !m.revokedAt).length)),
      stat("Days sealed", `${Object.keys(s.seals).length} of ${s.days.length}`)));
    card.append(el("div", { class: "row" },
      el("a", { class: "btn", href: pub }, "Open the live page"),
      el("button", { class: "btn ghost", type: "button", onclick: () => navigator.clipboard?.writeText(pub).then(() => notice("Live page link copied. Share it with donors and auditors.", "good")) }, "Copy link"),
      el("button", { class: "btn ghost", type: "button", onclick: () => exportSite(s) }, "Download all records"),
      el("button", { class: "btn ghost", type: "button", onclick: () => sealNow(s) }, "Seal finished days now")));

    if (s.status === "active") card.append(inviteForm(s));

    const people = s.members.map((m) => el("tr", {},
      el("td", { text: m.label }), el("td", { text: ROLES[m.role] || m.role }), el("td", { text: fmt(m.records) }),
      el("td", { text: m.revokedAt ? "Removed" : new Date(m.joinedAt).toLocaleDateString() }),
      el("td", {}, m.revokedAt ? "" : el("button", { class: "link", type: "button", onclick: () => removeMember(s, m) }, "Remove"))));
    const open = s.invites.filter((i) => !i.usedAt).map((i) => el("tr", {},
      el("td", { text: i.label }), el("td", { text: ROLES[i.role] || i.role }), el("td", { text: "Invite not used yet" }), el("td", { text: new Date(i.createdAt).toLocaleDateString() }),
      el("td", {}, el("button", { class: "link", type: "button", onclick: () => cancelInvite(s, i) }, "Cancel"))));
    if (people.length || open.length) {
      card.append(el("h4", { text: "People" }), el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Name", "Role", "Receipts", "Joined", ""].map((h) => el("th", { text: h })))),
        el("tbody", {}, people, open))));
    }
    return card;
  }
  const stat = (label, value) => el("div", { class: "stat" }, el("span", { text: label }), el("strong", { text: value }));

  const lastInvite = {}; // siteId -> the invite just made, so a list refresh keeps its QR on screen
  function inviteForm(s) {
    const out = el("div", { class: "invite-out" }, lastInvite[s.id] ? inviteCard(s, lastInvite[s.id]) : null);
    const sel = el("select", { name: "role" }, Object.entries(ROLES).map(([k, v]) => el("option", { value: k, text: v })));
    const label = el("input", { name: "label", maxlength: "60", placeholder: "Name on the card (optional)" });
    const form = el("form", { class: "invite-form" }, el("h4", { text: "Invite someone" }), el("div", { class: "row" }, sel, label, el("button", { class: "btn", type: "submit" }, "Make invite")), out);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await api(`/needs/sites/${s.id}/invites`, { method: "POST", key, body: { role: sel.value, label: label.value, base: location.origin } });
      if (r.status !== 201) return notice(message(r, "Could not make the invite."), "bad");
      label.value = "";
      lastInvite[s.id] = r.json;
      await loadSitesQuiet();
    });
    return form;
  }
  function inviteCard(s, inv) {
    const qr = el("div", { class: "qr" }); qr.innerHTML = inv.qrSvg; // SVG generated by our own API
    const card = el("div", { class: "invite-card" },
      qr,
      el("div", {}, el("p", { class: "eyebrow", text: s.name }), el("h4", { text: inv.invite.label }), el("p", { text: ROLES[inv.invite.role] }),
        el("p", { class: "fine" }, "Scan with the phone this person will use. The link works once."),
        el("div", { class: "row no-print" },
          el("button", { class: "btn ghost small-btn", type: "button", onclick: () => navigator.clipboard?.writeText(inv.link).then(() => notice("Invite link copied. Send it privately.", "good")) }, "Copy link"),
          el("button", { class: "btn ghost small-btn", type: "button", onclick: () => { card.classList.add("print-me"); document.body.classList.add("printing"); window.print(); document.body.classList.remove("printing"); card.classList.remove("print-me"); } }, "Print card"))));
    return card;
  }

  async function loadSitesQuiet() { try { await loadSites(); } catch { /* keep what is shown */ } }
  async function payCard(s) {
    const r = await api(`/needs/sites/${s.id}/checkout`, { method: "POST", key, body: { base: location.origin } });
    if (!r.ok) return notice(message(r, "Card payment is not available right now."), "bad");
    location.href = r.json.checkoutUrl;
  }
  async function payBalance(s) {
    if (!confirm(`Pay ${money(s.priceCents)} from your balance for "${s.name}"?`)) return;
    const r = await api(`/needs/sites/${s.id}/activate`, { method: "POST", key });
    if (!r.ok) return notice(message(r, "Could not pay from the balance."), "bad");
    notice("Paid. Your pilot is running for 90 days. Invite your people below.", "good");
    await load();
  }
  async function upgradeBalance(s) {
    if (!confirm(`Upgrade "${s.name}" to the full 90-day pilot for ${money(s.upgradeCents)} from your balance?`)) return;
    const r = await api(`/needs/sites/${s.id}/upgrade`, { method: "POST", key });
    if (!r.ok) return notice(message(r, "Could not upgrade from the balance."), "bad");
    notice("Upgraded. Your pilot now runs for 90 days with up to 10,000 receipts.", "good");
    await load();
  }
  async function removeMember(s, m) {
    if (!confirm(`Remove ${m.label}? Their phone will stop being able to add records. Records already sent stay.`)) return;
    const r = await api(`/needs/sites/${s.id}/members/${m.id}`, { method: "DELETE", key });
    if (!r.ok) return notice(message(r, "Could not remove them."), "bad");
    loadSitesQuiet();
  }
  async function cancelInvite(s, i) {
    const r = await api(`/needs/sites/${s.id}/invites/${i.id}`, { method: "DELETE", key });
    if (!r.ok) return notice(message(r, "Could not cancel the invite."), "bad");
    loadSitesQuiet();
  }
  async function sealNow(s) {
    const r = await api(`/needs/sites/${s.id}/seal`, { method: "POST", key });
    if (!r.ok) return notice(message(r, "Could not seal right now."), "bad");
    notice("Finished days are sealed. Today seals after midnight UTC.", "good");
    loadSitesQuiet();
  }
  async function exportSite(s) {
    const r = await fetch(`${NC.API}/needs/sites/${s.id}/export`, { headers: { "x-credits-key": key } });
    if (!r.ok) return notice("Could not download the records.", "bad");
    const a = el("a", { href: URL.createObjectURL(await r.blob()), download: `needs-pilot-${s.id}.json` }); a.click();
  }

  // ---- returning from card checkout --------------------------------------------------------------
  async function afterCheckout() {
    const q = new URLSearchParams(location.search);
    if (q.get("cancel")) notice("Payment cancelled. Nothing was charged.", "info");
    const paid = q.get("paid");
    if (!paid || !key) return;
    notice("Payment received. Switching your pilot on...", "info");
    for (let i = 0; i < 20; i++) {
      const sites = await loadSites();
      if (sites?.find((x) => x.id === paid)?.status === "active") { await load(); return notice("Your pilot is running for 90 days. Invite your people below.", "good"); }
      await new Promise((r) => setTimeout(r, 3000));
    }
    notice("Payment received; the pilot is still switching on. Reload in a minute.", "info");
  }

  load().then(afterCheckout);
})();
