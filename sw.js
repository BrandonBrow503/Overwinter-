/* Overwinter service worker.
   >>> When you upload a new index.html, bump VERSION below so open apps show "New version available — Refresh". <<<
   - Precaches the app shell (relative paths so it works under /Overwinter-/ on GitHub Pages).
   - Pages: network-first (fresh when online, cached copy when offline). Other files: cache-first.
   - Reminders: Periodic Background Sync (installed app on Chrome Android) + a "check" message from the page.
     Shows at most one "due" notification per day per list, after the user's chosen reminder time:
     overwintering plants ("💧 N plants need attention") and houseplants ("🪴 Water your Pothos") are separate notifications. */
const VERSION = "2026-10-24.8";
const CACHE = "overwinter-" + VERSION;
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))));
  // no skipWaiting here: the page asks the user first ("New version available — Refresh")
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("overwinter-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "SKIP_WAITING") self.skipWaiting();
  if (d.type === "CHECK_DUE") e.waitUntil(checkDue(!!d.force).then(r => e.source && e.source.postMessage({ type: "CHECK_DUE_RESULT", ...r })));
  if (d.type === "VERSION" && e.source) e.source.postMessage({ type: "VERSION", version: VERSION });
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;              // Amazon etc. go straight to the network
  if (req.mode === "navigate") { e.respondWith(networkFirst(req)); return; }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    if (res.ok) cache.put("./index.html", res.clone());
    return res;
  } catch (_) {
    return (await cache.match("./index.html")) || (await cache.match("./")) || (await caches.match(req, { ignoreSearch: true })) ||
      new Response("<h1>Overwinter is offline</h1><p>Open it once while online to save it for offline use.</p>", { headers: { "Content-Type": "text/html" } });
  }
}

/* ---------- reminders ---------- */
self.addEventListener("periodicsync", e => { if (e.tag === "overwinter-due") e.waitUntil(checkDue(false)); });
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const url = (e.notification.data && e.notification.data.url) || "./";
    const house = url.includes("#houseplants");
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if ("focus" in c) { if (house) c.postMessage({ type: "SHOW_VIEW", view: "houseplants" }); return c.focus(); }
    return self.clients.openWindow(url);
  })());
});

// tiny key-value store shared with the page (IndexedDB "overwinter-sw", store "kv")
function kv(mode, fn) {
  return new Promise((res, rej) => {
    const q = indexedDB.open("overwinter-sw", 1);
    q.onupgradeneeded = () => q.result.createObjectStore("kv");
    q.onerror = () => rej(q.error);
    q.onsuccess = () => {
      const tx = q.result.transaction("kv", mode), st = tx.objectStore("kv"); let out;
      Promise.resolve(fn(st, v => (out = v))).catch(rej);
      tx.oncomplete = () => { q.result.close(); res(out); }; tx.onerror = () => rej(tx.error);
    };
  });
}
const kvGet = k => kv("readonly", (st, set) => { const r = st.get(k); r.onsuccess = () => set(r.result); });
const kvSet = (k, v) => kv("readwrite", st => { st.put(v, k); });
const pad = n => String(n).padStart(2, "0");
const localISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// same wording as houseNotice() in index.html
function houseNotice(list) {
  if (list.length === 1) return { title: `🪴 Water your ${list[0].name}`, body: `${list[0].emoji} ${list[0].name} is due for water — check the soil first.` };
  return { title: `🪴 ${list.length} houseplants need water`,
    body: list.slice(0, 6).map(p => `${p.emoji} Water your ${p.name}`).join("\n") + (list.length > 6 ? `\n…and ${list.length - 6} more` : "") };
}

async function checkDue(force) {
  const s = await kvGet("schedule");
  if (!s || !s.enabled) return { shown: false, reason: "off" };
  if (self.Notification && Notification.permission !== "granted") return { shown: false, reason: "permission" };
  const now = new Date(), today = localISO(now);
  const [hh, mm] = (s.time || "08:00").split(":").map(Number);
  if (!force && now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return { shown: false, reason: "early" };
  const out = { shown: false, count: 0, house: 0 };
  let already = 0;

  // 1) overwintering plants — unchanged behaviour
  if (!force && (await kvGet("lastNotified")) === today) already++;
  else {
    const due = (s.plants || []).map(p => {
      const w = !!p.water && p.water <= today, c = !!p.check && p.check <= today;
      return (w || c) ? `${p.emoji} ${p.name}: ${[w && "water", c && "check"].filter(Boolean).join(" + ")}` : null;
    }).filter(Boolean);
    if (due.length) {
      await self.registration.showNotification(`💧 ${due.length} plant${due.length > 1 ? "s need" : " needs"} attention`, {
        body: due.slice(0, 6).join("\n") + (due.length > 6 ? `\n…and ${due.length - 6} more` : ""),
        icon: "./icon-192.png", tag: "overwinter-due", data: { url: "./" }
      });
      await kvSet("lastNotified", today);
      out.shown = true; out.count = due.length;
    }
  }

  // 2) houseplants — their own notification, tag and once-a-day marker
  if (!force && (await kvGet("lastNotifiedHouse")) === today) already++;
  else {
    const hd = (s.houseplants || []).filter(p => !!p.water && p.water <= today);
    if (hd.length) {
      const n = houseNotice(hd);
      await self.registration.showNotification(n.title, {
        body: n.body, icon: "./icon-192.png", tag: "overwinter-house-due", data: { url: "./#houseplants" }
      });
      await kvSet("lastNotifiedHouse", today);
      out.shown = true; out.house = hd.length;
    }
  }
  if (!out.shown) out.reason = already ? "already" : "nothing-due";
  return out;
}
