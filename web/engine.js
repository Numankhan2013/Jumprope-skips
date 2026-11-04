// Skip Count engine (browser main thread): turns a video file — or a live
// camera — into a counted result. Heavy work runs on a pool of workers:
//   decoder (hardware) → worker: shrink frame to 160 px grayscale
//                      → worker: compare with the previous frame (motion)
//                      → main: motion results in frame order → SkipCore.Tracker
(function (root) {
  "use strict";
  const W = 160; // analysis width in pixels (tested: 160 gives the best count)
  const params = new URLSearchParams(root.location ? root.location.search : "");
  const SHRINK_MODE = params.get("grab") || "luma"; // "canvas" forces the old path (benchmarking)
  let FAIL_AT = params.has("failat") ? parseFloat(params.get("failat")) : null; // testing only

  // ------------------------------------------------------------ worker pool
  async function scriptSource(id, file) {
    const el = document.getElementById(id);
    if (el && el.textContent.trim()) return el.textContent;
    return (await fetch(file)).text();
  }
  const WORKER_GLUE = `
let shrinker = null;
self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === "init") { shrinker = SkipShrink.makeShrinker(d.srcW, d.srcH, d.rot, d.W); return; }
    if (d.type === "shrink") {
      let g;
      try { g = await shrinker.frame(d.frame, d.mode); } finally { d.frame.close(); }
      self.postMessage({ type: "gray", i: d.i, g }, [g.buffer]);
      return;
    }
    if (d.type === "motion") {
      const m = SkipCore.frameMotion(new Uint8Array(d.prev), new Uint8Array(d.cur), d.w, d.h);
      self.postMessage({ type: "motion", i: d.i, vy: m.vy, vx: m.vx, frac: m.frac, span: m.span });
    }
  } catch (err) { self.postMessage({ type: "error", message: String(err && err.message || err) }); }
};`;

  class Pool {
    static async create() {
      const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
      let workers = [];
      try {
        const src = [await scriptSource("skipcore", "core.js"), await scriptSource("skipshrink", "shrink.js"), WORKER_GLUE].join("\n");
        const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        workers = Array.from({ length: n }, () => new Worker(url));
        URL.revokeObjectURL(url);
      } catch (e) { console.warn("Workers unavailable, using one core:", e); workers = []; }
      return new Pool(workers);
    }
    constructor(workers) {
      this.workers = workers; this.tracker = null; this.shrinker = null; this.geom = null;
      this.next = 0;                 // next frame index to hand out
      this.ts = new Map();           // frame index → time
      this.grays = new Map();        // shrunk frames waiting for their turn
      this.motionNext = 0;           // next frame index to send for motion
      this.prevGray = null;
      this.done = new Map();         // motion results waiting to go to the tracker in order
      this.trackNext = 0;
      this.inFlight = 0; this.wake = null; this.failed = null; this.rr = 0;
      for (const wk of workers) wk.onmessage = (e) => this.onMessage(e.data);
    }
    get size() { return Math.max(1, this.workers.length); }
    setGeometry(srcW, srcH, rot) {
      this.shrinker = SkipShrink.makeShrinker(srcW, srcH, rot, W);
      this.geom = { w: this.shrinker.w, h: this.shrinker.h };
      this.tracker = new SkipCore.Tracker(this.geom.w, this.geom.h);
      for (const wk of this.workers) wk.postMessage({ type: "init", srcW, srcH, rot, W });
    }
    pickWorker() { return this.workers[this.rr++ % this.workers.length]; }
    poke() { if (this.wake) { const w = this.wake; this.wake = null; w(); } }
    onMessage(d) {
      if (d.type === "error") { this.failed = new Error(d.message); this.poke(); return; }
      this.inFlight--;
      if (d.type === "gray") this.grays.set(d.i, d.g);
      else this.done.set(d.i, d);
      this.pump();
    }
    // a decoded VideoFrame (ownership passes to the pool)
    async pushFrame(frame, t) {
      const i = this.next++; this.ts.set(i, t);
      if (!this.workers.length) { const g = await this.shrinker.frame(frame, SHRINK_MODE); frame.close(); this.grays.set(i, g); this.pump(); return; }
      this.inFlight++;
      this.pickWorker().postMessage({ type: "shrink", i, frame, mode: SHRINK_MODE }, [frame]);
    }
    // an already-shrunk frame (playback / camera fallback)
    pushGray(g, t) { const i = this.next++; this.ts.set(i, t); this.grays.set(i, g); this.pump(); }
    pump() {
      // send consecutive pairs for motion as soon as both frames are shrunk
      while (this.grays.has(this.motionNext)) {
        const i = this.motionNext++, g = this.grays.get(i); this.grays.delete(i);
        if (!this.prevGray) this.done.set(i, { vy: 0, vx: 0, frac: 0 });
        else if (!this.workers.length) this.done.set(i, SkipCore.frameMotion(this.prevGray, g, this.geom.w, this.geom.h));
        else {
          const cur = g.slice(); this.inFlight++;
          this.pickWorker().postMessage({ type: "motion", i, prev: this.prevGray.buffer, cur: cur.buffer, w: this.geom.w, h: this.geom.h }, [this.prevGray.buffer, cur.buffer]);
        }
        this.prevGray = g;
      }
      while (this.done.has(this.trackNext)) {
        const i = this.trackNext++; this.tracker.pushMotion(this.done.get(i), this.ts.get(i));
        this.done.delete(i); this.ts.delete(i);
      }
      this.poke();
    }
    get processed() { return this.trackNext; }
    // Everything needed to carry on later. Call when idle (after below(0)).
    snapshot() {
      const T = this.tracker;
      return { n: this.trackNext, w: this.geom.w, h: this.geom.h, prevGray: this.prevGray ? this.prevGray.slice() : null,
        ts: Float64Array.from(T.ts), vy: Float32Array.from(T.vy), vx: Float32Array.from(T.vx),
        valid: Uint8Array.from(T.valid, v => v ? 1 : 0), spans: Float32Array.from(T.spans) };
    }
    restore(c) {
      const T = this.tracker;
      T.ts = Array.from(c.ts); T.vy = Array.from(c.vy); T.vx = Array.from(c.vx); T.valid = Array.from(c.valid, v => !!v); T.spans = Array.from(c.spans);
      this.next = this.motionNext = this.trackNext = c.n; this.prevGray = c.prevGray ? new Uint8Array(c.prevGray) : null;
    }
    async below(k) { while (this.inFlight > k) { if (this.failed) throw this.failed; await new Promise(r => this.wake = r); } if (this.failed) throw this.failed; }
    async finish() { await this.below(0); this.pump(); this.workers.forEach(w => w.terminate()); return this.tracker; }
    stop() { this.workers.forEach(w => w.terminate()); }
  }

  // ------------------------------------------------------------ checkpoints (survive a reload)
  // Saved in IndexedDB under the file's name + size + date, so picking the same
  // video again continues where it stopped instead of starting over.
  const idb = (() => {
    let dbp = null;
    const open = () => dbp ||= new Promise((res, rej) => { const r = indexedDB.open("skipcount", 1); r.onupgradeneeded = () => r.result.createObjectStore("checkpoints"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const tx = async (mode, f) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("checkpoints", mode), q = f(t.objectStore("checkpoints")); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
    return {
      get: k => tx("readonly", st => st.get(k)).catch(() => null),
      put: (k, v) => tx("readwrite", st => st.put(v, k)).catch(() => null),
      del: k => tx("readwrite", st => st.delete(k)).catch(() => null),
    };
  })();
  const fileKey = f => `v1|${f.name}|${f.size}|${f.lastModified}`;

  // Resolves when the page is visible again (the screen is back on).
  const whenVisible = () => document.visibilityState === "visible" ? Promise.resolve() : new Promise(r => {
    const h = () => { if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", h); r(); } };
    document.addEventListener("visibilitychange", h);
  });

  // ------------------------------------------------------------ fast path: WebCodecs + mp4box
  // mp4box only reads the file's index; frames are then read straight from the
  // file by offset, so decoding can restart at any keyframe (after the screen
  // turned off and the browser took the hardware decoder away, or after a reload).
  async function decodeWebCodecs(file, pool, onProgress, opts = {}) {
    if (!("VideoDecoder" in root) || typeof MP4Box === "undefined") throw new Error("no webcodecs");
    const mp4 = MP4Box.createFile();
    let info = null, perr = null;
    mp4.onReady = i => { info = i; }; mp4.onError = e => { perr = e; };
    for (let off = 0; !info && !perr && off < file.size;) {
      const buf = await file.slice(off, off + (4 << 20)).arrayBuffer(); buf.fileStart = off;
      const next = mp4.appendBuffer(buf);
      off = (typeof next === "number" && next > off) ? next : off + buf.byteLength; // jump over media data to the index
    }
    if (!info) throw new Error(perr ? String(perr) : "Couldn't read this video file.");
    const track = info.videoTracks[0]; if (!track) throw new Error("No video track in this file.");
    const trak = mp4.getTrackById(track.id), samples = trak.samples, total = samples.length;
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    let description;
    const box = entry.avcC || entry.hvcC;
    if (box) { const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); box.write(ds); description = new Uint8Array(ds.buffer, 8); }
    const config = { codec: track.codec.startsWith("vp08") ? "vp8" : track.codec, codedWidth: track.video.width, codedHeight: track.video.height, optimizeForLatency: true };
    if (description) config.description = description;
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error("decoder unsupported: " + track.codec);
    const m = track.matrix || [65536, 0, 0, 0, 65536, 0, 0, 0, 0x40000000];
    pool.setGeometry(track.video.width, track.video.height, Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI));
    const duration = track.movie_duration / track.movie_timescale || track.duration / track.timescale;
    const fps = total / duration, decimate = Math.max(1, Math.round(fps / 30)), fpsOut = fps / decimate;
    const timeOf = sm => sm.cts / sm.timescale;

    // carry on from a saved checkpoint?
    let lastT = -Infinity; // newest frame time handed to the pool
    const key = fileKey(file);
    if (opts.resume !== false) {
      const c = await idb.get(key);
      if (c && c.w === pool.geom.w && c.h === pool.geom.h && c.n > 0) { pool.restore(c); lastT = c.ts[c.ts.length - 1]; opts.onResume?.(lastT / duration); }
    }
    // first sample (decode order) we still need, backed up to its keyframe
    const startIndex = t => {
      let i = samples.findIndex(sm => timeOf(sm) > t + 1e-6); if (i < 0) return total;
      // frames up to a few later samples can display earlier (B-frames): back up to the keyframe before
      while (i > 0 && !samples[i].is_sync) i--;
      return i;
    };

    let decoded = 0, failed = null, decoder = null, next = startIndex(lastT), restarts = 0;
    const done = () => Math.min(1, Math.max(0, lastT) / duration);
    const makeDecoder = () => {
      failed = null;
      const d = new VideoDecoder({
        output: frame => {
          decoded++;
          const t = frame.timestamp / 1e6;
          // already processed (we restarted at an earlier keyframe), or thinned out (>30 fps)
          if (t <= lastT + 1e-6 || (decimate > 1 && Math.round(t * fps) % decimate)) { frame.close(); return; }
          lastT = t; pool.pushFrame(frame, t);
        },
        error: e => { failed = e || new Error("decoder error"); }
      });
      d.configure(config);
      return d;
    };
    decoder = makeDecoder();

    const started = performance.now(), startDone = done();
    let lastSave = performance.now();
    const checkpoint = async () => { await pool.below(0); await idb.put(key, pool.snapshot()); lastSave = performance.now(); };
    const onHide = () => { if (document.visibilityState === "hidden") checkpoint().catch(() => {}); };
    document.addEventListener("visibilitychange", onHide);
    try {
      while (next < total) {
        if (failed || decoder.state === "closed") {
          // The browser took the decoder away (screen off / app in background) or it hiccupped:
          // wait until we're visible, then restart from the keyframe before the next frame we need.
          if (++restarts > 50) throw failed || new Error("decoder keeps failing");
          await whenVisible();
          try { decoder.close(); } catch {}
          await pool.below(0);
          decoder = makeDecoder(); next = startIndex(lastT);
          continue;
        }
        // read a run of consecutive samples in one go (up to ~6 MB)
        let j = next; const first = samples[next].offset;
        while (j < total && j - next < 120 && samples[j].offset + samples[j].size - first <= (6 << 20) && (j === next || samples[j].offset >= samples[j - 1].offset)) j++;
        const lastS = samples[j - 1], buf = new Uint8Array(await file.slice(first, lastS.offset + lastS.size).arrayBuffer());
        for (let i = next; i < j && !failed; i++) {
          const sm = samples[i];
          while (decoder.decodeQueueSize > 16 && !failed) await new Promise(r => setTimeout(r, 0));
          if (failed) break;
          decoder.decode(new EncodedVideoChunk({ type: sm.is_sync ? "key" : "delta", timestamp: 1e6 * sm.cts / sm.timescale, duration: 1e6 * sm.duration / sm.timescale, data: buf.subarray(sm.offset - first, sm.offset - first + sm.size) }));
          next = i + 1;
        }
        await pool.below(pool.size * 3); // keep workers busy, but don't let decoding run away
        if (FAIL_AT != null && done() >= FAIL_AT) { FAIL_AT = null; try { decoder.close(); } catch {} } // test hook: simulate the browser reclaiming the decoder
        const f = done(), el = (performance.now() - started) / 1000, rate = (f - startDone) / Math.max(el, 1e-3);
        onProgress(f, f - startDone > 0.02 ? (1 - f) / rate : null);
        if (performance.now() - lastSave > 5000) await checkpoint(); // often: a locked phone can freeze the page without warning
      }
      await decoder.flush().catch(e => { failed = e; });
      if (failed && lastT < duration - 1) throw failed;
    } finally {
      document.removeEventListener("visibilitychange", onHide);
      try { decoder.close(); } catch {}
    }
    if (decoded < 10 && lastT < 1) throw new Error("decoded too few frames");
    return { fps: fpsOut, duration, restarts, key, created: info.created && info.created.getTime() > 86400000 * 365 * 5 ? info.created : null };
  }

  // ------------------------------------------------------------ fallback: play the video
  async function decodePlayback(file, pool, onProgress) {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = URL.createObjectURL(file);
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("This browser can't open that video.")); });
    pool.setGeometry(v.videoWidth, v.videoHeight, 0);
    const shr = pool.shrinker, dur = v.duration, rvfc = "requestVideoFrameCallback" in v;
    await new Promise((res, rej) => {
      let lastT = -1;
      const step = (now, meta) => {
        const t = meta ? meta.mediaTime : v.currentTime;
        if (t > lastT + 1e-4) { lastT = t; pool.pushGray(shr.element(v), t); }
        onProgress(Math.min(1, t / dur), dur - t);
        if (v.ended) return res();
        rvfc ? v.requestVideoFrameCallback(step) : requestAnimationFrame(() => step());
      };
      v.onended = () => res();
      v.play().then(() => rvfc ? v.requestVideoFrameCallback(step) : requestAnimationFrame(() => step()), rej);
    });
    URL.revokeObjectURL(v.src);
    return { fps: 30, duration: dur, created: null };
  }

  // ------------------------------------------------------------ count
  function countFrom(tracker) {
    const s = tracker.signal();
    const r = SkipCore.countSkips(s.t, s.y, s.fps, { horizontal: s.x, valid: s.valid });
    r.skipTimes = r.skipTimes.map(x => x + s.offset); // back to video time
    for (const st of r.sets) { st.start += s.offset; st.end += s.offset; }
    r.fps = s.fps; r.bodySize = s.bodySize; r.offset = s.offset;
    return r;
  }

  async function analyse(file, { onProgress = () => {}, onResume } = {}) {
    const t0 = performance.now();
    let via = "webcodecs", meta, pool = await Pool.create();
    try { meta = await decodeWebCodecs(file, pool, onProgress, { onResume }); }
    catch (e) {
      console.warn("Fast path unavailable, using playback:", e);
      pool.stop(); pool = await Pool.create(); via = "playback";
      meta = await decodePlayback(file, pool, onProgress);
    }
    const tracker = await pool.finish();
    if (!tracker || tracker.ts.length < 10) throw new Error("No frames could be read from this video.");
    const result = countFrom(tracker);
    if (meta.key) idb.del(meta.key);
    return { result, via, restarts: meta.restarts || 0, frames: tracker.ts.length, seconds: (performance.now() - t0) / 1000, recordedAt: meta.created || new Date(file.lastModified || Date.now()), reordered: meta.reordered || 0 };
  }

    // Screen wake lock that comes back after the screen was off or the app was switched.
  function keepAwake() {
    let lock = null, on = true;
    const get = async () => { if (!on || document.visibilityState !== "visible") return; try { lock = await navigator.wakeLock?.request("screen"); } catch {} };
    const vis = () => { if (document.visibilityState === "visible") get(); };
    document.addEventListener("visibilitychange", vis); get();
    return { release() { on = false; document.removeEventListener("visibilitychange", vis); try { lock?.release(); } catch {} } };
  }

  root.SkipEngine = { analyse, Pool, countFrom, keepAwake, idb, whenVisible, W };
})(typeof self !== "undefined" ? self : this);
