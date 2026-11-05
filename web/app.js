// Skip Count — the app: Count tab (video / live camera → result + calories)
// and Insights tab (sessions saved on this device → totals, charts, heatmap).
"use strict";
const $ = id => document.getElementById(id);
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const haptic = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} }; // number or pattern
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};

// ================================================================ formatting
const fmtTime = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`; };
const fmtInt = n => Math.round(n).toLocaleString();
const fmtKcal = n => n < 20 ? (Math.round(n * 10) / 10).toLocaleString() : fmtInt(n); // short clips: a decimal
const fmtMin = s => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round(s % 3600 / 60)}m` : s < 60 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;
const fmtCompact = n => n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : fmtInt(n);
const pad2 = n => String(n).padStart(2, "0");
const dayKey = d => { d = new Date(d); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const startOfDay = d => { d = new Date(d); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => { d = new Date(d); d.setDate(d.getDate() + n); return d; };
const mondayOf = d => { d = startOfDay(d); return addDays(d, -((d.getDay() + 6) % 7)); };
const DOW = ["M", "T", "W", "T", "F", "S", "S"];
const escapeHtml = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d, opts) => new Date(d).toLocaleDateString(undefined, opts);

// ================================================================ profile & calories
const profileIds = ["weight", "weightUnit", "heightCm", "heightUnit", "heightFt", "heightIn", "age"];
function showHeightUnit(u) { $("heightUnit").value = u; $("heightUnit2").value = u; $("heightCmWrap").hidden = u !== "cm"; $("heightFtWrap").hidden = u === "cm"; }
function loadProfile() {
  const p = store.get("skipcount.profile", null);
  $("dailyGoal").value = dailyGoal();
  if (!p) return;
  for (const id of profileIds) if (p[id] != null) $(id).value = p[id];
  if (p.sex) $(p.sex === "female" ? "sexF" : "sexM").checked = true;
  showHeightUnit(p.heightUnit || "cm");
}
function saveProfile() { const old = prof(), p = { goal: old.goal, goalByDay: old.goalByDay }; for (const id of profileIds) p[id] = $(id).value; p.sex = document.querySelector('input[name="sex"]:checked').value; store.set("skipcount.profile", p); window.SkipJournal?.touchProfile(); }
function profile() {
  let kg = parseFloat($("weight").value) || 70;
  if ($("weightUnit").value === "lb") kg *= 0.45359237;
  const cm = $("heightUnit").value === "cm" ? (parseFloat($("heightCm").value) || 175)
    : (parseFloat($("heightFt").value) || 0) * 30.48 + (parseFloat($("heightIn").value) || 0) * 2.54;
  return { kg, cm: cm || 175, age: parseFloat($("age").value) || 30, sex: document.querySelector('input[name="sex"]:checked').value };
}
const kcalFor = (skips, jumpS, restS) => { const p = profile(); return SkipCore.calories(skips, jumpS, restS, p.kg, p.cm, p.age, p.sex); };

let calSource = null; // { skips, jumpS, restS }
function profileText() {
  const p = profile();
  const w = $("weightUnit").value === "lb" ? `${Math.round(p.kg / 0.45359237)} lb` : `${Math.round(p.kg * 10) / 10} kg`;
  const h = $("heightUnit").value === "cm" ? `${Math.round(p.cm)} cm` : `${$("heightFt").value}′${$("heightIn").value}″`;
  return `${w} · ${h} · ${p.age} · ${p.sex}`;
}
function renderBased() { $("basedOn").textContent = profileText(); }
function renderCalories(skips, jumpS, restS) {
  calSource = { skips, jumpS, restS };
  const c = kcalFor(skips, jumpS, restS);
  $("kTotal").textContent = fmtKcal(c.total);
  $("kRange").textContent = `Likely range ${fmtKcal(c.low)}–${fmtKcal(c.high)} kcal`;
  $("kJump").textContent = `${fmtKcal(c.jumping)} kcal`;
  $("kRest").textContent = `${fmtKcal(c.rest)} kcal`;
  $("kNet").textContent = `${fmtKcal(c.net)} kcal`;
  $("kMet").textContent = `${c.met.toFixed(1)} MET`;
  $("kRmr").textContent = `${fmtInt(c.rmr)} kcal/day`;
  return c;
}

// ================================================================ sessions (saved on this device)
// Storage and Google/Firestore sync live in journal.js; this keeps a time-sorted copy.
const timeOf = x => x.at || (() => { const [y, m, d] = x.date.split("-").map(Number), c = new Date(x.createdAt || 0); return +new Date(y, m - 1, d, c.getHours(), c.getMinutes()); })();
let sessions = [];
function syncFromJournal() { sessions = SkipJournal.list().map(x => ({ ...x, at: timeOf(x) })).sort((a, b) => a.at - b.at); }
SkipJournal.onChange(() => { syncFromJournal(); refreshAll(); });
syncFromJournal();
function addSession(s) { return SkipJournal.add(s); }
function removeSession(id) { return SkipJournal.remove(id); }
function updateSession(id, patch) { return SkipJournal.update(id, patch); }
function sessionFromResult(r, at, source) {
  const c = kcalFor(r.skips, r.jumpingSeconds, r.restSeconds);
  return { at: +at, source, skips: r.skips, jumpS: r.jumpingSeconds, restS: r.restSeconds, sets: r.sets.map(s => s.skips), kcal: c.total };
}

// ================================================================ toast
let toastTimer = 0, toastUndo = null;
function toast(text, undo) {
  $("toastText").textContent = text; toastUndo = undo || null; $("toastAction").hidden = !undo;
  $("toast").classList.add("show"); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), undo ? 6000 : 3500);
}
$("toastAction").onclick = () => { const u = toastUndo; toastUndo = null; $("toast").classList.remove("show"); u && u(); };

