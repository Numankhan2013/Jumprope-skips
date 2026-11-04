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
    async below(k) { while (this.inFlight > k) { if (this.failed) throw this.failed; await new Promise(r => this.wake = r); } if (this.failed) throw this.failed; }
    async finish() { await this.below(0); this.pump(); this.workers.forEach(w => w.terminate()); return this.tracker; }
    stop() { this.workers.forEach(w => w.terminate()); }
  }

  // ------------------------------------------------------------ fast path: WebCodecs + mp4box
  async function decodeWebCodecs(file, pool, onProgress) {
    if (!("VideoDecoder" in root) || typeof MP4Box === "undefined") throw new Error("no webcodecs");
    const mp4 = MP4Box.createFile();
    let track = null, info = null;
    const ready = new Promise((res, rej) => {
      mp4.onError = e => rej(new Error(String(e)));
      mp4.onReady = i => { info = i; track = i.videoTracks[0]; track ? res() : rej(new Error("No video track in this file.")); };
    });
    const CHUNK = 4 << 20; let offset = 0, eof = false, followHint = true;
    async function feed() {
      if (eof) return;
      const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
      buf.fileStart = offset;
      const next = mp4.appendBuffer(buf);
      // phase 1 follows mp4box's hint to jump over the video data to the index
      // (phones often store it at the end); phase 2 reads the file in order
      offset = (followHint && typeof next === "number" && next > offset) ? next : offset + buf.byteLength;
      if (offset >= file.size) { eof = true; mp4.flush(); }
    }
    let readyDone = false; ready.then(() => readyDone = true, () => readyDone = true);
    while (!readyDone && !eof) await feed();
    await ready;

    const entry = mp4.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
    let description;
    const box = entry.avcC || entry.hvcC;
    if (box) { const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); box.write(ds); description = new Uint8Array(ds.buffer, 8); }
    const config = { codec: track.codec.startsWith("vp08") ? "vp8" : track.codec, codedWidth: track.video.width, codedHeight: track.video.height, optimizeForLatency: true };
    if (description) config.description = description;
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error("decoder unsupported: " + track.codec);
    const m = track.matrix || [65536, 0, 0, 0, 65536, 0, 0, 0, 0x40000000];
    pool.setGeometry(track.video.width, track.video.height, Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI));
    const duration = track.movie_duration / track.movie_timescale || track.duration / track.timescale;
    const fps = track.nb_samples / duration, decimate = Math.max(1, Math.round(fps / 30));
    const total = track.nb_samples;

    let decoded = 0, failed = null, lastT = -Infinity, reordered = 0;
    const decoder = new VideoDecoder({
      output: frame => {
        const k = decoded++;
        if (k % decimate) { frame.close(); return; }
        const t = frame.timestamp / 1e6;
        if (t < lastT) reordered++; lastT = Math.max(lastT, t);
        pool.pushFrame(frame, t);
      },
      error: e => { failed = e; }
    });
    decoder.configure(config);
    const pending = []; let nextNumber = 0; // mp4box may hand some samples over twice; keep each once
    mp4.onSamples = (id, user, samples) => { for (const s of samples) { if (s.number < nextNumber) continue; nextNumber = s.number + 1; pending.push(s); } };
    mp4.setExtractionOptions(track.id, null, { nbSamples: 60 });
    mp4.start();
    followHint = false; eof = false; offset = mp4.seek(0, true).offset;

    const started = performance.now();
    while (true) {
      if (failed) throw failed;
      while (pending.length && decoder.decodeQueueSize < 16) {
        const s = pending.shift();
        decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: 1e6 * s.cts / s.timescale, duration: 1e6 * s.duration / s.timescale, data: s.data }));
        mp4.releaseUsedSamples(track.id, s.number + 1); // the chunk copied the bytes; free them
      }
      await pool.below(pool.size * 3); // keep workers busy, but don't let decoding run away
      const done = Math.min(1, decoded / total), el = (performance.now() - started) / 1000;
      onProgress(done, done > 0.03 ? el / done - el : null);
      if (pending.length < 40 && !eof) { await feed(); continue; }
      if (!pending.length && eof) break;
      await new Promise(r => setTimeout(r, 0));
    }
    await decoder.flush(); decoder.close();
    if (decoded < 10) throw new Error("decoded too few frames");
    return { fps: fps / decimate, duration, reordered, created: info.created && info.created.getTime() > 86400000 * 365 * 5 ? info.created : null };
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

  async function analyse(file, { onProgress = () => {} } = {}) {
    const t0 = performance.now();
    let via = "webcodecs", meta, pool = await Pool.create();
    try { meta = await decodeWebCodecs(file, pool, onProgress); }
    catch (e) {
      console.warn("Fast path unavailable, using playback:", e);
      pool.stop(); pool = await Pool.create(); via = "playback";
      meta = await decodePlayback(file, pool, onProgress);
    }
    const tracker = await pool.finish();
    if (!tracker || tracker.ts.length < 10) throw new Error("No frames could be read from this video.");
    const result = countFrom(tracker);
    return { result, via, frames: tracker.ts.length, seconds: (performance.now() - t0) / 1000, recordedAt: meta.created || new Date(file.lastModified || Date.now()), reordered: meta.reordered || 0 };
  }

  root.SkipEngine = { analyse, Pool, countFrom, W };
})(typeof self !== "undefined" ? self : this);
