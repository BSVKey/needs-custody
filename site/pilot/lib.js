// Shared pieces for the pilot pages: the record format (canonical JSON, SHA-256 content id,
// Ed25519 signature over the id, exactly as the needs-custody repo and the server check it),
// in-browser keys that never leave the device, Merkle trees, a small IndexedDB store, and the
// API, which this site proxies at /api to the BSVKey credits service.
"use strict";
const NC = (() => {
  const API = "/api/credits";
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const unhex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
  const b64 = (buf) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const cat = (...p) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const sha = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof bytes === "string" ? enc.encode(bytes) : bytes));

  function sortDeep(v) {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]); return o; }
    return v;
  }
  const canonical = (v) => JSON.stringify(sortDeep(v));
  async function contentId(rec) {
    const c = {};
    for (const k of Object.keys(rec)) if (k !== "claimId" && k !== "sig" && k !== "signerPub") c[k] = rec[k];
    return "0x" + hex(await sha(canonical(c)));
  }

  // ---- keys and signatures ----------------------------------------------------------------------
  async function ed25519Supported() {
    try { await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "Ed25519" }, false, ["verify"]); return true; } catch { return false; }
  }
  async function newKey() {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]); // private key cannot be exported
    return { privateKey: kp.privateKey, pub: b64(await crypto.subtle.exportKey("spki", kp.publicKey)) };
  }
  async function sign(key, content) {
    const claimId = await contentId(content);
    const sig = b64(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, enc.encode(claimId)));
    return { ...content, claimId, sig, signerPub: key.pub };
  }
  const keyCache = new Map();
  async function verify(rec) {
    try {
      if ((await contentId(rec)) !== rec.claimId) return false;
      let k = keyCache.get(rec.signerPub);
      if (!k) { k = await crypto.subtle.importKey("spki", unb64(rec.signerPub), { name: "Ed25519" }, false, ["verify"]); keyCache.set(rec.signerPub, k); }
      return await crypto.subtle.verify({ name: "Ed25519" }, k, unb64(rec.sig), enc.encode(rec.claimId));
    } catch { return false; }
  }

  // ---- Merkle (leaf 0x00, node 0x01, odd layers duplicate the last node) -------------------------
  const leafHash = async (bytes) => hex(await sha(cat(new Uint8Array([0]), bytes)));
  const nodeHash = async (l, r) => hex(await sha(cat(new Uint8Array([1]), unhex(l), unhex(r))));
  async function buildTree(leaves) {
    const layers = [leaves.slice()];
    while (layers[layers.length - 1].length > 1) {
      const prev = layers[layers.length - 1], next = [];
      for (let i = 0; i < prev.length; i += 2) next.push(await nodeHash(prev[i], prev[i + 1] ?? prev[i]));
      layers.push(next);
    }
    return { root: layers[layers.length - 1][0], layers };
  }
  function proof(tree, index) {
    const out = []; let idx = index;
    for (let l = 0; l < tree.layers.length - 1; l++) {
      const layer = tree.layers[l], sib = idx % 2 ? idx - 1 : idx + 1;
      out.push(sib < layer.length ? layer[sib] : layer[idx]);
      idx = Math.floor(idx / 2);
    }
    return out;
  }
  async function verifyProof(leaf, branch, index, root) {
    let acc = leaf, idx = index;
    for (const s of branch) { acc = idx % 2 ? await nodeHash(s, acc) : await nodeHash(acc, s); idx = Math.floor(idx / 2); }
    return acc === root;
  }
  const entitlementLeaf = (e) => leafHash(enc.encode(canonical({ tag: e.tag, rationKg: e.rationKg })));
  const claimLeaf = (claimId) => leafHash(unhex(claimId.replace(/^0x/, "")));
  const householdTag = async (salt, card) => hex(await sha(`${salt}:${String(card).trim()}`));
  const anchorScript = (root) => { const tag = enc.encode("bsvkey-anchor/1"); return "006a" + tag.length.toString(16).padStart(2, "0") + hex(tag) + "20" + root; };

  // ---- IndexedDB: kv (identity, caches) and outbox (signed records not yet accepted) ---------------
  let _db;
  function db() {
    if (_db) return _db;
    _db = new Promise((resolve, reject) => {
      const r = indexedDB.open("needs-pilot", 2);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv"); if (d.objectStoreNames.contains("outbox")) d.deleteObjectStore("outbox"); d.createObjectStore("outbox", { keyPath: "claimId" }); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return _db;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s, (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }))).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  }
  const kvGet = (k) => tx("kv", "readonly", (s, w) => w(s.get(k)));
  const kvSet = (k, v) => tx("kv", "readwrite", (s) => { s.put(v, k); });
  const kvDel = (k) => tx("kv", "readwrite", (s) => { s.delete(k); });
  const outboxAll = () => tx("outbox", "readonly", (s, w) => w(s.getAll()));
  const outboxPut = (rec) => tx("outbox", "readwrite", (s) => { s.put(rec); });
  const outboxDel = (ids) => tx("outbox", "readwrite", (s) => { for (const id of ids) s.delete(id); });
  const outboxReplace = (drop, recs) => tx("outbox", "readwrite", (s) => { for (const id of drop) s.delete(id); for (const r of recs) s.put(r); });

  // ---- API -----------------------------------------------------------------------------------------
  async function api(path, { method = "GET", body, key } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers["x-credits-key"] = key;
    const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, ok: r.ok, json: json || {} };
  }
  const message = (r, fallback) => r.json?.message || (typeof r.json?.error === "string" ? r.json.error.replace(/_/g, " ") : null) || fallback;

  // ---- small DOM helpers ---------------------------------------------------------------------------
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
  const money = (cents) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const today = () => new Date().toISOString().slice(0, 10);

  const ROLES = {
    tester: "Water tester", driver: "Water truck driver", camp: "Camp water committee", kiosk: "Water kiosk",
    warehouse: "Food warehouse", carrier: "Food carrier", distribution: "Food distribution point", rain: "Rain gauge reader",
  };
  const KIND_ROLES = {
    "water-quality/1": ["tester"], "water-delivery/1": ["driver"], "water-received/1": ["camp"], "kiosk-sale/1": ["kiosk"],
    "aid-manifest/1": ["warehouse"], "aid-handoff/1": ["carrier", "distribution"], "aid-handout/1": ["distribution"], "rain-reading/1": ["rain"],
  };

  return {
    API, hex, unhex, sha, canonical, contentId, ed25519Supported, newKey, sign, verify,
    leafHash, buildTree, proof, verifyProof, entitlementLeaf, claimLeaf, householdTag, anchorScript,
    kvGet, kvSet, kvDel, outboxAll, outboxPut, outboxDel, outboxReplace,
    api, message, el, fmt, money, today, ROLES, KIND_ROLES,
  };
})();