// ================================================================ results view
let last = null, currentId = null;
function animateNumber(el, to, fmt = fmtInt) {
  if (reduceMotion() || to < 5) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 900;
  const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(to * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function renderResult(r, opts = {}) {
  const { example = false, animate = false, sessionId = null, at = null, via = null } = opts;
  last = r; currentId = sessionId;
  $("exampleTag").hidden = !example; $("resultLabel").hidden = !opts.lastLabel;
  $("chart").hidden = !r.filtered; document.querySelector("#results .legend").hidden = !r.filtered;
  animate ? animateNumber($("skips"), r.skips) : ($("skips").textContent = fmtInt(r.skips));
  $("sJump").textContent = fmtTime(r.jumpingSeconds);
  $("sRest").textContent = fmtTime(r.restSeconds);
  $("sPace").textContent = r.jumpingSeconds ? Math.round(60 * r.skips / r.jumpingSeconds) : "–";
  $("sSets").textContent = r.sets.length;
  $("sBest").textContent = r.sets.length ? Math.max(...r.sets.map(s => s.skips)) : 0;
  $("sLen").textContent = fmtTime(r.totalSeconds); $("sLen").nextElementSibling.textContent = r.source === "pocket" ? "session" : "length";
  $("savedRow").hidden = !sessionId;
  if (sessionId && at) $("sessDate").value = dayKey(at);
  $("warnSmall").hidden = !(r.bodySize < 0.5);
  $("warnSlow").hidden = via !== "playback";
  const box = $("sets"); box.textContent = "";
  r.sets.forEach((s, i) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = s.skips;
    b.setAttribute("aria-pressed", "false"); b.title = `Set ${i + 1}: ${s.skips} skips at ${fmtTime(s.start)}`;
    b.onclick = () => {
      const on = b.getAttribute("aria-pressed") !== "true"; haptic();
      box.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", String(on));
      drawChart(on ? [Math.max(0, s.start - 1.5), s.end + 1.5] : null);
      if (on && !$("playerCard").hidden) $("player").currentTime = Math.max(0, s.start - 0.5);
    };
    box.appendChild(b);
  });
  drawChart(null);
  renderCalories(r.skips, r.jumpingSeconds, r.restSeconds);
}

const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function drawChart(range) {
  const r = last, cv = $("chart"); if (!r || !r.filtered || !cv.clientWidth) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const fps = r.fps, x = r.filtered, n = x.length, off = r.offset || 0;
  const sets = r.sets.map(s => ({ start: s.start - off, end: s.end - off })), times = r.skipTimes.map(t => t - off);
  const [t0, t1] = range ? [range[0] - off, range[1] - off] : [0, n / fps];
  const i0 = Math.max(0, Math.floor(t0 * fps)), i1 = Math.min(n, Math.ceil(t1 * fps));
  let amp = 1e-9; // scale to the bounces inside sets, so camera handling doesn't squash them
  for (const st of sets) for (let i = Math.max(i0, Math.floor(st.start * fps)); i < Math.min(i1, Math.ceil(st.end * fps)); i++) amp = Math.max(amp, Math.abs(x[i]));
  if (amp === 1e-9) for (let i = i0; i < i1; i++) amp = Math.max(amp, Math.abs(x[i]));
  const inSet = i => sets.some(st => i / fps >= st.start && i / fps <= st.end);
  const X = t => (t - t0) / (t1 - t0) * w, Y = v => h / 2 - v / amp * (h / 2 - 14);
  const clampY = v => Y(Math.max(-amp * 1.15, Math.min(amp * 1.15, v)));
  g.fillStyle = cssVar("--rope-soft");
  for (const s of sets) if (s.end > t0 && s.start < t1) g.fillRect(X(s.start), 0, Math.max(1, X(s.end) - X(s.start)), h);
  const step = Math.max(1, Math.floor((i1 - i0) / (w * 2)));
  g.strokeStyle = cssVar("--track"); g.lineWidth = 1.2;
  for (const pass of [false, true]) { // faded outside sets, solid inside
    g.globalAlpha = pass ? 1 : 0.3; g.beginPath(); let pen = false;
    for (let i = i0; i < i1; i += step) {
      if (inSet(i) !== pass) { pen = false; continue; }
      let v = x[i];
      if (step > 1) { let mn = v, mx = v; for (let k = i; k < Math.min(i + step, i1); k++) { mn = Math.min(mn, x[k]); mx = Math.max(mx, x[k]); } pen ? g.lineTo(X(i / fps), clampY(mx)) : g.moveTo(X(i / fps), clampY(mx)); pen = true; v = mn; }
      pen ? g.lineTo(X(i / fps), clampY(v)) : g.moveTo(X(i / fps), clampY(v)); pen = true;
    }
    g.stroke();
  }
  g.globalAlpha = 1; g.fillStyle = cssVar("--rope");
  for (const t of times) {
    if (t < t0 || t > t1) continue;
    if (range) { const v = x[Math.min(n - 1, Math.round(t * fps))]; g.beginPath(); g.arc(X(t), clampY(v), 3.5, 0, 7); g.fill(); }
    else g.fillRect(X(t) - 0.75, 3, 1.5, 9); // overview: one tick per skip along the top
  }
}

// live counter over the "check the count" player
(function overlayLoop() {
  const v = $("player"), o = $("overlay");
  const tick = () => {
    if (last && !$("playerCard").hidden) {
      const t = v.currentTime, ts = last.skipTimes;
      let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m + 1; else hi = m; }
      o.textContent = lo; o.classList.toggle("flash", lo > 0 && t - ts[lo - 1] < 0.12);
    }
    "requestVideoFrameCallback" in v && !v.paused ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  };
  tick();
})();

// ================================================================ hero states
function heroState(state) { // idle | progress | live
  $("sessionCard").hidden = state === "idle";
  $("modes").hidden = state !== "idle"; $("tips").hidden = state !== "idle";
  $("progressBox").hidden = state !== "progress"; $("liveBox").hidden = state !== "live";
  if (state !== "idle") $("sessionCard").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
}
function setProgress(frac, text) {
  $("progressPct").textContent = `${Math.round(frac * 100)}%`;
  $("progressBar").firstElementChild.style.width = `${(Math.min(1, frac) * 100).toFixed(1)}%`;
  $("progressBar").setAttribute("aria-valuenow", Math.round(frac * 100));
  if (text) $("progressText").textContent = text;
}
function showError(msg) { $("error").textContent = msg; $("error").hidden = false; }
const wakeLock = () => SkipEngine.keepAwake(); // re-acquired whenever the screen comes back on

function saveResult(r, at, source, via) {
  const s = addSession(sessionFromResult(r, at, source)); haptic(20);
  renderResult(r, { animate: true, sessionId: s.id, at, via });
  toast(`Saved ${fmtInt(r.skips)} skips to Insights`, () => { removeSession(s.id); $("savedRow").hidden = true; currentId = null; toast("Removed from Insights"); });
}

// ================================================================ analyse a video
let videoUrl = null;
async function analyseFile(file) {
  $("error").hidden = true; heroState("progress"); setProgress(0, "Opening video…");
  const lock = wakeLock();
  let resumedAt = null;
  try {
    const out = await SkipEngine.analyse(file, {
      onResume: f => { resumedAt = f; toast(`Picking up where it stopped (${Math.round(f * 100)}%)`); },
      onProgress: (f, eta) => setProgress(f, (resumedAt != null ? "Resumed · " : "") + (f < 0.02 ? "Reading video…" : `Counting… ${eta != null ? `about ${fmtTime(Math.max(0, eta))} left` : ""}`))
    });
    window.__skipDebug = { via: out.via, frames: out.frames, seconds: out.seconds, restarts: out.restarts, resumedAt, skipTimes: out.result.skipTimes, bodySize: out.result.bodySize };
    heroState("idle");
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(file); $("player").src = videoUrl; $("playerCard").hidden = false;
    const r = out.result;
    $("speedNote").hidden = false;
    $("speedNote").textContent = `Analysed ${fmtTime(r.totalSeconds)} of video in ${fmtTime(out.seconds)}.`;
    if (r.skips > 0) saveResult(r, out.recordedAt, "video", out.via);
    else { renderResult(r, { via: out.via }); toast("No skips found in this video"); }
    $("results").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  } catch (e) {
    console.error(e); heroState("idle");
    showError(`Couldn't analyse this video: ${e.message || e}. Try a video recorded with your phone's normal camera app.`);
  } finally { $("file").value = ""; lock.release(); }
}

