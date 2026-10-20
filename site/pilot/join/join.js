// Join with a one-time invite: make a non-exportable key on this phone, register only the public
// key, keep the site settings (including the household salt) on the phone, then open the app.
"use strict";
(async () => {
  const $ = (id) => document.getElementById(id);
  const say = (title, msg) => { $("title").textContent = title; $("msg").textContent = msg; };
  const p = new URLSearchParams(location.hash.slice(1));
  const siteId = p.get("s"), token = p.get("t");
  history.replaceState(null, "", location.pathname); // keep the one-time token out of history and screenshots
  if (!siteId || !token) return say("This invite link is incomplete", "Ask the pilot owner for a new invite and scan it again.");
  if (!(await NC.ed25519Supported())) return say("This browser is too old", "Please update the phone's browser (Chrome, Safari, Firefox or Edge) and scan the invite again.");
  const ids = (await NC.kvGet("identities")) || {};
  const existing = Object.values(ids).find((x) => x.siteId === siteId);
  if (existing) { await NC.kvSet("current", existing.memberId); say("This phone is already set up", `You are recorded here as ${existing.label}.`); $("go").hidden = false; return; }
  try {
    const key = await NC.newKey();
    const r = await NC.api("/needs/join", { method: "POST", body: { siteId, token, pub: key.pub } });
    if (r.status !== 201) return say("This invite didn't work", NC.message(r, "Ask the pilot owner for a new invite."));
    const { member, site } = r.json;
    ids[member.id] = { memberId: member.id, siteId, role: member.role, label: member.label, key, site, seq: 0, prev: null, joinedAt: Date.now() };
    await NC.kvSet("identities", ids);
    await NC.kvSet("current", member.id);
    say(`Welcome, ${member.label}`, `This phone now records for ${site.name} as ${NC.ROLES[member.role]}. It works with no signal and sends when it can.`);
    $("go").hidden = false;
  } catch (e) {
    say("Something went wrong", `Please try again with a new invite. (${e.message})`);
  }
})();
