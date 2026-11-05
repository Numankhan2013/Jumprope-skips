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
// a long session: 40 minutes, ~5,000 skips with rests
const plan = []; for (let i = 0; i < 25; i++) plan.push(["jump", 200, 115 + (i % 4) * 8], ["rest", 25 + (i % 3) * 10], ...(i % 5 === 4 ? [["walk", 8]] : []));
const w = workout(plan, 7), t0 = Date.now(), r = core.countAccel(w.t, w.a);
const pass = Math.abs(r.skips - w.truth) / w.truth < 0.005; ok &&= pass;
console.log(`${pass ? "ok  " : "FAIL"} ${"long session".padEnd(44)}        : counted ${r.skips}, truth ${w.truth} (${((w.t.at(-1)) / 60).toFixed(0)} min, counted in ${Date.now() - t0} ms)`);
process.exit(ok ? 0 : 1);