// ================================================================ live counting
let live = null;
async function startLive() {
  $("error").hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) { showError("This browser can't use the camera here. Record a video and choose it instead."); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } }); }
  catch (e) { showError("Camera access was blocked. Allow the camera for this site, or record a video and choose it instead."); return; }
  heroState("live");
  const v = $("liveVideo"); v.srcObject = stream; v.style.transform = "scaleX(-1)"; // mirror like a selfie
  try { await v.play(); } catch {}
  const pool = await SkipEngine.Pool.create();
  const track = stream.getVideoTracks()[0];
  live = { stream, pool, stop: false, started: performance.now(), lock: wakeLock(), dropped: 0 };
  // the camera stops when the screen goes off: finish and save what was counted rather than lose it
  live.onHide = () => { if (document.visibilityState === "hidden" && live && !live.stop) stopLive(); };
  document.addEventListener("visibilitychange", live.onHide);
  $("liveCount").textContent = "0"; $("liveTime").textContent = "0:00";
  const st = track.getSettings();
  const srcW = st.width || v.videoWidth || 1280, srcH = st.height || v.videoHeight || 720;
  if ("MediaStreamTrackProcessor" in window) {
    pool.setGeometry(srcW, srcH, 0);
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    live.reader = reader;
    (async () => {
      while (!live.stop) {
        const { value: frame, done } = await reader.read(); if (done || !frame) break;
        if (live.stop || pool.inFlight > pool.size * 4) { frame.close(); live.dropped++; continue; } // falling behind: skip a frame
        pool.pushFrame(frame, frame.timestamp / 1e6);
      }
    })();
  } else {
    await new Promise(r => v.videoWidth ? r() : (v.onloadedmetadata = r));
    pool.setGeometry(v.videoWidth, v.videoHeight, 0);
    const step = (now, meta) => {
      if (live.stop) return;
      if (pool.inFlight <= pool.size * 4) pool.pushGray(pool.shrinker.element(v), meta ? meta.mediaTime : v.currentTime); else live.dropped++;
      "requestVideoFrameCallback" in v ? v.requestVideoFrameCallback(step) : requestAnimationFrame(() => step());
    };
    "requestVideoFrameCallback" in v ? v.requestVideoFrameCallback(step) : requestAnimationFrame(() => step());
  }
  live.timer = setInterval(() => {
    $("liveTime").textContent = fmtTime((performance.now() - live.started) / 1000);
    if (pool.tracker && pool.tracker.ts.length > 90) {
      try { const r = SkipEngine.countFrom(pool.tracker); $("liveCount").textContent = fmtInt(r.skips); } catch {}
    }
  }, 1500);
}
async function stopLive() {
  if (!live) return;
  const L = live; L.stop = true; clearInterval(L.timer); document.removeEventListener("visibilitychange", L.onHide);
  try { await L.reader?.cancel(); } catch {}
  L.stream.getTracks().forEach(t => t.stop()); $("liveVideo").srcObject = null;
  heroState("progress"); setProgress(1, "Working out the final count…");
  try {
    const tracker = await L.pool.finish();
    if (!tracker || tracker.ts.length < 60) throw new Error("That was too short to count.");
    const r = SkipEngine.countFrom(tracker);
    window.__skipDebug = { via: "live", frames: tracker.ts.length, dropped: L.dropped, skipTimes: r.skipTimes };
    heroState("idle"); $("playerCard").hidden = true; $("speedNote").hidden = true;
    if (r.skips > 0) saveResult(r, new Date(), "live", "live");
    else { renderResult(r); toast("No skips found"); }
    $("results").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  } catch (e) { heroState("idle"); showError(e.message || String(e)); }
  finally { L.lock.release(); live = null; }
}

