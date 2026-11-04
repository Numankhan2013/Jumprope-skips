// Skip Count journal: saved sessions, insights, and Google sign-in + Firestore sync.
//
// The device copy (localStorage) is what the page reads. When you're signed in it is merged
// with the cloud on sign-in, when the page comes back into view, and when you go back online;
// each new save or delete is pushed about 1.5 s later. Newest updatedAt wins per session,
// and deletions leave a tombstone so they reach your other devices.
//
// Firestore (Firebase project "chasing-greatness", Spark free plan). Rules let only the
// signed-in owner read or write anything under users/{uid}:
//   users/{uid}/skips/{id}          one saved session
//   users/{uid}/skipmeta/state      { profile, profileAt, deleted: [{id, at}] }
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ pure helpers
  const DAY = 86400000;
  const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  const parseDay = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d); };
  const weekStart = k => { const d = parseDay(k); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return dayKey(d); }; // Monday

  // Merge two copies: union by id, newest updatedAt wins, tombstoned ones dropped.
  function merge(a, b, now = Date.now()) {
    const tomb = new Map();
    for (const t of [...(a.deleted || []), ...(b.deleted || [])]) if (t && t.id && (!tomb.has(t.id) || tomb.get(t.id) < t.at)) tomb.set(t.id, t.at);
    const byId = new Map();
    for (const s of [...(a.sessions || []), ...(b.sessions || [])]) {
      const cur = byId.get(s.id);
      if (!cur || (s.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(s.id, s);
    }
    const sessions = [...byId.values()].filter(s => !(tomb.has(s.id) && tomb.get(s.id) >= (s.updatedAt || 0)));
    const cutoff = now - 180 * DAY;
    const deleted = [...tomb].map(([id, at]) => ({ id, at })).filter(t => t.at > cutoff);
    return { sessions: sortSessions(sessions), deleted };
  }
  const sortSessions = list => list.slice().sort((x, y) => (y.date || "").localeCompare(x.date || "") || (y.createdAt || 0) - (x.createdAt || 0));

  // Numbers for the history card.
  function insights(sessions, today = dayKey(Date.now())) {
    const perDay = new Map();
    for (const s of sessions) perDay.set(s.date, (perDay.get(s.date) || 0) + (s.skips || 0));
    const sum = pred => sessions.filter(pred).reduce((a, s) => a + (s.skips || 0), 0);
    const ws = weekStart(today), lastWs = addDays(ws, -7), month = today.slice(0, 7);
    const lastWeekSameDay = addDays(today, -7);
    // streak: consecutive days with skips, ending today (or yesterday if today has none yet)
    let streak = 0, k = perDay.get(today) ? today : addDays(today, -1);
    while (perDay.get(k)) { streak++; k = addDays(k, -1); }
    let longest = 0, run = 0, prev = null;
    for (const d of [...perDay.keys()].filter(d => perDay.get(d) > 0).sort()) {
      run = prev && addDays(prev, 1) === d ? run + 1 : 1; longest = Math.max(longest, run); prev = d;
    }
    const bestSet = sessions.reduce((a, s) => Math.max(a, s.best || 0), 0);
    let bestDay = null; for (const [d, n] of perDay) if (!bestDay || n > bestDay.skips) bestDay = { date: d, skips: n };
    const paced = sessions.filter(s => s.jumpS > 0 && s.skips > 0);
    const pace = list => { const sk = list.reduce((a, s) => a + s.skips, 0), t = list.reduce((a, s) => a + s.jumpS, 0); return t ? 60 * sk / t : 0; };
    const recent = paced.slice(0, 5), earlier = paced.slice(5, 10); // sessions arrive newest first
    const last14 = []; for (let i = 13; i >= 0; i--) { const d = addDays(today, -i); last14.push({ date: d, skips: perDay.get(d) || 0 }); }
    return {
      today: perDay.get(today) || 0,
      week: sum(s => s.date >= ws && s.date <= today),
      lastWeekToDate: sum(s => s.date >= lastWs && s.date <= lastWeekSameDay),
      month: sum(s => s.date.slice(0, 7) === month),
      all: sum(() => true),
      kcalWeek: sessions.filter(s => s.date >= ws && s.date <= today).reduce((a, s) => a + (s.kcal || 0), 0),
      jumpWeekS: sessions.filter(s => s.date >= ws && s.date <= today).reduce((a, s) => a + (s.jumpS || 0), 0),
      sessions: sessions.length, activeDays: [...perDay.values()].filter(n => n > 0).length,
      streak, longest, bestSet, bestDay,
      paceRecent: pace(recent), paceEarlier: earlier.length ? pace(earlier) : 0,
      last14,
    };
  }

  const core = { merge, insights, dayKey, addDays, weekStart, sortSessions };
  if (typeof module !== "undefined" && module.exports) { module.exports = core; return; }
  root.SkipJournalCore = core;
  if (typeof document === "undefined") return;

  // ------------------------------------------------------------------ device storage
  const KEY = "skipcount.journal", PKEY = "skipcount.profileAt";
  const read = () => { try { const j = JSON.parse(localStorage.getItem(KEY)); return { sessions: j?.sessions || [], deleted: j?.deleted || [] }; } catch { return { sessions: [], deleted: [] }; } };
  let state = read();
  const write = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const profileAt = () => +(localStorage.getItem(PKEY) || 0);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const el = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nice = k => parseDay(k).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const int = n => Math.round(n).toLocaleString();
  const time = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };

  // ------------------------------------------------------------------ save offer
  let pending = null; // what the Save card would save
  function offer(p) {
    pending = { ...p, saved: false };
    el("saveDate").value = dayKey(p.when || Date.now());
    el("saveDate").max = dayKey(Date.now());
    el("saveNote").value = "";
    el("saveSummary").textContent = `${int(p.skips)} skips` + (p.sets?.length ? ` in ${p.sets.length} set${p.sets.length === 1 ? "" : "s"}` : "") + `, ${time(p.jumpS)} jumping`;
    el("saveBtn").disabled = false; el("saveBtn").textContent = "Save to history";
    el("saveCard").hidden = false;
  }
  function savePending() {
    if (!pending || pending.saved) return;
    const date = el("saveDate").value || dayKey(Date.now());
    const prof = root.profile ? root.profile() : { kg: 70, cm: 175, age: 30, sex: "male" };
    const c = root.SkipCore.calories(pending.skips, pending.jumpS, pending.restS, prof.kg, prof.cm, prof.age, prof.sex);
    const now = Date.now(), sets = (pending.sets || []).slice(0, 500);
    const s = {
      id: uid(), date, source: pending.source, skips: Math.round(pending.skips), sets,
      best: sets.length ? Math.max(...sets) : 0, jumpS: Math.round(pending.jumpS), restS: Math.round(pending.restS || 0),
      kcal: Math.round(c.total), note: el("saveNote").value.trim().slice(0, 140), createdAt: now, updatedAt: now,
    };
    state.sessions = sortSessions([s, ...state.sessions]); write();
    pending.saved = true;
    el("saveBtn").disabled = true; el("saveBtn").textContent = "Saved ✓";
    render(); cloud.schedule();
  }
  function removeSession(id) {
    const s = state.sessions.find(x => x.id === id); if (!s) return;
    if (!confirm(`Delete ${int(s.skips)} skips on ${nice(s.date)}?`)) return;
    state.sessions = state.sessions.filter(x => x.id !== id);
    state.deleted = [...state.deleted.filter(t => t.id !== id), { id, at: Date.now() }];
    write(); render(); cloud.schedule();
  }

  // ------------------------------------------------------------------ history card
  let showAll = false;
  function render() {
    const box = el("history"); if (!box) return;
    const list = state.sessions, has = list.length > 0;
    el("histEmpty").hidden = has; el("histBody").hidden = !has;
    if (!has) return;
    const ins = insights(list);
    el("hToday").textContent = int(ins.today);
    el("hWeek").textContent = int(ins.week);
    el("hMonth").textContent = int(ins.month);
    el("hAll").textContent = int(ins.all);
    el("hStreak").textContent = ins.streak;
    el("hStreakSub").textContent = `day streak · best ${ins.longest}`;
    el("hBestSet").textContent = int(ins.bestSet);
    el("hPace").textContent = ins.paceRecent ? Math.round(ins.paceRecent) : "–";

    const lines = [];
    if (ins.lastWeekToDate || ins.week) {
      const diff = ins.week - ins.lastWeekToDate;
      lines.push(ins.lastWeekToDate ? `This week: ${int(ins.week)} skips, ${diff >= 0 ? "up" : "down"} ${int(Math.abs(diff))} on the same point last week.` : `This week: ${int(ins.week)} skips so far.`);
    }
    if (ins.jumpWeekS) lines.push(`${time(ins.jumpWeekS)} of actual jumping and about ${int(ins.kcalWeek)} kcal this week.`);
    if (ins.paceRecent && ins.paceEarlier) {
      const d = Math.round(ins.paceRecent - ins.paceEarlier);
      lines.push(d === 0 ? `Pace is steady at ${Math.round(ins.paceRecent)} skips/min.` : `Pace over your last 5 sessions is ${Math.abs(d)} skips/min ${d > 0 ? "faster" : "slower"} than the 5 before.`);
    }
    if (ins.bestDay) lines.push(`Biggest day: ${int(ins.bestDay.skips)} skips on ${nice(ins.bestDay.date)}.`);
    lines.push(`${ins.sessions} session${ins.sessions === 1 ? "" : "s"} over ${ins.activeDays} day${ins.activeDays === 1 ? "" : "s"}.`);
    el("hLines").innerHTML = lines.map(l => `<li>${esc(l)}</li>`).join("");

    const max = Math.max(1, ...ins.last14.map(d => d.skips));
    el("hBars").innerHTML = ins.last14.map(d => {
      const h = d.skips ? Math.max(4, Math.round(100 * d.skips / max)) : 0;
      const lbl = parseDay(d.date).toLocaleDateString(undefined, { weekday: "narrow" });
      return `<div class="bar" title="${esc(nice(d.date))}: ${int(d.skips)} skips"><i style="height:${h}%"></i><span>${esc(lbl)}</span></div>`;
    }).join("");

    const shown = showAll ? list : list.slice(0, 8);
    el("hList").innerHTML = shown.map(s => `<li><div><b>${int(s.skips)}</b> skips <span class="hint">· ${esc(nice(s.date))}</span>` +
      `<div class="note">${s.sets?.length ? `${s.sets.length} sets · best ${int(s.best)} · ` : ""}${time(s.jumpS)} jumping · ${s.jumpS ? Math.round(60 * s.skips / s.jumpS) : "–"}/min · ${int(s.kcal)} kcal${s.source === "manual" ? " · typed in" : ""}${s.note ? ` · ${esc(s.note)}` : ""}</div></div>` +
      `<button type="button" class="del" data-del="${esc(s.id)}" aria-label="Delete this session">×</button></li>`).join("");
    el("hMore").hidden = list.length <= 8;
    el("hMore").textContent = showAll ? "Show fewer" : `Show all ${list.length}`;
  }

  // ------------------------------------------------------------------ cloud
  const cfg = {
    apiKey: "AIzaSyAyilwCmhdBhnvtv7gA1yWuYujzWRWFIrI",
    authDomain: "chasing-greatness.firebaseapp.com",
    projectId: "chasing-greatness",
    storageBucket: "chasing-greatness.firebasestorage.app",
    messagingSenderId: "403315725957",
    appId: "1:403315725957:web:8c6943fa84ecb6b6defbec",
  };
  const cloud = (() => {
    let auth = null, db = null, user = null, busy = false, again = false, timer = 0, lastPull = 0, status = "off", err = "";
    const pushed = new Map(); let pushedMeta = "";
    const strip = o => JSON.parse(JSON.stringify(o));
    const ref = () => db.collection("users").doc(user.uid);
    const metaDoc = () => ref().collection("skipmeta").doc("state");
    const localProfile = () => { try { return JSON.parse(localStorage.getItem("skipcount.profile") || "null"); } catch { return null; } };
    const metaNow = () => ({ profile: localProfile(), profileAt: profileAt(), deleted: state.deleted });

    async function commit(ops) {
      for (let i = 0; i < ops.length; i += 400) { const b = db.batch(); ops.slice(i, i + 400).forEach(op => op(b)); await b.commit(); }
    }
    async function pull() {
      const [ms, ss] = await Promise.all([metaDoc().get(), ref().collection("skips").get()]);
      const rm = ms.exists ? ms.data() : null, remote = new Map(); ss.forEach(d => remote.set(d.id, d.data()));
      state = merge({ sessions: [...remote.values()], deleted: rm?.deleted || [] }, state); write();
      // profile: whichever side was edited last
      if (rm?.profile && (rm.profileAt || 0) > profileAt()) {
        try { localStorage.setItem("skipcount.profile", JSON.stringify(rm.profile)); localStorage.setItem(PKEY, String(rm.profileAt)); } catch {}
        root.loadProfile?.(); const cs = typeof calSource !== "undefined" ? calSource : null; if (cs) root.renderCalories?.(cs.skips, cs.jumpS, cs.restS);
      }
      const ops = [], col = ref().collection("skips"); pushed.clear();
      for (const s of state.sessions) { const r = remote.get(s.id); if (!r || (r.updatedAt || 0) < (s.updatedAt || 0)) ops.push(b => b.set(col.doc(s.id), strip(s))); pushed.set(s.id, s.updatedAt || 0); }
      const keep = new Set(state.sessions.map(s => s.id));
      for (const id of remote.keys()) if (!keep.has(id)) ops.push(b => b.delete(col.doc(id)));
      const mj = JSON.stringify(metaNow());
      if (!rm || JSON.stringify({ profile: rm.profile ?? null, profileAt: rm.profileAt || 0, deleted: rm.deleted || [] }) !== mj) ops.push(b => b.set(metaDoc(), strip(metaNow())));
      await commit(ops); pushedMeta = mj; lastPull = Date.now();
    }
    async function push() {
      const ops = [], col = ref().collection("skips"), live = new Set();
      for (const s of state.sessions) { live.add(s.id); if (pushed.get(s.id) !== (s.updatedAt || 0)) ops.push(b => b.set(col.doc(s.id), strip(s))); }
      for (const id of [...pushed.keys()]) if (!live.has(id)) ops.push(b => b.delete(col.doc(id)));
      const mj = JSON.stringify(metaNow()); if (mj !== pushedMeta) ops.push(b => b.set(metaDoc(), strip(metaNow())));
      if (!ops.length) return;
      await commit(ops); pushed.clear(); for (const s of state.sessions) pushed.set(s.id, s.updatedAt || 0); pushedMeta = mj;
    }
    async function run(full) {
      if (!user || !db) return;
      if (busy) { again = true; return; }
      busy = true; set("syncing");
      try { full || !lastPull ? await pull() : await push(); set("synced"); render(); }
      catch (e) { console.warn("Cloud sync failed", e); set(navigator.onLine ? "error" : "offline", e?.message || String(e)); }
      finally { busy = false; if (again) { again = false; setTimeout(() => run(false), 300); } }
    }
    function set(s, e = "") { status = s; err = e; paint(); }
    function paint() {
      const t = el("cloudText"); if (!t) return;
      const msg = {
        off: "Loading…", unconfigured: "Cloud sync isn't available in this browser.",
        "signed-out": "Sign in with Google to back up your sessions and see them on every device. Free, and only you can read your data.",
        syncing: `Signed in as ${user?.email || ""}. Syncing…`,
        synced: `Signed in as ${user?.email || ""}. Backed up${state.sessions.length ? ` · ${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}` : ""}.`,
        offline: `Signed in as ${user?.email || ""}. Offline: saved on this phone, will sync when you're back online.`,
        error: `Signed in as ${user?.email || ""}. Sync hit a problem: ${err}`,
      }[status] || "";
      t.textContent = msg;
      el("cloudIn").hidden = !!user || status === "unconfigured" || status === "off";
      el("cloudOut").hidden = !user; el("cloudSync").hidden = !user;
    }
    async function signIn() {
      if (!auth) return;
      const p = new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
      try { await auth.signInWithPopup(p); }
      catch (e) {
        if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code)) await auth.signInWithRedirect(p);
        else if (e.code !== "auth/popup-closed-by-user") { set("signed-out"); alert(`Sign-in failed: ${e.message}`); }
      }
    }
    async function signOut() { if (!auth) return; await run(false); await auth.signOut(); }
    function schedule() { if (!user) return; clearTimeout(timer); timer = setTimeout(() => run(false), 1500); }
    function init() {
      if (!root.firebase) { set("unconfigured"); return; }
      try { firebase.initializeApp(cfg, "skipcount"); const app = firebase.app("skipcount"); auth = app.auth(); db = app.firestore(); }
      catch (e) { set("error", e.message); return; }
      auth.getRedirectResult().catch(e => alert(`Sign-in failed: ${e.message}`));
      auth.onAuthStateChanged(u => {
        user = u ? { uid: u.uid, email: u.email || "" } : null; pushed.clear(); pushedMeta = ""; lastPull = 0;
        if (u) run(true); else set("signed-out");
      });
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && user && Date.now() - lastPull > 5 * 60000) run(true); });
      addEventListener("online", () => { if (user) run(true); });
    }
    return { init, signIn, signOut, schedule, syncNow: () => run(true), paint };
  })();

  // Called by saveProfile(): remember when the profile was edited, so the newest one wins.
  function touchProfile() { try { localStorage.setItem(PKEY, String(Date.now())); } catch {} cloud.schedule(); }

  // ------------------------------------------------------------------ wire up
  el("saveBtn").addEventListener("click", savePending);
  el("hList").addEventListener("click", e => { const id = e.target.closest("[data-del]")?.dataset.del; if (id) removeSession(id); });
  el("hMore").addEventListener("click", () => { showAll = !showAll; render(); });
  el("cloudIn").addEventListener("click", () => cloud.signIn());
  el("cloudOut").addEventListener("click", () => cloud.signOut());
  el("cloudSync").addEventListener("click", () => cloud.syncNow());
  addEventListener("storage", e => { if (e.key === KEY) { state = read(); render(); } });
  render(); cloud.init(); cloud.paint();
  root.SkipJournal = { offer, touchProfile, render };
})(typeof window !== "undefined" ? window : globalThis);
