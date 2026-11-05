// Synthetic accelerometer workouts (phone in a trouser pocket) with known skip
// counts, run through SkipCore.countAccel.   node web/test_accel.js
const core = require("./core.js");
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function workout(plan, seed = 1) {
  const R = rng(seed), g = 9.81, t = [], a = []; let now = 0, truth = 0;
  const sample = v => { t.push(now); a.push(Math.max(0, v + (R() - 0.5) * 1.2)); now += 1 / (55 + R() * 10); }; // ~60 Hz, jittery like a real sensor
  for (const [kind, x, y] of plan) {
    if (kind === "jump") { // x skips at y per minute
      const T = 60 / y;
      for (let k = 0; k < x; k++) {
        const end = now + T * (0.9 + R() * 0.2), land = now + T * 0.45, peak = 22 + R() * 14;
        while (now < end) {
          let v;
          if (now < land) v = 0.6 + R() * 1.5;                                  // in the air: nearly weightless
          else { const s = now - land; v = g + (peak - g) * Math.exp(-s / 0.035) + 3 * Math.exp(-s / 0.12); } // landing spike
          sample(v);
        }
        truth++;
      }
    } else if (kind === "walk") { const end = now + x; while (now < end) { const ph = (now * 1.9) % 1; sample(g + (ph < 0.12 ? 5 * Math.sin(ph / 0.12 * Math.PI) : 0) - 1.2 * Math.sin(ph * 2 * Math.PI)); } }
    else { const end = now + x; while (now < end) sample(g + 0.3 * Math.sin(now * 2)); } // rest / standing
  }
  return { t, a, truth };
}
const cases = [
  ["steady 2 min", [["rest", 3], ["jump", 260, 130], ["rest", 3]]],
  ["beginner: short sets, walking for the rope", [["rest", 3], ["jump", 14, 100], ["walk", 5], ["rest", 2], ["jump", 6, 95], ["rest", 4], ["jump", 45, 110], ["walk", 6], ["jump", 30, 120], ["rest", 5]]],
  ["fast 160/min", [["rest", 2], ["jump", 200, 160], ["rest", 2]]],
  ["slow 80/min", [["rest", 2], ["jump", 80, 80], ["rest", 2]]],
  ["just walking", [["walk", 60]]],
];
let ok = true;
for (const [name, plan] of cases) for (const seed of [1, 2, 3]) {
  const w = workout(plan, seed), r = core.countAccel(w.t, w.a), err = r.skips - w.truth;
  const pass = Math.abs(err) <= Math.max(2, Math.round(w.truth * 0.01));
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name.padEnd(44)} seed ${seed}: counted ${r.skips}, truth ${w.truth}, sets [${r.sets.map(s => s.skips)}]`);
}
// Loose trouser pocket: the phone floats and brushes the fabric in the air, lands late and
// bangs against the thigh two or three times per landing.
const G = 9.81;
function loose(plan, seed = 1, o = {}) {
  const R = rng(seed), t = [], a = []; let now = 0, truth = 0;
  const hz = o.hz || 60;
  const add = v => { t.push(now); a.push(Math.max(0, v)); now += 1 / (hz * (0.92 + R() * 0.16)); };
  for (const [kind, x, y] of plan) {
    if (kind === "jump") {
      const T = 60 / y;
      for (let k = 0; k < x; k++) {
        const start = now, end = now + T * (0.9 + R() * 0.2);
        const flight = T * (o.flight || 0.32) * (0.8 + R() * 0.4);   // short beginner hops
        const lag = 0.03 + R() * 0.06;                                 // phone lands after the body
        const hits = [0, 0.04 + R() * 0.05, 0.1 + R() * 0.06].map((d, i) => ({ at: start + flight + lag + d, amp: (i ? 0.5 + R() * 0.6 : 1) * (12 + R() * 22) * (o.impact || 1), w: 0.012 + R() * 0.018 }));
        while (now < end) {
          let v;
          if (now < start + flight) v = 0.8 + R() * 3.2 + (R() < 0.08 ? R() * 6 : 0);   // floating in the pocket, brushing fabric
          else {
            v = G * (1 + 0.25 * Math.sin(Math.PI * Math.min(1, (now - start - flight) / (end - start - flight)))) + (R() - 0.5) * 4; // stance push-off
            for (const h of hits) if (now >= h.at) v += h.amp * Math.exp(-(now - h.at) / h.w);
          }
          add(v);
        }
        truth++;
      }
    } else if (kind === "walk") { const end = now + x; while (now < end) { const ph = (now * 1.9) % 1; add(G + (ph < 0.12 ? 7 * Math.sin(ph / 0.12 * Math.PI) : 0) - 2 * Math.sin(ph * 2 * Math.PI) + (R() - .5) * 2.5); } }
    else if (kind === "hand") { const end = now + x; while (now < end) add(G + 6 * Math.sin(now * 2 * Math.PI * 2) + (R() - .5)); }
    else { const end = now + x; while (now < end) add(G + (R() - 0.5) * 1.2); }
  }
  return { t, a, truth };
}
for (const [name, plan, o] of [
  ["loose pocket, 100 skips", [["rest", 3], ["jump", 100, 120], ["rest", 3]], {}],
  ["loose pocket, low hops", [["rest", 3], ["jump", 100, 130], ["rest", 3]], { flight: 0.22 }],
  ["loose pocket, soft landings", [["rest", 3], ["jump", 100, 120], ["rest", 3]], { impact: 0.5 }],
  ["loose pocket, 4 sets + walking", [["rest", 3], ["jump", 30, 115], ["walk", 6], ["jump", 22, 120], ["rest", 4], ["jump", 40, 125], ["walk", 5], ["jump", 12, 110], ["rest", 3]], {}],
]) for (const seed of [1, 2]) {
  const w = loose(plan, seed, o), r = core.countAccel(w.t, w.a), pass = Math.abs(r.skips - w.truth) <= 2;
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name.padEnd(44)} seed ${seed}: counted ${r.skips}, truth ${w.truth}, sets [${r.sets.map(s => s.skips)}]`);
}
// Thigh strap and armband, as 3-axis readings in a random orientation. On the arm the
// rope-turning circle adds a swing on every turn and softens the landings.
// body vertical specific force over one skip cycle (what a sensor stuck to the hip would feel)
function bodyF(ph, flight, peak) { // ph in [0,1)
  if (ph < flight) return 0;                                              // in the air
  const s = ph - flight, c = 1 - flight;
  return G / c * 0.85 + peak * Math.exp(-s / 0.07) + 2 * Math.sin(Math.PI * s / c);
}
function place3d(place, plan, seed = 1, o = {}) {
  const R = rng(seed), t = [], a = [], X = [], Y = [], Z = []; let now = 0, truth = 0;
  // random fixed orientation of the phone (rotation about two axes)
  const p1 = R() * Math.PI * 2, p2 = (R() - 0.5) * Math.PI, c1 = Math.cos(p1), s1 = Math.sin(p1), c2 = Math.cos(p2), s2 = Math.sin(p2);
  const push = (x, y, z) => {
    const x1 = c1 * x - s1 * y, y1 = s1 * x + c1 * y, z1 = z;           // about z
    const y2 = c2 * y1 - s2 * z1, z2 = s2 * y1 + c2 * z1;               // about x
    t.push(now); a.push(Math.hypot(x, y, z)); X.push(x1); Y.push(y2); Z.push(z2); now += 1 / (60 * (0.92 + R() * 0.16));
  };
  for (const [kind, n, rate] of plan) {
    if (kind === "jump" || kind === "swing") {
      const T = 60 / rate, turns = o.turns || 1;               // rope turns per jump (2 = double unders)
      const armA = (o.arm || 5) * (0.8 + R() * 0.4);            // arm circling (m/s²)
      for (let k = 0; k < n; k++) {
        const start = now, end = now + T * (0.94 + R() * 0.12), flight = (o.flight || 0.35) * (0.85 + R() * 0.3), peak = (14 + R() * 16);
        while (now < end) {
          const ph = (now - start) / (end - start);
          let vert = kind === "jump" ? bodyF(ph, flight, peak) : G + (R() - 0.5);  // "swing": turning the rope without jumping
          let x = 0, y = vert, z = 0;
          if (place === "thigh") { y = vert * 1.1 + (ph < flight ? 1.5 * Math.sin(ph / flight * Math.PI) : 0); x = 2.5 * Math.sin(2 * Math.PI * ph); }
          if (place === "arm") {
            const damp = kind === "jump" ? 0.55 : 1;                                  // landing shock softened by the body
            y = G + (vert - G) * damp; if (kind === "jump" && ph < flight) y = 1.5 + R() * 1.5;
            const th = 2 * Math.PI * (turns * ph) + 0.8;                              // arm circles with the rope
            x += armA * Math.cos(th); y += armA * Math.sin(th) * 0.7; z += 1.2 * Math.sin(th * 2);
          }
          push(x + (R() - .5) * 1.5, y + (R() - .5) * 1.5, z + (R() - .5) * 1.5);
        }
        if (kind === "jump") truth++;
      }
    } else if (kind === "walk") { const end = now + n; while (now < end) { const ph = (now * 1.9) % 1, arm = place === "arm" ? 3 * Math.sin(2 * Math.PI * now * 0.95) : 0; push(arm + (R() - .5), G + (ph < .12 ? 6 * Math.sin(ph / .12 * Math.PI) : 0) - 1.5 * Math.sin(2 * Math.PI * ph) + (R() - .5) * 2, (R() - .5)); } }
    else { const end = now + n; while (now < end) push((R() - .5), G + (R() - .5), (R() - .5)); }
  }
  return { t, a, xyz: { x: X, y: Y, z: Z }, truth };
}
for (const [name, place, plan, o, truth] of [
  ["thigh strap, 100 skips", "thigh", [["rest", 3], ["jump", 100, 120], ["rest", 3]], {}, 100],
  ["thigh strap, sets + walking", "thigh", [["rest", 3], ["jump", 30, 115], ["walk", 6], ["jump", 40, 125], ["walk", 5], ["jump", 15, 110], ["rest", 3]], {}, 85],
  ["armband, 100 skips", "arm", [["rest", 3], ["jump", 100, 120], ["rest", 3]], {}, 100],
  ["armband, low hops", "arm", [["rest", 3], ["jump", 100, 140], ["rest", 3]], { flight: 0.25 }, 100],
  ["armband, big arm circles", "arm", [["rest", 3], ["jump", 100, 120], ["rest", 3]], { arm: 9 }, 100],
  ["armband, fast 170/min", "arm", [["rest", 3], ["jump", 100, 170], ["rest", 3]], {}, 100],
  ["armband, sets + walking", "arm", [["rest", 3], ["jump", 30, 115], ["walk", 6], ["jump", 40, 125], ["walk", 5], ["jump", 15, 110], ["rest", 3]], {}, 85],
  ["armband, turning the rope without jumping", "arm", [["rest", 3], ["swing", 30, 110], ["rest", 3]], {}, 0],
  ["armband, just walking", "arm", [["walk", 40]], {}, 0],
]) for (const seed of [1, 2, 3]) {
  const w = place3d(place, plan, seed, o), r = core.countAccel(w.t, w.xyz), pass = Math.abs(r.skips - truth) <= Math.max(1, Math.round(truth * 0.01));
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name.padEnd(44)} seed ${seed}: counted ${r.skips}, truth ${truth}, sets [${r.sets.map(s => s.skips)}]`);
}
// Low, efficient hops (the airborne dip only reaches ~0.4-0.85 g, soft landings, uneven
// rhythm) and more realistic walking (the leg with the phone lands harder; once-per-stride sway).
function shallow(plan, seed = 1, o = {}) {
  const R = rng(seed), t = [], X = [], Y = [], Z = [], jumps = []; let now = 0, truth = 0;
  const p1 = R() * 6.28, p2 = (R() - .5) * 3.1, c1 = Math.cos(p1), s1 = Math.sin(p1), c2 = Math.cos(p2), s2 = Math.sin(p2);
  const push = (x, y, z) => { const x1 = c1 * x - s1 * y, y1 = s1 * x + c1 * y, y2 = c2 * y1 - s2 * z, z2 = s2 * y1 + c2 * z; t.push(now); X.push(x1); Y.push(y2); Z.push(z2); now += 1 / ((o.hz || 60) * (0.9 + R() * 0.2)); };
  const [dipLo, dipHi] = o.dip || [0.4, 0.8];
  for (const [kind, n, rate] of plan) {
    if (kind === "jump") {
      for (let k = 0; k < n; k++) {
        const T = 60 / rate * (0.85 + R() * 0.3), start = now, end = now + T;           // irregular rhythm
        const flight = T * (0.22 + R() * 0.12), dip = G * (dipLo + R() * (dipHi - dipLo)), land = G * (1.3 + R() * 0.7);
        jumps.push(start + flight / 2);
        while (now < end) {
          const ph = now - start; let v;
          if (ph < flight) v = G - (G - dip) * Math.sin(Math.PI * ph / flight);          // shallow, rounded dip
          else { const s = ph - flight; v = G + (land - G) * Math.exp(-s / 0.06) * (s < 0.02 ? s / 0.02 : 1) + 1.0 * Math.sin(Math.PI * s / (T - flight)); }
          push((R() - .5) * 2, v + (R() - .5) * 1.6, (R() - .5) * 2);
        }
        truth++;
      }
    } else if (kind === "walk") { const end = now + n; while (now < end) { const ph = (now * 1.9) % 1; push((R() - .5), G + (ph < .12 ? 6 * Math.sin(ph / .12 * Math.PI) : 0) - 1.5 * Math.sin(2 * Math.PI * ph) + (R() - .5) * 2, (R() - .5)); } }
    else { const end = now + n; while (now < end) push((R() - .5), G + (R() - .5), (R() - .5)); }
  }
  return { t, xyz: { x: X, y: Y, z: Z }, truth, jumps };
}
function walk2(secs, seed = 1, o = {}) {
  const R = rng(seed), t = [], X = [], Y = [], Z = []; let now = 0;
  const p1 = R() * 6.28, c1 = Math.cos(p1), s1 = Math.sin(p1), step = o.step || (1.75 + R() * 0.3);
  const push = (x, y, z) => { t.push(now); X.push(c1 * x - s1 * y); Y.push(s1 * x + c1 * y); Z.push(z); now += 1 / (60 * (0.9 + R() * 0.2)); };
  while (now < secs) {
    const k = Math.floor(now * step), ph = now * step - k, near = k % 2 === 0, heel = (near ? 6 + R() : 2.5 + R()) * (o.hard || 1);
    let vert = G + (ph < 0.12 ? heel * Math.sin(ph / 0.12 * Math.PI) : 0) - 1.6 * Math.sin(2 * Math.PI * ph) + (R() - .5) * 1.5;
    const swing = o.place === "arm" ? 3.5 : 2.5, fwd = swing * Math.sin(Math.PI * now * step); // once per stride
    push(fwd + (R() - .5), vert, (o.place === "thigh" ? 2 : 0.8) * Math.cos(Math.PI * now * step) + (R() - .5));
  }
  return { t, xyz: { x: X, y: Y, z: Z }, truth: 0 };
}
const join = (...ws) => { const o = { t: [], xyz: { x: [], y: [], z: [] }, truth: 0 }; let off = 0; for (const w of ws) { o.t.push(...w.t.map(q => q + off)); for (const k of "xyz") o.xyz[k].push(...w.xyz[k]); o.truth += w.truth || 0; off = o.t[o.t.length - 1] + 0.02; } return o; };
for (const [name, mk, truth, tol] of [
  ["low hops, 80 + pause + 70", s => shallow([["rest", 3], ["jump", 80, 150], ["rest", 4], ["jump", 70, 150], ["rest", 3]], s), 150, 2],
  ["lower hops (0.55-0.85 g)", s => shallow([["rest", 3], ["jump", 150, 150], ["rest", 3]], s, { dip: [0.55, 0.85] }), 150, 30],
  ["low hops, walking between sets", s => join(shallow([["rest", 3], ["jump", 60, 150]], s), walk2(6, s), shallow([["jump", 50, 140], ["rest", 3]], s + 9)), 110, 4],
  ["walking (pocket)", s => walk2(40, s), 0, 0],
  ["walking (thigh)", s => walk2(40, s, { place: "thigh" }), 0, 0],
  ["walking (armband)", s => walk2(40, s, { place: "arm" }), 0, 0],
]) for (const seed of [1, 2, 3]) {
  const w = mk(seed), r = core.countAccel(w.t, w.xyz), pass = Math.abs(r.skips - truth) <= tol;
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name.padEnd(44)} seed ${seed}: counted ${r.skips}, truth ${truth}, sets [${r.sets.map(s => s.skips)}]`);
}
// Live count, the way the app shows it: recount every second; skips older than 4 s are locked
// in, the screen shows locked-in + what the counter sees in the last few seconds. Compared with
// the true number of skips done at that moment: on average within 2, never more than 3 ahead.
for (const [name, w] of [
  ["live: steady 100 @150", shallow([["rest", 3], ["jump", 100, 150], ["rest", 5]], 11)],
  ["live: low hops 80 + pause + 70", shallow([["rest", 3], ["jump", 80, 150], ["rest", 5], ["jump", 70, 150], ["rest", 3]], 12)],
  ["live: slow 110/min", shallow([["rest", 3], ["jump", 80, 110], ["rest", 4]], 14)],
  ["live: fast 170/min", shallow([["rest", 3], ["jump", 120, 170], ["rest", 4]], 13)],
]) {
  const a = w.xyz, committed = []; let lastT = -Infinity, ahead = 0, sum = 0, n = 0, shown = 0;
  for (let s1 = 3; s1 <= w.t[w.t.length - 1] + 0.01; s1 += 1) {
    let m = w.t.findIndex(q => q > s1); if (m < 0) m = w.t.length; if (m < 200) continue;
    const latest = w.t[m - 1], r = core.countAccel(w.t.slice(0, m), { x: a.x.slice(0, m), y: a.y.slice(0, m), z: a.z.slice(0, m) });
    for (const q of r.skipTimes) if (q > lastT + 0.15 && q <= latest - 4) { committed.push(q); lastT = q; }
    shown = committed.length + r.skipTimes.filter(q => q > lastT + 0.15).length;
    const done = w.jumps.filter(q => q <= latest).length; ahead = Math.max(ahead, shown - done); sum += Math.abs(shown - done); n++;
  }
  const avg = sum / n, pass = ahead <= 3 && avg <= 2 && Math.abs(shown - w.truth) <= Math.max(2, w.truth * 0.02);
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name.padEnd(44)}        : final ${shown}, truth ${w.truth}, on screen vs done: avg off ${avg.toFixed(1)}, most ahead ${ahead}`);
}
// Real recordings (tests/data/*.json): the true count was established from the data itself.
// Final count must be exact; the live screen (recount every second, settled + recent) must
// track the landings, ignoring the first 3 s (the countdown, while the phone is put away).
for (const f of require("fs").readdirSync(require("path").join(__dirname, "..", "tests", "data")).filter(n => n.endsWith(".json"))) {
  const d = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "tests", "data", f), "utf8"));
  const k0 = d.t.findIndex(q => q >= d.t[0] + 3), t = d.t.slice(k0), a = d.x ? { x: d.x.slice(k0), y: d.y.slice(k0), z: d.z.slice(k0) } : d.a.slice(k0);
  const sl = (A, m) => Array.isArray(A) ? A.slice(0, m) : { x: A.x.slice(0, m), y: A.y.slice(0, m), z: A.z.slice(0, m) };
  const r = core.countAccel(t, a), committed = []; let lastT = -Infinity, shown = 0, ahead = 0, off = 0, n = 0;
  for (let s1 = t[0] + 3; s1 <= t[t.length - 1] + 0.01; s1 += 1) {
    let m = t.findIndex(q => q > s1); if (m < 0) m = t.length; if (m < 200) continue;
    const rr = core.countAccel(t.slice(0, m), sl(a, m));
    for (const q of rr.skipTimes) if (q > lastT + 0.15 && q <= t[m - 1] - 4) { committed.push(q); lastT = q; }
    shown = committed.length + rr.skipTimes.filter(q => q > lastT + 0.15).length;
    const done = r.skipTimes.filter(q => q <= t[m - 1]).length; ahead = Math.max(ahead, shown - done); off += Math.abs(shown - done); n++;
  }
  // skips are timed mid-jump, a moment before the landing, so the screen can be a skip or two "early"
  const pass = r.skips === d.skips && shown === d.skips && ahead <= 3 && off / n <= 1;
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${("real: " + f).padEnd(44)}        : counted ${r.skips}, live screen ended on ${shown}, truth ${d.skips}, avg off ${(off / n).toFixed(1)}, most ahead ${ahead}`);
}
// a long session: 40 minutes, ~5,000 skips with rests
const plan = []; for (let i = 0; i < 25; i++) plan.push(["jump", 200, 115 + (i % 4) * 8], ["rest", 25 + (i % 3) * 10], ...(i % 5 === 4 ? [["walk", 8]] : []));
const w = workout(plan, 7), t0 = Date.now(), r = core.countAccel(w.t, w.a);
const pass = Math.abs(r.skips - w.truth) / w.truth < 0.005; ok &&= pass;
console.log(`${pass ? "ok  " : "FAIL"} ${"long session".padEnd(44)}        : counted ${r.skips}, truth ${w.truth} (${((w.t.at(-1)) / 60).toFixed(0)} min, counted in ${Date.now() - t0} ms)`);
process.exit(ok ? 0 : 1);