// ================================================================ pocket mode (motion sensor)
// Phone in a pocket / waistband / armband: count landings from the accelerometer.
// Nothing is recorded; the count is live and final as soon as you stop.
let pk = null;
const PK_KEY = "pocket-current";
const pkSay = text => { try { if ($("sayHundreds").checked && "speechSynthesis" in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } } catch {} };
function pocketState(st) {
  $("pocket").dataset.state = st;
  $("pocketState").textContent = { ready: "Ready", counting: "Counting", paused: "Paused" }[st];
  $("pocketLabel").textContent = st === "ready" ? "skips so far today" : "skips this session";
  $("pocketHint").textContent = st === "ready" ? "Press Start, then put the phone in a pocket, armband or thigh strap, any way round, without locking it. The screen stays on and black; if it turns off, nothing is counted."
    : st === "counting" ? "Don't lock the phone. The bar above should jump with every skip. To pause, press and hold the button."
    : "Paused. Nothing is being counted.";
}
function pocketGoalPaint() {
  const before = pk ? pk.todayBefore : todaySkips(), now = before + (pk ? pk.count : 0), g = goal();
  $("pocketToday").textContent = fmtInt(now); $("pocketGoalNum").textContent = fmtInt(g);
  $("pocketGoalFill").style.width = `${Math.min(100, now / g * 100)}%`;
  if (pk && !pk.goalHit && now >= g && pk.count > 0) { pk.goalHit = true; haptic([60, 60, 120]); pkSay(`Goal reached. ${now} skips today.`); }
}
// 1) open: ready screen, nothing counts yet
async function openPocket() {
  $("error").hidden = true;
  if (!("DeviceMotionEvent" in window)) { showError("This browser doesn't give websites motion-sensor data. Try Safari on iPhone or Chrome on Android."); return; }
  pk = null; $("pocketCount").textContent = fmtInt(todaySkips()); $("pocketTime").textContent = "0:00";
  pocketState("ready"); pocketGoalPaint();
  $("pocket").hidden = false; haptic();
}
// 2) start (must be a tap: iPhone asks for motion access here)
async function startPocket() {
  try {
    if (typeof DeviceMotionEvent.requestPermission === "function" && await DeviceMotionEvent.requestPermission() !== "granted") {
      closePocketScreen(); showError("Motion access was not allowed. On iPhone: Settings › Apps › Safari › Motion & Orientation Access, then try again."); return;
    }
  } catch { closePocketScreen(); showError("Motion access was not allowed. Reload the page and tap Pocket again."); return; }
  if ($("sayHundreds").checked && "speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance("")); // unlock speech on iPhone
  pk = { t: [], x: [], y: [], z: [], started: Date.now(), lock: wakeLock(), lastSaid: 0, count: 0, gotData: false, todayBefore: todaySkips(),
    shift: 0, activeMs: 0, runFrom: performance.now(), paused: false, goalHit: todaySkips() >= goal(),
    hiddenMs: 0, hiddenAt: null, hides: 0, noGravity: 0, level: 0, peak: 0 };
  pk.onMotion = e => {
    if (pk.paused) return;
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null) { pk.noGravity++; return; }
    const m = Math.hypot(g.x, g.y, g.z);
    pk.gotData = true; pk.t.push(e.timeStamp / 1000 - pk.shift); pk.x.push(g.x); pk.y.push(g.y); pk.z.push(g.z);
    const dev = Math.abs(m - 9.81); pk.level = Math.max(dev, pk.level * 0.9); pk.peak = Math.max(pk.peak, dev); // for the motion meter
  };
  addEventListener("devicemotion", pk.onMotion);
  // the browser stops all motion data while the screen is off: remember for how long
  pk.onVis = () => {
    if (!pk) return;
    if (document.visibilityState === "hidden") { if (pk.hiddenAt == null) { pk.hiddenAt = performance.now(); pk.hides++; } }
    else if (pk.hiddenAt != null) {
      const ms = performance.now() - pk.hiddenAt; pk.hiddenMs += ms; pk.hiddenAt = null;
      if (ms > 3000 && !pk.paused) { toast(`The screen was off for ${fmtTime(ms / 1000)}. Nothing can be counted while it's off.`); haptic([80, 60, 80]); }
    }
  };
  document.addEventListener("visibilitychange", pk.onVis);
  pk.meterRaf = requestAnimationFrame(function meter() {
    if (!pk) return;
    $("pocketMeter").style.transform = `scaleX(${Math.min(1, pk.level / 25)})`;
    pk.meterRaf = requestAnimationFrame(meter);
  });
  pk.lock.ready.then(() => setTimeout(() => {
    if (pk && !pk.lock.isOn()) {
      $("pocketWarn").hidden = false;
      $("pocketWarn").textContent = "This phone didn't let the app keep the screen on. Before pocketing it, set your screen timeout / Auto-Lock to 5 minutes or more, or the count stops when the screen turns off.";
    }
  }, 600));
  $("pocketCount").textContent = "0"; pocketState("counting"); pocketGoalPaint(); haptic(20);
  pk.timer = setInterval(pocketTick, 1000);
  pk.saver = setInterval(() => pk && SkipEngine.idb.put(PK_KEY, packMotion(pk)), 10000);
  setTimeout(() => { if (pk && !pk.gotData && !pk.paused) { $("pocketState").textContent = "No sensor data"; $("pocketHint").textContent = "This phone isn't sending motion data to the browser. Pause and discard, then use the camera or a video instead."; } }, 2500);
}
const activeSeconds = () => pk ? (pk.activeMs + (pk.paused ? 0 : performance.now() - pk.runFrom)) / 1000 : 0;
function pocketTick() {
  if (!pk) return;
  $("pocketTime").textContent = fmtTime(activeSeconds());
  if (pk.paused) return;
  if (document.visibilityState !== "visible") { $("pocketState").textContent = "Screen off"; return; }
  if (pk.t.length < 200) return;
  try {
    const r = SkipCore.countAccel(pk.t, { x: pk.x, y: pk.y, z: pk.z }); pk.count = r.skips;
    $("pocketCount").textContent = fmtInt(r.skips); pocketGoalPaint();
    if (Math.floor(r.skips / 100) > pk.lastSaid) { pk.lastSaid = Math.floor(r.skips / 100); pkSay(String(pk.lastSaid * 100)); }
  } catch {}
}
// 3) pause / resume: paused time is cut out, so it doesn't count as rest
function pausePocket() {
  if (!pk || pk.paused) return;
  pocketTick(); pk.paused = true; pk.pausedAt = performance.now(); pk.activeMs += pk.pausedAt - pk.runFrom;
  pocketState("paused"); haptic([30, 40, 30]);
}
function resumePocket() {
  if (!pk || !pk.paused) return;
  const gap = (performance.now() - pk.pausedAt) / 1000;
  pk.shift += Math.max(0, gap - 1); // close the gap, leaving a 1 s seam that reads as "not skipping"
  pk.paused = false; pk.runFrom = performance.now(); pocketState("counting"); haptic(20);
}
function teardownPocket() {
  if (!pk) return null;
  const P = pk; pk = null;
  if (P.hiddenAt != null) P.hiddenMs += performance.now() - P.hiddenAt;
  removeEventListener("devicemotion", P.onMotion); document.removeEventListener("visibilitychange", P.onVis);
  cancelAnimationFrame(P.meterRaf); clearInterval(P.timer); clearInterval(P.saver); P.lock.release();
  $("pocketWarn").hidden = true;
  return P;
}
function closePocketScreen() { $("pocket").hidden = true; $("pocketDiscard").classList.remove("confirm"); $("pocketDiscard").textContent = "Discard"; }
async function finishPocketSession() {
  const P = teardownPocket(); closePocketScreen(); if (!P) return;
  haptic(30);
  const diag = { activeS: Math.round((P.activeMs + (P.paused ? 0 : performance.now() - P.runFrom)) / 1000), hiddenS: Math.round(P.hiddenMs / 1000), hides: P.hides, noGravity: P.noGravity, peak: Math.round(P.peak * 10) / 10, wakeLock: P.lock.isOn() };
  // keep the raw sensor data of the last session, so it can be checked (Profile > Pocket recording)
  SkipEngine.idb.put("pocket-last", { ...packMotion(P), diag, ua: navigator.userAgent });
  await finishPocket(P.t, motionOf(packMotion(P)), P.started, diag);
}
function discardPocket() {
  const b = $("pocketDiscard");
  if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = "Tap again to discard"; setTimeout(() => { b.classList.remove("confirm"); b.textContent = "Discard"; }, 3000); return; }
  teardownPocket(); SkipEngine.idb.del(PK_KEY); closePocketScreen(); toast("Session discarded");
}
// Why a session came out empty, in words
function pocketDiagnosis(t, diag) {
  if (!diag) return "No skips found.";
  const rate = t.length > 1 ? t.length / Math.max(1, t[t.length - 1] - t[0]) : 0;
  if (!t.length && diag.noGravity) return "No skips found: this phone sends motion data without gravity, which this counter can't use. Use the camera or a video instead.";
  if (!t.length || diag.hiddenS >= Math.max(4, diag.activeS * 0.3)) return `No skips found: the screen was off for ${fmtTime(diag.hiddenS)} of ${fmtTime(diag.activeS)}, and phones stop motion data while it's off. Keep the screen on (the app shows a black screen) and set the screen timeout to 5 minutes or more.`;
  if (rate < 20) return `No skips found: the phone only sent ${Math.round(rate)} motion readings a second (about 60 are needed). Battery saver can do this; turn it off and try again.`;
  if (diag.peak < 6) return "No skips found: the phone barely moved. Was it in your pocket while you skipped?";
  return "No skips found, although the phone did move. Please save the pocket recording (Profile › Pocket recording) and send it, so the counter can be tuned to your pocket.";
}
// stored motion: three axes (current), or just |a| (sessions saved by older versions)
const packMotion = P => ({ started: P.started, t: Float64Array.from(P.t), x: Float32Array.from(P.x), y: Float32Array.from(P.y), z: Float32Array.from(P.z) });
const motionOf = c => c.x ? { x: Array.from(c.x), y: Array.from(c.y), z: Array.from(c.z) } : Array.from(c.a);
async function finishPocket(t, a, started, diag) {
  SkipEngine.idb.del(PK_KEY);
  if (t.length < 200) { showError(diag ? pocketDiagnosis(t, diag) : "That was too short to count."); return; }
  try {
    const r = SkipCore.countAccel(Array.from(t), a); r.source = "pocket";
    $("playerCard").hidden = true; $("speedNote").hidden = true;
    if (r.skips > 0) saveResult(r, new Date(started), "pocket", "pocket");
    else { renderResult(r); showError(pocketDiagnosis(t, diag)); }
    window.__skipDebug = { via: "pocket", samples: t.length, skipTimes: r.skipTimes, diag };
    $("results").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  } catch (e) { showError(e.message || String(e)); }
}
// press and hold to pause, so a pocket can't press it by accident
(function holdToPause() {
  const b = $("pocketPause"), ring = $("holdRing"); let raf = 0, t0 = 0;
  const reset = () => { cancelAnimationFrame(raf); ring.style.setProperty("--p", 0); };
  const step = () => { const p = Math.min(100, (performance.now() - t0) / 10); ring.style.setProperty("--p", p); if (p >= 100) { reset(); pausePocket(); } else raf = requestAnimationFrame(step); };
  b.addEventListener("pointerdown", e => {
    e.preventDefault();
    // fabric pressing on the screen shows up as a large, flat contact (or several at once): ignore it
    if (!e.isPrimary || (e.pointerType === "touch" && (e.width > 70 || e.height > 70))) return;
    t0 = performance.now(); haptic(); raf = requestAnimationFrame(step);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, reset);
  b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pausePocket(); } }); // keyboard: no hold needed
})();
$("pocketStart").onclick = startPocket;
$("pocketResume").onclick = resumePocket;
$("pocketFinish").onclick = finishPocketSession;
$("pocketDiscard").onclick = discardPocket;
$("pocketCancel").onclick = () => { if (pk && !pk.paused) return; if (pk) pausePocket(); else closePocketScreen(); };
// today's goal, right before you start
$("pocketGoalBtn").onclick = () => { if (pk && !pk.paused) return; const i = $("pocketGoalInput"); i.value = goal(); i.hidden = false; $("pocketGoalBtn").parentElement.hidden = true; i.focus(); i.select(); };
const pocketGoalSet = () => {
  const i = $("pocketGoalInput"); if (i.hidden) return;
  const v = Math.round(+i.value); if (v >= 10) setTodayGoal(v);
  i.hidden = true; $("pocketGoalBtn").parentElement.hidden = false; pocketGoalPaint(); renderHome();
};
$("pocketGoalInput").addEventListener("change", pocketGoalSet); $("pocketGoalInput").addEventListener("blur", pocketGoalSet);
$("pocketGoalInput").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });

