// Run the browser engine in Node on raw grayscale frames from ffmpeg:
//   ffmpeg -i clip.mp4 -vf scale=160:-2 -pix_fmt gray -f rawvideo - | node web/test_node.js 160 284 30
const core = require("./core.js");
const [w, h, fps] = process.argv.slice(2).map(Number);
const tr = new core.Tracker(w, h);
let buf = Buffer.alloc(0);
process.stdin.on("data", d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= w * h) { tr.push(new Uint8Array(buf.subarray(0, w * h)), tr.ts.length / fps); buf = buf.subarray(w * h); }
});
process.stdin.on("end", () => {
  const s = tr.signal();
  const r = core.countSkips(s.t, s.y, s.fps, { horizontal: s.x, valid: s.valid });
  console.log(JSON.stringify({ skips: r.skips, sets: r.sets.map(x => x.skips), jumping: r.jumpingSeconds,
    cadence: r.cadenceHz, times: r.skipTimes }));
});
