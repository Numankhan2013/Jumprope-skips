// Jump-rope skip counter: the engine (runs in the browser and in Node).
// A port of jumprope_counter/counter.py + calories.py, with a lightweight
// block-matching motion tracker standing in for OpenCV's optical flow.
(function (root) {
  "use strict";

  // ------------------------------------------------------------- motion
  // Block matching between two grayscale frames (Uint8Array, w*h).
  // Returns the median motion of the blocks that moved, and the fraction of
  // textured blocks that moved (high fraction = the camera itself moved).
  const B = 8, R = 4, K = 2 * R + 1;

  // Candidate shifts, nearest first (ties in the original dy-major order). With
  // "only replace on strictly better", this reproduces the exhaustive search's
  // tie-break exactly (smallest shift wins), while letting us stop early.
  const OFFS = (() => {
    const o = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) o.push([dy, dx, dx * dx + dy * dy, o.length]);
    o.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
    return Int8Array.from(o.flatMap(v => [v[0], v[1]]));
  })();

  // Sum of absolute differences for one shift; gives up (returns >= limit) as
  // soon as the running total can no longer beat `limit`.
  function sad(prev, cur, w, bx, by, dx, dy, limit) {
    let s = 0;
    for (let y = 0; y < B; y++) {
      const co = (by + y) * w + bx, po = co - dy * w - dx;
      for (let x = 0; x < B; x++) { const d = cur[co + x] - prev[po + x]; s += d < 0 ? -d : d; }
      if (s >= limit) return s;
    }
    return s;
  }

  // Best shift for one block, with sub-pixel refinement. Results land in the
  // module-level fields below (no allocation per block).
  let _fy = 0, _fx = 0, _best = 0, _bdx = 0, _bdy = 0;
  function searchBlock(prev, cur, w, bx, by) {
    let best = Infinity, bdx = 0, bdy = 0;
    for (let i = 0; i < OFFS.length; i += 2) {
      const dy = OFFS[i], dx = OFFS[i + 1];
      const s = sad(prev, cur, w, bx, by, dx, dy, best);
      if (s < best) { best = s; bdx = dx; bdy = dy; if (s === 0) break; }
    }
    let fy = bdy, fx = bdx;
    if (bdy > -R && bdy < R) { const a = sad(prev, cur, w, bx, by, bdx, bdy - 1, Infinity), c = sad(prev, cur, w, bx, by, bdx, bdy + 1, Infinity), d = a - 2 * best + c; if (d > 0) fy += 0.5 * (a - c) / d; }
    if (bdx > -R && bdx < R) { const a = sad(prev, cur, w, bx, by, bdx - 1, bdy, Infinity), c = sad(prev, cur, w, bx, by, bdx + 1, bdy, Infinity), d = a - 2 * best + c; if (d > 0) fx += 0.5 * (a - c) / d; }
    _fy = fy; _fx = fx; _best = best; _bdx = bdx; _bdy = bdy;
  }

  function isTextured(cur, w, bx, by) { // flat blocks (sky, plain wall) can't be matched
    let mn = 255, mx = 0;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const v = cur[(by + y) * w + bx + x]; if (v < mn) mn = v; if (v > mx) mx = v; }
    return mx - mn >= 12;
  }

  // Background = top 20 % of the frame, plus the outer side strips in the upper
  // half. People skipping rarely fill those, so their motion is the camera's.
  const isBackground = (bx, by, w, h) => by + B <= 0.2 * h || ((bx + B <= 0.12 * w || bx >= 0.88 * w) && by + B <= 0.5 * h);

  function frameMotion(prev, cur, w, h) {
    // Pass 1: how did the background (= the camera) move?
    const gys = [], gxs = [];
    const blocks = [];
    for (let by = R; by + B + R <= h; by += B) for (let bx = R; bx + B + R <= w; bx += B) {
      if (!isTextured(cur, w, bx, by)) continue;
      blocks.push([bx, by]);
      if (isBackground(bx, by, w, h)) { searchBlock(prev, cur, w, bx, by); gys.push(_fy); gxs.push(_fx); }
    }
    let gy = 0, gx = 0;
    if (gys.length >= 6) { gy = median(gys); gx = median(gxs); }
    const camMoving = Math.hypot(gx, gy) >= 0.3;
    const ry = Math.round(gy), rx = Math.round(gx);

    // Pass 2: blocks that moved differently from the camera are you.
    const vys = [], vxs = [], rows = [];
    for (const [bx, by] of blocks) {
      if (!camMoving) { // fast path: a block that didn't change can't have moved
        let z = 0;
        for (let y = 0; y < B; y++) { const o = (by + y) * w + bx; for (let x = 0; x < B; x++) { const d = cur[o + x] - prev[o + x]; z += d < 0 ? -d : d; } }
        if (z < 2 * B * B) continue;
      }
      searchBlock(prev, cur, w, bx, by);
      // must match clearly better than "moved with the camera"
      if (Math.abs(rx) <= R && Math.abs(ry) <= R) {
        const camSad = (rx === _bdx && ry === _bdy) ? _best : sad(prev, cur, w, bx, by, rx, ry, _best + 2 * B * B);
        if (camSad - _best < 2 * B * B) continue;
      }
      const dy = _fy - gy, dx = _fx - gx;
      if (Math.hypot(dx, dy) < 0.3) continue;
      vys.push(dy); vxs.push(dx); rows.push(by);
    }
    // If most of the picture moves in different ways (phone being picked up,
    // turned, zoomed), nothing there is usable.
    const frac = blocks.length ? vys.length / blocks.length : 0;
    // How tall is the moving body in the frame? (to warn when filmed from too far)
    const span = vys.length >= 6 ? (percentile(rows, 95) - percentile(rows, 5) + B) / h : NaN;
    return { vy: vys.length >= 3 ? median(vys) : 0, vx: vxs.length >= 3 ? median(vxs) : 0, frac, span, camY: gy, camX: gx };
  }

  // ------------------------------------------------------------- helpers
  function median(a) { const s = Float64Array.from(a).sort(); const n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); }
  function percentile(a, q) { // numpy 'linear'
    const s = Float64Array.from(a).sort(); if (!s.length) return NaN;
    const pos = (s.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  function uniformFilter(x, size) { // scipy.ndimage.uniform_filter1d, mode='nearest'
    const n = x.length, out = new Float64Array(n), left = Math.floor(size / 2);
    const get = i => x[i < 0 ? 0 : i >= n ? n - 1 : i];
    let s = 0;
    for (let k = 0; k < size; k++) s += get(k - left);
    for (let i = 0; i < n; i++) { out[i] = s / size; s += get(i + size - left) - get(i - left); }
    return out;
  }
  // 2nd-order Butterworth biquads (bilinear transform, same as scipy.signal.butter(2, f, ...))
  function biquad(fc, fs, type) {
    const k = Math.tan(Math.PI * fc / fs), q = Math.SQRT2, norm = 1 / (1 + q * k + k * k);
    if (type === "low") return [k * k * norm, 2 * k * k * norm, k * k * norm, 2 * (k * k - 1) * norm, (1 - q * k + k * k) * norm];
    return [norm, -2 * norm, norm, 2 * (k * k - 1) * norm, (1 - q * k + k * k) * norm];
  }
  function lfilter(c, x) { // with steady-state initial conditions (like sosfilt with zi * x0)
    const [b0, b1, b2, a1, a2] = c, n = x.length, y = new Float64Array(n);
    // steady state for constant input x0
    const g = (b0 + b1 + b2) / (1 + a1 + a2), x0 = x[0];
    let z1 = x0 * (g - b0), z2 = x0 * (b2 - a2 * g);
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = b0 * xi + z1;
      z1 = b1 * xi - a1 * yi + z2; z2 = b2 * xi - a2 * yi; y[i] = yi;
    }
    return y;
  }
  function filtfilt(cs, x) { // forward-backward with odd padding (scipy default padlen = 3*(2*ntaps-1)... approximated)
    const pad = Math.min(x.length - 1, 3 * 3 * cs.length);
    const n = x.length, ext = new Float64Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) { ext[i] = 2 * x[0] - x[pad - i]; ext[n + pad + i] = 2 * x[n - 1] - x[n - 2 - i]; }
    ext.set(x, pad);
    let y = ext;
    for (const c of cs) y = lfilter(c, y);
    y = y.reverse();
    for (const c of cs) y = lfilter(c, y);
    y = y.reverse();
    return y.slice(pad, pad + n);
  }
  function runs(mask) { const r = []; let s = -1; for (let i = 0; i <= mask.length; i++) { const v = i < mask.length && mask[i]; if (v && s < 0) s = i; if (!v && s >= 0) { r.push([s, i]); s = -1; } } return r; }
  function fillGaps(y) {
    const n = y.length, out = Float64Array.from(y), ok = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(y[i])) ok.push(i);
    if (ok.length < 2) throw new Error("Could not find you in the video.");
    for (let i = 0, j = 0; i < n; i++) {
      if (Number.isFinite(y[i])) continue;
      while (j < ok.length - 1 && ok[j + 1] < i) j++;
      if (i < ok[0]) out[i] = y[ok[0]]; else if (i > ok[ok.length - 1]) out[i] = y[ok[ok.length - 1]];
      else { const a = ok[j], b = ok[j + 1]; out[i] = y[a] + (y[b] - y[a]) * (i - a) / (b - a); }
    }
    return out;
  }
  // scipy.signal.find_peaks(x, distance=d, prominence=0)
  function findPeaks(x, distance) {
    const n = x.length; let peaks = [];
    for (let i = 1; i < n - 1; i++) {
      if (x[i] > x[i - 1]) { let j = i; while (j < n - 1 && x[j + 1] === x[i]) j++; if (j < n - 1 && x[j + 1] < x[i]) { peaks.push((i + j) >> 1); } i = j; }
    }
    if (distance > 1 && peaks.length) {
      const keep = new Array(peaks.length).fill(true);
      const order = peaks.map((p, i) => i).sort((a, b) => x[peaks[a]] - x[peaks[b]]);
      for (let oi = order.length - 1; oi >= 0; oi--) {
        const j = order[oi]; if (!keep[j]) continue;
        for (let k = j - 1; k >= 0 && peaks[j] - peaks[k] < distance; k--) keep[k] = false;
        for (let k = j + 1; k < peaks.length && peaks[k] - peaks[j] < distance; k++) keep[k] = false;
      }
      peaks = peaks.filter((p, i) => keep[i]);
    }
    const prom = peaks.map(p => {
      let lmin = x[p], rmin = x[p];
      for (let i = p - 1; i >= 0 && x[i] <= x[p]; i--) if (x[i] < lmin) lmin = x[i];
      for (let i = p + 1; i < n && x[i] <= x[p]; i++) if (x[i] < rmin) rmin = x[i];
      return x[p] - Math.max(lmin, rmin);
    });
    return { peaks, prom };
  }

  // ------------------------------------------------------------- counting
  function countSkips(t, y, fps, opts = {}) {
    const o = Object.assign({ minHz: 0.8, maxHz: 5.0, minAmplitude: 0.012, relProminence: 0.45, mergeGap: 1.0,
      minSetSkips: 3, maxWalkSpeed: 0.8, typicalFraction: 0.4, edgeFraction: 0.62 }, opts);
    const n = t.length;
    if (n < fps * 2) throw new Error("Video is too short (need at least 2 seconds).");
    const total = t[n - 1] - t[0] + 1 / fps;
    const filled = fillGaps(y), med = median(filled);
    const up = filled.map(v => med - v);
    const hi = Math.min(o.maxHz, 0.45 * fps);
    const x = filtfilt([biquad(o.minHz, fps, "high"), biquad(hi, fps, "low")], up);

    const win = Math.max(3, Math.round(1.2 * fps));
    const env = uniformFilter(x.map(v => v * v), win).map(Math.sqrt);
    const floor = Math.max(o.minAmplitude, 0.15 * percentile(env, 95));
    const active = Array.from(env, v => v > floor);

    if (o.horizontal) {
      const xs = uniformFilter(fillGaps(o.horizontal), Math.max(3, Math.round(0.5 * fps)));
      const sp = new Float64Array(n);
      for (let i = 0; i < n; i++) sp[i] = Math.abs((i === 0 ? xs[1] - xs[0] : i === n - 1 ? xs[n - 1] - xs[n - 2] : (xs[i + 1] - xs[i - 1]) / 2)) * fps;
      const sps = uniformFilter(sp, win);
      for (let i = 0; i < n; i++) if (sps[i] >= o.maxWalkSpeed) active[i] = false;
    }
    if (o.valid) {
      const pad = Math.max(1, Math.round(0.3 * fps));
      const bad = o.valid.map(v => !v);
      for (let i = 0; i < n; i++) if (bad[i]) for (let k = Math.max(0, i - pad); k <= Math.min(n - 1, i + pad); k++) active[k] = false;
    }
    for (const [s, e] of runs(active.map(v => !v))) if (s > 0 && e < n && (e - s) / fps < o.mergeGap) for (let i = s; i < e; i++) active[i] = true;
    for (const [s, e] of runs(active)) if ((e - s) / fps < 1.0) for (let i = s; i < e; i++) active[i] = false;

    // cadence: median spacing of clear peaks in active stretches
    let cadence = 2.0;
    {
      const { peaks, prom } = findPeaks(x, Math.max(1, Math.floor(fps / o.maxHz)));
      const gaps = [];
      let last = -1;
      peaks.forEach((p, i) => {
        if (!active[p] || prom[i] < o.relProminence * Math.SQRT2 * env[p]) { last = -1; return; }
        if (last >= 0 && (p - last) / fps < 1 / o.minHz) gaps.push((p - last) / fps);
        last = p;
      });
      if (gaps.length >= 3) cadence = 1 / median(gaps);
    }

    const distance = Math.max(1, Math.floor(0.6 * fps / cadence));
    const fp = findPeaks(x, distance);
    let keep = fp.peaks.map((p, i) => active[p] && fp.prom[i] >= o.relProminence * Math.SQRT2 * env[p] && x[p] > 0);
    const kt = [], kp = [];
    fp.peaks.forEach((p, i) => { if (keep[i]) { kt.push(t[p]); kp.push(fp.prom[i]); } });
    fp.peaks.forEach((p, i) => {
      if (!keep[i]) return;
      const near = kp.filter((_, j) => Math.abs(kt[j] - t[p]) <= 15);
      if (fp.prom[i] < o.typicalFraction * percentile(near, 75)) keep[i] = false;
    });
    const peaks = fp.peaks.filter((p, i) => keep[i]);

    const period = 1 / cadence, trains = [];
    for (const p of peaks) {
      const tr = trains[trains.length - 1];
      let ok = tr && t[p] - t[tr[tr.length - 1]] <= 1.7 * period;
      if (ok) for (let i = tr[tr.length - 1]; i <= p; i++) if (!active[i]) { ok = false; break; }
      if (ok) tr.push(p); else trains.push([p]);
    }
    const sets = [], skipTimes = [];
    const half = Math.max(1, Math.round(0.25 * fps / cadence)), span = Math.max(1, Math.round(fps / cadence));
    const rawRise = p => {
      let j = Math.max(p - half, 0);
      for (let i = j; i <= Math.min(p + half, n - 1); i++) if (up[i] > up[j]) j = i;
      let l = up[j], r = up[j];
      for (let i = Math.max(j - span, 0); i <= j; i++) if (up[i] < l) l = up[i];
      for (let i = j; i <= Math.min(j + span, n - 1); i++) if (up[i] < r) r = up[i];
      return up[j] - Math.max(l, r);
    };
    for (let seg of trains) {
      if (seg.length >= o.minSetSkips) {
        const m = median(seg.map(rawRise));
        if (rawRise(seg[0]) < o.edgeFraction * m) seg = seg.slice(1);
        if (seg.length && rawRise(seg[seg.length - 1]) < o.edgeFraction * m) seg = seg.slice(0, -1);
      }
      if (seg.length < o.minSetSkips) continue;
      seg.forEach(p => skipTimes.push(t[p]));
      const start = Math.max(t[seg[0]] - period / 2, t[0]);
      const end = Math.min(t[seg[seg.length - 1]] + period / 2, t[n - 1] + 1 / fps);
      sets.push({ start, end, skips: seg.length });
    }
    const jumping = sets.reduce((a, s) => a + (s.end - s.start), 0);
    return { skips: skipTimes.length, skipTimes, sets, jumpingSeconds: jumping, totalSeconds: total,
      restSeconds: Math.max(total - jumping, 0), cadenceHz: cadence, filtered: x, active };
  }

  // ------------------------------------------------------------- calories
  function metForRate(spm) { const X = [0, 90, 110, 140], Y = [8.8, 8.8, 11.8, 12.3];
    if (spm >= X[3]) return Y[3]; for (let i = 0; i < 3; i++) if (spm <= X[i + 1]) return Y[i] + (Y[i + 1] - Y[i]) * (spm - X[i]) / (X[i + 1] - X[i]); }
  function mifflin(kg, cm, age, sex) { const b = 10 * kg + 6.25 * cm - 5 * age; return sex === "male" ? b + 5 : sex === "female" ? b - 161 : b - 78; }
  function calories(skips, jumpS, restS, kg, cm, age = 30, sex = null) {
    const rate = jumpS > 0 ? 60 * skips / jumpS : 0, met = skips ? metForRate(rate) : 0;
    const rmr = mifflin(kg, cm, age, sex), perMin = rmr / 1440;
    const jumping = met * perMin * jumpS / 60, rest = 2.0 * perMin * restS / 60, total = jumping + rest;
    return { met, rmr, rate, jumping, rest, total, net: total - perMin * (jumpS + restS) / 60, low: total * 0.85, high: total * 1.15 };
  }

  // ------------------------------------------------------------- driver
  // Feed grayscale frames one by one; call finish() for the result.
  class Tracker {
    constructor(w, h) { this.w = w; this.h = h; this.prev = null; this.vy = []; this.vx = []; this.valid = []; this.ts = []; this.spans = []; }
    push(gray, t) {
      let m = { vy: 0, vx: 0, frac: 0 };
      if (this.prev) m = frameMotion(this.prev, gray, this.w, this.h);
      this.prev = gray;
      this.pushMotion(m, t);
    }
    // Add a motion result computed elsewhere (e.g. by a worker), in frame order.
    pushMotion(m, t) {
      this.ts.push(t == null ? this.ts.length / 30 : t);
      this.vy.push(m.vy); this.vx.push(m.vx); this.valid.push(m.frac < 0.6);
      if (Number.isFinite(m.span) && m.frac < 0.6) this.spans.push(m.span);
    }
    // Positions on an even time grid. Frames that were skipped (slow playback)
    // are bridged by interpolation, so timing stays right.
    signal() {
      const unit = this.h / 9; // ~"torso lengths", matching the Python thresholds' scale
      const n = this.vy.length;
      let ay = 0, ax = 0; const py = new Float64Array(n), px = new Float64Array(n);
      for (let i = 0; i < n; i++) { ay += this.vy[i]; ax += this.vx[i]; py[i] = ay / unit; px[i] = ax / unit; }
      const ts = this.ts, dts = [];
      for (let i = 1; i < n; i++) if (ts[i] > ts[i - 1]) dts.push(ts[i] - ts[i - 1]);
      let fps = dts.length ? 1 / median(dts) : 30;
      fps = Math.min(Math.max(fps, 10), 60);
      if (fps > 45) fps /= Math.round(fps / 30);
      const t0 = ts[0], m = Math.max(2, Math.floor((ts[n - 1] - t0) * fps) + 1);
      const t = [], y = [], x = [], valid = [];
      for (let k = 0, j = 0; k < m; k++) {
        const tk = t0 + k / fps;
        while (j < n - 2 && ts[j + 1] <= tk) j++;
        const span = ts[j + 1] - ts[j], f = span > 0 ? Math.min(1, Math.max(0, (tk - ts[j]) / span)) : 0;
        t.push(tk - t0); y.push(py[j] + (py[j + 1] - py[j]) * f); x.push(px[j] + (px[j + 1] - px[j]) * f);
        valid.push(this.valid[j] && this.valid[Math.min(j + 1, n - 1)]);
      }
      // typical height of the moving body as a share of the frame (1 = fills it)
      const bodySize = this.spans.length ? percentile(this.spans, 75) : NaN;
      return { t, y, x, valid, fps, offset: t0, bodySize };
    }
  }

  // ------------------------------------------------------------- pocket mode
  // Count from the phone's accelerometer (phone in a pocket / waistband / armband).
  // Each skip is one cycle: near weightless in the air, a sharp spike on landing.
  // t: seconds, a: |acceleration incl. gravity| in m/s², at whatever rate the
  // sensor delivers. Resampled to an even 50 Hz, then counted like the video
  // signal with thresholds in m/s²: walking (~1-2 m/s² RMS at the hip) stays
  // below the floor, skipping (~4-10 m/s²) is well above it.
  const ACCEL_HZ = 50;
  function resample(t, a, hz) {
    const n = t.length, t0 = t[0], m = Math.max(2, Math.floor((t[n - 1] - t0) * hz) + 1);
    const tu = new Float64Array(m), au = new Float64Array(m);
    for (let k = 0, j = 0; k < m; k++) {
      const tk = t0 + k / hz; while (j < n - 2 && t[j + 1] <= tk) j++;
      const span = t[j + 1] - t[j], f = span > 0 ? Math.min(1, Math.max(0, (tk - t[j]) / span)) : 0;
      // a gap (screen was off) is held flat, so it reads as "not skipping"
      au[k] = span > 0.5 ? a[j] : a[j] + (a[j + 1] - a[j]) * f; tu[k] = tk - t0;
    }
    return { t: tu, a: au, offset: t0 };
  }
  // a: either |a| per sample (number array), or the three axes {x, y, z} of
  // accelerationIncludingGravity. With axes we work out which way is down (gravity,
  // averaged over ~2 s) and use only the vertical part: that makes it work in any
  // orientation and on an arm, where the rope-turning circle would otherwise add a
  // second bump per skip to the total.
  function countAccel(t, a, opts = {}) {
    if (t.length < 2 * ACCEL_HZ) throw new Error("That was too short to count.");
    const G = 9.81;
    let r0, v;
    if (Array.isArray(a) || ArrayBuffer.isView(a)) { r0 = resample(t, a, ACCEL_HZ); v = r0.a; }
    else {
      const rx = resample(t, a.x, ACCEL_HZ), ry = resample(t, a.y, ACCEL_HZ), rz = resample(t, a.z, ACCEL_HZ);
      r0 = rx;
      const lp = c => filtfilt([biquad(0.4, ACCEL_HZ, "low")], c); // gravity: the slow part of each axis
      const gx = lp(rx.a), gy = lp(ry.a), gz = lp(rz.a);
      v = new Float64Array(rx.a.length);
      for (let i = 0; i < v.length; i++) {
        const n = Math.hypot(gx[i], gy[i], gz[i]) || 1;
        v[i] = (rx.a[i] * gx[i] + ry.a[i] * gy[i] + rz.a[i] * gz[i]) / n; // vertical specific force
      }
    }
    // Count the moments in the air. A phone that leaves the ground with you feels much
    // lighter than 1 g for as long as you're up (it's falling with you). Walking, standing,
    // landing, a loose phone rattling, and the arm's rope-turning swing only ever push the
    // reading above that, so "light stretches" are skips, wherever the phone is worn.
    const n = v.length, sm = filtfilt([biquad(8, ACCEL_HZ, "low")], Array.from(v)); // smooth out sensor jitter
    const enter = opts.enter ?? 0.5 * G, exit = opts.exit ?? 0.72 * G, minDur = opts.minAir ?? 0.04;
    let air = [], inAir = false, s0 = 0, lo = Infinity, loAt = 0;
    for (let i = 0; i < n; i++) {
      const x = sm[i];
      if (!inAir && x < enter) { inAir = true; s0 = i; lo = x; loAt = i; }
      else if (inAir) {
        if (x < lo) { lo = x; loAt = i; }
        if (x > exit || i === n - 1) { inAir = false; if ((i - s0) / ACCEL_HZ >= minDur) air.push({ a: s0, b: i, at: loAt, lo }); }
      }
    }
    // one jump can show as two light stretches if the phone bumps something mid-air: merge close ones
    const merged = [];
    for (const e of air) {
      const last = merged[merged.length - 1];
      if (last && (e.a - last.b) / ACCEL_HZ < 0.18) { last.b = e.b; if (e.lo < last.lo) { last.lo = e.lo; last.at = e.at; } }
      else merged.push({ ...e });
    }
    // Second witness, for armbands: the landing jolt. On an arm, the rope-turning swing pushes
    // up while you're in the air and can hide the light moment, but every landing is still a
    // sudden rise in force, while arm swings are smooth. A jolt only stands in for a jump when
    // no light stretch was seen just before it (so nothing is counted twice), it's steep, and
    // the phone felt at least somewhat light beforehand (walking never does both).
    const smJ = filtfilt([biquad(12, ACCEL_HZ, "low")], Array.from(v));
    const jerk = new Float64Array(n);
    for (let i = 2; i < n; i++) jerk[i] = (smJ[i] - smJ[i - 2]) * ACCEL_HZ / 2;
    const jFloor = opts.jerkFloor ?? 140, partLight = opts.partLight ?? 0.85 * G; // middle of the range that is exact in simulation (120-160)
    const airEnds = merged.map(e => e.b);
    let lastJolt = -Infinity, ai = 0;
    for (let i = 3; i < n - 1; i++) {
      if (jerk[i] < jFloor || jerk[i] < jerk[i - 1] || jerk[i] < jerk[i + 1]) continue;
      if ((i - lastJolt) / ACCEL_HZ < 0.25) continue;                      // a rattling phone: one landing
      while (ai < airEnds.length && airEnds[ai] < i - Math.round(0.35 * ACCEL_HZ)) ai++;
      const covered = ai < airEnds.length && merged[ai].a <= i + 2;         // a light stretch already counted this jump
      lastJolt = i;
      if (covered) continue;
      let mn = Infinity; for (let k = Math.max(0, i - Math.round(0.3 * ACCEL_HZ)); k < i; k++) if (sm[k] < mn) mn = sm[k];
      if (mn < partLight) merged.push({ a: i - 2, b: i - 1, at: i - 2, lo: mn, jolt: true });
    }
    merged.sort((p, q) => p.at - q.at);

    // sets: jumps in a steady rhythm; a pause of more than ~1.7 beats (or 1.2 s) ends a set
    const times = merged.map(e => e.at / ACCEL_HZ), gaps = [];
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] < 1.2) gaps.push(times[i] - times[i - 1]);
    const beat = gaps.length >= 3 ? median(gaps) : 0.5, maxGap = Math.max(1.0, 2.6 * beat);
    const minSet = opts.minSetSkips ?? 3, sets = [], skipTimes = [];
    let cur = [], filled = 0;
    const close = () => {
      if (cur.length >= minSet) {
        sets.push({ start: Math.max(0, cur[0] - beat / 2), end: Math.min(n / ACCEL_HZ, cur[cur.length - 1] + beat / 2), skips: cur.length });
        skipTimes.push(...cur);
      }
      cur = [];
    };
    for (const t1 of times) {
      const prev = cur[cur.length - 1];
      if (cur.length && t1 - prev > maxGap) close();
      else if (cur.length && t1 - prev > 1.6 * beat && opts.fillGaps !== false) { cur.push((prev + t1) / 2); filled++; } // skipping is steady: a two-beat gap inside a set is one jump the sensor missed
      cur.push(t1);
    }
    close();
    const total = n / ACCEL_HZ, jumping = sets.reduce((q, x) => q + x.end - x.start, 0);
    // chart signal: how much lighter than 1 g, centred
    const filtered = Float64Array.from(sm, x => (G - x) / G);
    const r = { skips: skipTimes.length, skipTimes, sets, jumpingSeconds: jumping, totalSeconds: total, restSeconds: Math.max(0, total - jumping),
      cadenceHz: 1 / beat, filtered, active: Array.from(sm, () => true), filled };

    r.skipTimes = r.skipTimes.map(x => x + r0.offset);
    for (const st of r.sets) { st.start += r0.offset; st.end += r0.offset; }
    r.fps = ACCEL_HZ; r.offset = r0.offset; r.bodySize = 1;
    return r;
  }

  const api = { frameMotion, countSkips, countAccel, calories, metForRate, mifflin, Tracker, _: { findPeaks, filtfilt, biquad, percentile, uniformFilter, median } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SkipCore = api;
})(typeof self !== "undefined" ? self : this);