// an unfinished pocket session (the page was closed or reloaded mid-session)
async function checkUnfinished() {
  const c = await SkipEngine.idb.get(PK_KEY); if (!c || !c.t || c.t.length < 200) return;
  let est = 0; try { est = SkipCore.countAccel(Array.from(c.t), motionOf(c)).skips; } catch {}
  $("resumeText").textContent = `Started ${fmtDate(c.started, { weekday: "short", day: "numeric", month: "short" })} at ${new Date(c.started).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · about ${fmtInt(est)} skips`;
  $("resumeCard").hidden = false;
  $("resumeSave").onclick = async () => { $("resumeCard").hidden = true; await finishPocket(c.t, motionOf(c), c.started); };
  $("resumeDrop").onclick = () => { $("resumeCard").hidden = true; SkipEngine.idb.del(PK_KEY); toast("Discarded"); };
}

// ================================================================ streak & days
function byDay() {
  const m = new Map();
  for (const s of sessions) {
    const k = dayKey(s.at), d = m.get(k) || { skips: 0, kcal: 0, sec: 0, n: 0 };
    d.skips += s.skips; d.kcal += s.kcal || 0; d.sec += s.jumpS; d.n++; m.set(k, d);
  }
  return m;
}
function streaks(days) {
  let cur = 0, d = startOfDay(new Date());
  if (!days.has(dayKey(d))) d = addDays(d, -1); // today not done yet: streak still counts from yesterday
  while (days.has(dayKey(d))) { cur++; d = addDays(d, -1); }
  const keys = [...days.keys()].sort(); let best = 0, run = 0, prev = null;
  for (const k of keys) { const dt = new Date(k + "T00:00"); run = prev && (dt - prev) / 864e5 === 1 ? run + 1 : 1; best = Math.max(best, run); prev = dt; }
  return { cur, best };
}
// Goals: an everyday goal, plus an optional goal for a specific day (e.g. 10,000 today).
// Both live in the profile record, which journal.js syncs with your Google account.
const prof = () => store.get("skipcount.profile", {}) || {};
function setProf(patch) { store.set("skipcount.profile", { ...prof(), ...patch }); window.SkipJournal?.touchProfile(); }
const dailyGoal = () => Math.max(10, +prof().goal || 1000);
function goal(day = dayKey(new Date())) { return Math.max(10, +(prof().goalByDay || {})[day] || dailyGoal()); }
function setTodayGoal(v) {
  const k = dayKey(new Date()), byDay = { ...(prof().goalByDay || {}) };
  if (v === dailyGoal()) delete byDay[k]; else byDay[k] = v;
  for (const d of Object.keys(byDay)) if (d < dayKey(addDays(new Date(), -60))) delete byDay[d]; // keep it small
  setProf({ goalByDay: byDay });
}
const todaySkips = () => (byDay().get(dayKey(new Date())) || {}).skips || 0;
function renderHome() {
  const now = new Date(), days = byDay(), t = days.get(dayKey(now)) || { skips: 0, kcal: 0, sec: 0, n: 0 }, { cur } = streaks(days);
  $("todayDate").textContent = fmtDate(now, { weekday: "long", day: "numeric", month: "long" });
  $("todaySkips").textContent = fmtInt(t.skips);
  $("todayKcal").textContent = fmtKcal(t.kcal); $("todayMin").textContent = Math.round(t.sec / 60); $("todaySess").textContent = t.n;
  $("streakNum").textContent = cur;
  const g = goal(), pct = Math.min(100, t.skips / g * 100);
  $("goalNum").textContent = fmtInt(g); $("goalBtn").firstChild.textContent = g !== dailyGoal() ? "today's goal " : "goal ";
  $("goalFill").style.width = `${pct}%`; $("goalTrack").setAttribute("aria-valuenow", Math.round(pct));
  const mon = mondayOf(now), vals = [...Array(7)].map((_, i) => days.get(dayKey(addDays(mon, i)))?.skips || 0), max = Math.max(g, ...vals);
  const wb = $("weekBars"); wb.classList.remove("in"); wb.innerHTML = vals.map((v, i) => {
    const isNow = dayKey(addDays(mon, i)) === dayKey(now);
    return `<div class="${isNow ? "now" : ""}" title="${fmtInt(v)} skips"><i class="${v ? "" : "nil"}" style="height:${v ? Math.max(8, v / max * 48) : 3}px;transition-delay:${i * 40}ms"></i><em>${DOW[i]}</em></div>`;
  }).join("");
  requestAnimationFrame(() => requestAnimationFrame(() => wb.classList.add("in")));
}
$("goalBtn").onclick = () => { const i = $("goalInput"); i.value = goal(); i.hidden = false; $("goalBtn").hidden = true; i.focus(); i.select(); };
const setGoal = () => { // the home card sets today's goal; the everyday goal is in the profile
  const i = $("goalInput"); if (i.hidden) return;
  const v = Math.round(+i.value);
  if (v >= 10) { setTodayGoal(v); toast(v === dailyGoal() ? `Today's goal back to your usual ${fmtInt(v)}` : `Goal for today: ${fmtInt(v)} skips`); }
  i.hidden = true; $("goalBtn").hidden = false; renderHome();
};
$("goalInput").addEventListener("change", setGoal); $("goalInput").addEventListener("blur", setGoal);
$("goalInput").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });

// ================================================================ insights
const ins = { p: "week", anchor: mondayOf(new Date()), metric: "skips" };
function periodStart(p, d) { d = startOfDay(d); if (p === "week") return mondayOf(d); if (p === "month") return new Date(d.getFullYear(), d.getMonth(), 1); if (p === "year") return new Date(d.getFullYear(), 0, 1); return d; }
function periodShift(p, d, n) { d = new Date(d); if (p === "day") return addDays(d, n); if (p === "week") return addDays(d, 7 * n); if (p === "month") return new Date(d.getFullYear(), d.getMonth() + n, 1); return new Date(d.getFullYear() + n, 0, 1); }
function periodTitle(p, s) {
  const now = new Date(), cur = periodStart(p, now);
  if (p === "day") { const diff = Math.round((startOfDay(now) - s) / 864e5); return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : fmtDate(s, { weekday: "short", day: "numeric", month: "short", year: s.getFullYear() !== now.getFullYear() ? "numeric" : undefined }); }
  if (p === "week") { if (+s === +cur) return "This week"; if (+s === +addDays(cur, -7)) return "Last week"; const e = addDays(s, 6); return `${fmtDate(s, { day: "numeric", month: "short" })} – ${fmtDate(e, { day: "numeric", month: "short", year: e.getFullYear() !== now.getFullYear() ? "numeric" : undefined })}`; }
  if (p === "month") return fmtDate(s, { month: "long", year: "numeric" });
  return String(s.getFullYear());
}
function inRange(a, b) { return sessions.filter(s => s.at >= +a && s.at < +b); }
function totals(list) { return list.reduce((t, s) => ({ skips: t.skips + s.skips, kcal: t.kcal + (s.kcal || 0), sec: t.sec + s.jumpS, n: t.n + 1, days: t.days.add(dayKey(s.at)) }), { skips: 0, kcal: 0, sec: 0, n: 0, days: new Set() }); }

