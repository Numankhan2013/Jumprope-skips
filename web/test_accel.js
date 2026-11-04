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
// a long session: 40 minutes, ~5,000 skips with rests
const plan = []; for (let i = 0; i < 25; i++) plan.push(["jump", 200, 115 + (i % 4) * 8], ["rest", 25 + (i % 3) * 10], ...(i % 5 === 4 ? [["walk", 8]] : []));
const w = workout(plan, 7), t0 = Date.now(), r = core.countAccel(w.t, w.a);
const pass = Math.abs(r.skips - w.truth) / w.truth < 0.005; ok &&= pass;
console.log(`${pass ? "ok  " : "FAIL"} ${"long session".padEnd(44)}        : counted ${r.skips}, truth ${w.truth} (${((w.t.at(-1)) / 60).toFixed(0)} min, counted in ${Date.now() - t0} ms)`);
process.exit(ok ? 0 : 1);