function renderInsights() {
  const p = ins.p, s = ins.anchor, e = periodShift(p, s, 1), list = inRange(s, e), T = totals(list);
  const prevT = totals(inRange(periodShift(p, s, -1), s));
  $("periodTitle").textContent = periodTitle(p, s);
  $("nextP").disabled = +e > Date.now();
  const delta = (a, b) => { if (!b) return ""; const d = Math.round((a - b) / b * 100); return `<span class="delta ${d >= 0 ? "up" : ""}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d)}% vs previous</span>`; };
  const tiles = [
    [fmtCompact(T.skips), "skips", delta(T.skips, prevT.skips)],
    [fmtKcal(T.kcal), "kcal burned", delta(T.kcal, prevT.kcal)],
    [fmtMin(T.sec), "jumping", delta(T.sec, prevT.sec)],
    p === "day" ? [String(T.n), T.n === 1 ? "session" : "sessions", ""] : [String(T.days.size), T.days.size === 1 ? "active day" : "active days", ""]
  ];
  $("tiles").innerHTML = tiles.map(([v, l, d]) => `<div class="tile"><b>${v}</b><span>${l}</span>${d}</div>`).join("");
  renderBars(p, s, e, list);
  renderSessions(list, p);
  renderHeat();
}

function renderBars(p, s, e, list) {
  const metric = ins.metric, val = x => metric === "skips" ? x.skips : metric === "kcal" ? (x.kcal || 0) : x.jumpS / 60;
  const fmtV = v => metric === "skips" ? fmtInt(v) : metric === "kcal" ? fmtKcal(v) : `${Math.round(v)}m`;
  let cols = [];
  if (p === "day") { $("barsLabel").textContent = "Per session"; cols = list.map(x => ({ label: new Date(x.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), v: val(x) })); }
  else if (p === "week") { $("barsLabel").textContent = "Per day"; for (let i = 0; i < 7; i++) { const d = addDays(s, i), k = dayKey(d); cols.push({ label: DOW[i], v: list.filter(x => dayKey(x.at) === k).reduce((a, x) => a + val(x), 0), today: k === dayKey(new Date()) }); } }
  else if (p === "month") { $("barsLabel").textContent = "Per day"; const n = new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate(); for (let i = 0; i < n; i++) { const k = dayKey(addDays(s, i)); cols.push({ label: (i + 1) % 5 === 1 || i === n - 1 ? String(i + 1) : "", v: list.filter(x => dayKey(x.at) === k).reduce((a, x) => a + val(x), 0) }); } }
  else { $("barsLabel").textContent = "Per month"; for (let m = 0; m < 12; m++) cols.push({ label: fmtDate(new Date(s.getFullYear(), m, 1), { month: "narrow" }), v: list.filter(x => new Date(x.at).getMonth() === m).reduce((a, x) => a + val(x), 0) }); }
  const bars = $("bars"); bars.classList.remove("in"); bars.innerHTML = "";
  if (!cols.length) { bars.innerHTML = `<div class="empty" style="flex:1;align-self:center"><b>No sessions this day</b>Count one on the Count tab.</div>`; return; }
  const max = Math.max(...cols.map(c => c.v), 1e-9);
  cols.forEach((c, i) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "col";
    b.setAttribute("aria-label", `${c.label || i + 1}: ${fmtV(c.v)}`);
    b.innerHTML = `<span class="val">${fmtV(c.v)}</span><span class="bar"><i class="${c.v ? "" : "zero"}" style="height:${c.v ? Math.max(3, c.v / max * 100) : 0}%;transition-delay:${Math.min(i * 28, 500)}ms"></i></span><em>${c.label}</em>`;
    b.onclick = () => { const on = !b.classList.contains("sel"); bars.querySelectorAll(".col").forEach(x => x.classList.remove("sel")); if (on) b.classList.add("sel"); haptic(); };
    bars.appendChild(b);
  });
  // highlight the best column by default
  const best = cols.reduce((bi, c, i) => c.v > cols[bi].v ? i : bi, 0);
  if (cols[best].v > 0) bars.children[best].classList.add("sel");
  requestAnimationFrame(() => requestAnimationFrame(() => bars.classList.add("in")));
}

function renderSessions(list, p) {
  const box = $("sessions"); box.innerHTML = "";
  $("sessCount").textContent = list.length ? `${list.length}` : "";
  if (!list.length) {
    box.innerHTML = sessions.length
      ? `<div class="empty"><b>Nothing in this ${p}</b>Use the arrows to look at other ${p}s.</div>`
      : `<div class="empty"><b>No sessions yet</b>Count a video or a live session and it shows up here, with your streak and heatmap.</div>`;
    return;
  }
  for (const s of [...list].reverse()) {
    const row = document.createElement("div"); row.className = "sess";
    const d = new Date(s.at), src = s.source === "live" ? "live" : s.source === "manual" ? "added by hand" : "video";
    row.innerHTML = `<div class="when"><b>${fmtDate(d, { weekday: "short", day: "numeric", month: "short" })} · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</b>
      <span>${fmtMin(s.jumpS)} · ${s.sets?.length ? `${s.sets.length} set${s.sets.length === 1 ? "" : "s"} · ` : ""}${fmtKcal(s.kcal || 0)} kcal · ${src}${s.note ? ` · ${escapeHtml(s.note)}` : ""}</span></div>
      <span class="n">${fmtInt(s.skips)}</span><button type="button" class="del" aria-label="Delete this session">Delete</button>`;
    const del = row.querySelector(".del");
    del.onclick = () => {
      if (!del.classList.contains("confirm")) { del.classList.add("confirm"); del.textContent = "Tap to confirm"; haptic(); setTimeout(() => { del.classList.remove("confirm"); del.textContent = "Delete"; }, 3000); return; }
      const removed = removeSession(s.id);
      if (s.id === currentId) { $("savedRow").hidden = true; currentId = null; }
      toast("Session deleted", () => SkipJournal.restore(removed));
    };
    box.appendChild(row);
  }
}

function renderHeat() {
  const days = byDay(), today = startOfDay(new Date());
  const start = addDays(mondayOf(today), -52 * 7), box = $("heat"); box.innerHTML = "";
  const vals = [...days.values()].map(d => d.skips).filter(v => v > 0).sort((a, b) => a - b);
  const q = f => vals.length ? vals[Math.min(vals.length - 1, Math.floor(f * vals.length))] : 1;
  const cut = [q(0.25), q(0.5), q(0.75)];
  let lastMonth = -1, active = 0;
  for (let w = 0; w < 53; w++) {
    const wk = addDays(start, w * 7), m = document.createElement("span"); m.className = "m";
    const firstOfMonth = [...Array(7)].map((_, i) => addDays(wk, i)).find(d => d.getDate() === 1);
    if (firstOfMonth && firstOfMonth.getMonth() !== lastMonth && w < 51) { m.textContent = fmtDate(firstOfMonth, { month: "short" }); lastMonth = firstOfMonth.getMonth(); }
    if (w === 0) { m.textContent = fmtDate(wk, { month: "short" }); lastMonth = wk.getMonth(); }
    box.appendChild(m);
    for (let i = 0; i < 7; i++) {
      const d = addDays(wk, i), k = dayKey(d), c = document.createElement("span"), v = days.get(k)?.skips || 0;
      c.className = "d";
      if (d > today) c.classList.add("future");
      else if (v > 0) { active++; c.classList.add(v <= cut[0] ? "l1" : v <= cut[1] ? "l2" : v <= cut[2] ? "l3" : "l4"); }
      if (k === dayKey(today)) c.classList.add("today");
      c.title = `${fmtDate(d, { weekday: "short", day: "numeric", month: "short" })}: ${v ? `${fmtInt(v)} skips` : "no skipping"}`;
      box.appendChild(c);
    }
  }
  const { cur, best } = streaks(days);
  $("heatSummary").textContent = `${active} active day${active === 1 ? "" : "s"} · best streak ${best}`;
  const sc = $("heatScroll"); sc.scrollLeft = sc.scrollWidth;
}

// ================================================================ segmented controls & tabs (sliding pills)
function placePill(seg) {
  const pill = seg.querySelector(".pill"), on = seg.querySelector('[aria-pressed="true"]'); if (!pill || !on || !on.offsetWidth) return;
  pill.style.width = `${on.offsetWidth}px`; pill.style.transform = `translateX(${on.offsetLeft}px)`;
}
function setupSeg(seg, onPick) {
  seg.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || b.getAttribute("aria-pressed") === "true") return;
    seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    placePill(seg); haptic(); onPick(b);
  });
}
setupSeg($("periodSeg"), b => { ins.p = b.dataset.p; ins.anchor = periodStart(ins.p, new Date()); renderInsights(); });
setupSeg($("metricSeg"), b => { ins.metric = b.dataset.m; renderInsights(); });
$("prevP").onclick = () => { ins.anchor = periodShift(ins.p, ins.anchor, -1); haptic(); renderInsights(); };
$("nextP").onclick = () => { ins.anchor = periodShift(ins.p, ins.anchor, 1); haptic(); renderInsights(); };

function placeTabPill() {
  const on = document.querySelector('.tabbar [aria-selected="true"] .ic'), pill = $("tabPill"), inner = pill.parentElement;
  const a = on.getBoundingClientRect(), b = inner.getBoundingClientRect();
  pill.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
}
function showTab(name, push = true) {
  for (const t of ["count", "insights"]) {
    $("view-" + t).hidden = t !== name;
    $("tab-" + t).setAttribute("aria-selected", String(t === name));
  }
  placeTabPill();
  if (name === "insights") { renderInsights(); placePill($("periodSeg")); placePill($("metricSeg")); }
  else drawChart(null);
  if (push) { try { history.replaceState(null, "", name === "count" ? location.pathname + location.search : "#insights"); } catch {} }
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}
document.querySelectorAll(".tabbar [data-tab]").forEach(b => b.addEventListener("click", () => { if (b.getAttribute("aria-selected") !== "true") { haptic(); showTab(b.dataset.tab); } }));
addEventListener("hashchange", () => showTab(location.hash === "#insights" ? "insights" : "count", false));
addEventListener("resize", () => { placeTabPill(); placePill($("periodSeg")); placePill($("metricSeg")); drawChart(null); });

function refreshAll() { renderHome(); if (!$("view-insights").hidden) renderInsights(); }

// ================================================================ theme
(function theme() {
  const saved = store.get("skipcount.theme", null);
  if (saved) document.documentElement.dataset.theme = saved;
  $("themeBtn").onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark"; document.documentElement.dataset.theme = next; store.set("skipcount.theme", next); haptic(); drawChart(null);
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => drawChart(null));
})();


// ================================================================ profile sheet
let sheetOpener = null;
function openSheet() {
  sheetOpener = document.activeElement;
  $("sheetBack").hidden = false; $("profileSheet").hidden = false;
  requestAnimationFrame(() => { $("sheetBack").classList.add("show"); $("profileSheet").classList.add("show"); });
  haptic(); setTimeout(() => $("sheetClose").focus(), 50);
}
function closeSheet() {
  $("sheetBack").classList.remove("show"); $("profileSheet").classList.remove("show");
  setTimeout(() => { $("sheetBack").hidden = true; $("profileSheet").hidden = true; }, reduceMotion() ? 0 : 350);
  sheetOpener?.focus?.();
}
$("profileBtn").onclick = openSheet; $("editProfile").onclick = openSheet;
$("sheetClose").onclick = closeSheet; $("sheetBack").onclick = closeSheet;
addEventListener("keydown", e => { if (e.key === "Escape" && !$("profileSheet").hidden) closeSheet(); });
$("dailyGoal").addEventListener("change", e => {
  const v = Math.round(+e.target.value); if (!(v >= 10)) { e.target.value = dailyGoal(); return; }
  setProf({ goal: v }); renderHome(); toast(`Daily goal: ${fmtInt(v)} skips`);
});
// the avatar shows your initial once you're signed in with Google
window.onCloudStatus = (status, user) => {
  const a = $("profileBtn"), txt = $("avatarTxt");
  if (user?.email) { a.classList.add("in"); txt.textContent = user.email[0].toUpperCase(); a.title = user.email; }
  else { a.classList.remove("in"); txt.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.4-3.8 4.2-5.6 7.5-5.6s6.1 1.8 7.5 5.6"/></svg>'; a.title = ""; }
};

// ================================================================ pocket recording (to tune the counter to a real pocket)
$("pocketRecBtn").onclick = async () => {
  const r = await SkipEngine.idb.get("pocket-last");
  if (!r || !r.t || !r.t.length) { toast("No pocket recording yet. Do a pocket session first."); return; }
  const data = { app: "skip-count", kind: "pocket-recording", started: new Date(r.started).toISOString(), ua: r.ua, diag: r.diag,
    t: Array.from(r.t, v => Math.round(v * 1000) / 1000),
    ...(r.x ? { x: Array.from(r.x, v => Math.round(v * 100) / 100), y: Array.from(r.y, v => Math.round(v * 100) / 100), z: Array.from(r.z, v => Math.round(v * 100) / 100) } : { a: Array.from(r.a, v => Math.round(v * 100) / 100) }) };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = `skip-count-pocket-${dayKey(r.started)}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`Saved a recording of ${fmtTime(r.t.length / 60)} of motion data`);
};

// ================================================================ install as an app
// Chrome/Edge/Android: offer the real install prompt. iPhone/iPad: explain Share > Add to Home Screen.
let installEvt = null;
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isiOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function paintInstall() {
  const card = $("installCard"), btn = $("installBtn");
  if (standalone()) { card.hidden = true; return; }
  if (installEvt) { card.hidden = false; btn.hidden = false; $("installText").textContent = "Install Skip Count to open it from your home screen like any other app. It works offline too."; return; }
  if (isiOS) { card.hidden = false; btn.hidden = true; $("installText").innerHTML = "To add Skip Count to your home screen: tap <b>Share</b> (the square with an arrow) in Safari, then <b>Add to Home Screen</b>."; return; }
  card.hidden = true;
}
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; paintInstall(); });
addEventListener("appinstalled", () => { installEvt = null; paintInstall(); toast("Installed. Open Skip Count from your home screen."); });
$("installBtn").onclick = async () => { if (!installEvt) return; const e = installEvt; installEvt = null; e.prompt(); try { await e.userChoice; } catch {} paintInstall(); };
paintInstall();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(e => console.warn("Service worker not registered:", e)));
}

// ================================================================ wiring
loadProfile();
let updatedTimer = 0;
function profileChanged() {
  saveProfile();
  if (!calSource) return;
  const before = $("kTotal").textContent, c = renderCalories(calSource.skips, calSource.jumpS, calSource.restS);
  if (currentId) updateSession(currentId, { kcal: Math.round(c.total * 10) / 10 });
  const p = profile();
  const w = $("weightUnit").value === "lb" ? `${Math.round(p.kg / 0.45359237)} lb` : `${Math.round(p.kg * 10) / 10} kg`;
  const h = $("heightUnit").value === "cm" ? `${Math.round(p.cm)} cm` : `${$("heightFt").value}′${$("heightIn").value}″`;
  $("updated").textContent = `✓ Updated for ${w} · ${h} · ${p.age} · ${p.sex}`; renderBased();
  $("updated").classList.add("show");
  if ($("kTotal").textContent !== before) { const n = $("kTotal"); n.classList.remove("flash"); void n.offsetWidth; n.classList.add("flash"); }
  clearTimeout(updatedTimer); updatedTimer = setTimeout(() => $("updated").classList.remove("show"), 3500);
}
for (const id of ["weight", "heightCm", "heightFt", "heightIn", "age"]) $(id).addEventListener("input", profileChanged);
document.querySelectorAll('input[name="sex"]').forEach(r => r.addEventListener("change", profileChanged));
$("weightUnit").addEventListener("change", e => { // convert, so switching units doesn't change your weight
  const v = parseFloat($("weight").value);
  if (v > 0) $("weight").value = e.target.value === "lb" ? Math.round(v / 0.45359237) : Math.round(v * 0.45359237 * 10) / 10;
  profileChanged();
});
let heightUnitNow = $("heightUnit").value;
for (const id of ["heightUnit", "heightUnit2"]) $(id).addEventListener("change", e => {
  const cm = heightUnitNow === "cm" ? parseFloat($("heightCm").value) || 175 : (parseFloat($("heightFt").value) || 0) * 30.48 + (parseFloat($("heightIn").value) || 0) * 2.54;
  heightUnitNow = e.target.value; showHeightUnit(e.target.value);
  if (e.target.value === "cm") $("heightCm").value = Math.round(cm);
  else { const inches = cm / 2.54; let ft = Math.floor(inches / 12), inch = Math.round(inches - ft * 12); if (inch === 12) { ft++; inch = 0; } $("heightFt").value = ft; $("heightIn").value = inch; }
  profileChanged();
});
$("file").addEventListener("change", e => { const f = e.target.files[0]; if (f) analyseFile(f); });
$("liveBtn").addEventListener("click", startLive);
$("pocketBtn").addEventListener("click", openPocket);
$("sayHundreds").addEventListener("change", e => { if (e.target.checked && "speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance("")); }); // iPhone only allows speech that starts from a tap
$("liveStop").addEventListener("click", stopLive);
$("sessDate").addEventListener("change", e => {
  if (!currentId || !e.target.value) return;
  const s = sessions.find(x => x.id === currentId), old = new Date(s.at), [y, m, d] = e.target.value.split("-").map(Number);
  updateSession(currentId, { at: +new Date(y, m - 1, d, old.getHours(), old.getMinutes()) });
  toast(`Moved to ${fmtDate(new Date(y, m - 1, d), { weekday: "short", day: "numeric", month: "short" })}`);
});
$("mDate").value = dayKey(new Date());
$("mGo").addEventListener("click", () => {
  const skips = parseInt($("mSkips").value, 10), min = parseFloat($("mMin").value), rest = parseFloat($("mRest").value) || 0;
  if (!(skips > 0)) { $("mSkips").focus(); toast("Enter how many skips"); return; }
  if (!(min > 0)) { $("mMin").focus(); toast("Enter how many minutes you jumped"); return; }
  const [y, m, d] = ($("mDate").value || dayKey(new Date())).split("-").map(Number), now = new Date();
  const c = kcalFor(skips, min * 60, rest * 60);
  const s = addSession({ at: +new Date(y, m - 1, d, now.getHours(), now.getMinutes()), source: "manual", skips, jumpS: min * 60, restS: rest * 60, sets: [], kcal: c.total }); haptic(20);
  $("mSkips").value = $("mMin").value = $("mRest").value = "";
  toast(`Added ${fmtInt(skips)} skips · ${fmtKcal(c.total)} kcal`, () => { removeSession(s.id); toast("Removed"); });
});
$("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ app: "skip-count", version: 1, exported: new Date().toISOString(), profile: store.get("skipcount.profile", null), sessions: SkipJournal.list() }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `skip-count-backup-${dayKey(new Date())}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`Backup saved (${sessions.length} sessions)`);
});
$("importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const data = JSON.parse(await f.text()), list = Array.isArray(data) ? data : data.sessions;
    if (!Array.isArray(list)) throw new Error("not a Skip Count backup");
    const added = SkipJournal.importMany(list);
    toast(`Restored ${added} session${added === 1 ? "" : "s"}`);
  } catch (err) { toast(`Couldn't read that file: ${err.message}`); }
});

// ================================================================ start
// Opening view: your last session if there is one, otherwise the verified example clip.
function showLastSession() {
  const s = sessions[sessions.length - 1]; if (!s) return false;
  const sets = (s.sets || []).map((n, i) => ({ start: i, end: i, skips: n }));
  renderResult({ skips: s.skips, skipTimes: [], sets, jumpingSeconds: s.jumpS, restSeconds: s.restS, totalSeconds: s.jumpS + s.restS, source: s.source, bodySize: 1 },
    { sessionId: s.id, at: s.at, lastLabel: true });
  return true;
}
(function example() {
  if (showLastSession()) return;
  const sets = [[0.85, 8.18, 19], [16.1, 19.55, 9], [21.7, 25.6, 10], [28.1, 30.0, 5], [31.5, 34.6, 8]];
  const gt = [1.03,1.5,1.9,2.26,2.63,3.0,3.4,3.8,4.16,4.6,5.0,5.33,5.66,6.06,6.43,6.83,7.16,7.56,7.93,16.29,16.69,17.09,17.45,17.85,18.22,18.58,18.95,19.35,21.88,22.35,22.75,23.11,23.48,23.88,24.28,24.65,25.05,25.41,28.24,28.68,29.07,29.44,29.84,31.64,32.04,32.41,32.81,33.2,33.6,34.0,34.4];
  const fps = 30, n = 39 * fps, x = new Float64Array(n);
  for (const [s, e] of sets) for (let i = Math.floor(s * fps); i < e * fps; i++) {
    let d = Infinity; for (const g of gt) d = Math.min(d, Math.abs(g - i / fps));
    x[i] = Math.cos(Math.min(d, 0.19) / 0.385 * 2 * Math.PI) * 0.18;
  }
  const jump = sets.reduce((a, s) => a + s[1] - s[0], 0);
  renderResult({ skips: 51, skipTimes: gt, sets: sets.map(([start, end, skips]) => ({ start, end, skips })), jumpingSeconds: jump,
    totalSeconds: 38.7, restSeconds: 38.7 - jump, filtered: x, fps, offset: 0, bodySize: 0.7 }, { example: true });
})();
renderBased();
window.loadProfile = () => { loadProfile(); renderBased(); renderHome(); if (calSource) renderCalories(calSource.skips, calSource.jumpS, calSource.restS); };
window.renderCalories = renderCalories;
checkUnfinished();
if (new URLSearchParams(location.search).get("start") === "pocket") { try { history.replaceState(null, "", location.pathname); } catch {} setTimeout(openPocket, 300); }
renderHome();
showTab(location.hash === "#insights" ? "insights" : "count", false);
document.fonts?.ready.then(() => { placeTabPill(); placePill($("periodSeg")); placePill($("metricSeg")); drawChart(null); });
