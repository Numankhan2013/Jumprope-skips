// Frame shrinking: a decoded video frame → a small grayscale image (160 px wide),
// rotated upright. Runs in workers (VideoFrame → luma plane, no canvas) and on
// the main thread (for <video>/<canvas> sources in the playback fallback).
(function (root) {
  "use strict";
  // 8-bit formats whose first plane is luma (brightness): exactly what we need.
  const LUMA_FORMATS = new Set(["I420", "I420A", "I422", "I444", "NV12"]);

  function geometry(srcW, srcH, rotation, W) {
    const rot = ((rotation % 360) + 360) % 360, swap = rot === 90 || rot === 270;
    const outW = W, outH = Math.max(16, Math.round((swap ? srcW : srcH) / (swap ? srcH : srcW) * W / 2) * 2);
    return { rot, swap, outW, outH, sw: swap ? outH : outW, sh: swap ? outW : outH };
  }

  function makeShrinker(srcW, srcH, rotation, W = 160) {
    const G = geometry(srcW, srcH, rotation, W), { rot, swap, outW, outH, sw, sh } = G;

    // canvas path: two-step downscale (big → 4x → final) so fine detail doesn't alias
    let mid, mg, small, sg;
    function canvasShrink(src) {
      if (!mid) {
        mid = new OffscreenCanvas(outW * 4, outH * 4); mg = mid.getContext("2d");
        small = new OffscreenCanvas(outW, outH); sg = small.getContext("2d", { willReadFrequently: true });
        mg.imageSmoothingQuality = "high"; sg.imageSmoothingQuality = "high";
      }
      const midW = outW * 4, midH = outH * 4;
      mg.save(); mg.translate(midW / 2, midH / 2); mg.rotate(rot * Math.PI / 180);
      const dw = swap ? midH : midW, dh = swap ? midW : midH;
      mg.drawImage(src, -dw / 2, -dh / 2, dw, dh); mg.restore();
      sg.drawImage(mid, 0, 0, outW, outH);
      const d = sg.getImageData(0, 0, outW, outH).data, g = new Uint8Array(outW * outH);
      for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      return g;
    }

    // luma path: copy the frame's brightness plane and box-average every 2nd
    // pixel into the small grid. No canvas, no colour, ~4x less work.
    let buf = null, colOf = null, rowOf = null, cnt = null, lumaBroken = false;
    async function lumaShrink(frame) {
      const vr = frame.visibleRect, W0 = vr.width, H0 = vr.height, size = frame.allocationSize();
      if (!buf || buf.length < size) buf = new Uint8Array(size);
      const layout = await frame.copyTo(buf);
      const off = layout[0].offset, stride = layout[0].stride;
      if (!colOf || colOf.length !== W0 || rowOf.length !== H0) {
        colOf = new Uint16Array(W0); rowOf = new Uint16Array(H0); cnt = new Uint32Array(sw * sh);
        for (let x = 0; x < W0; x++) colOf[x] = Math.min(sw - 1, Math.floor(x * sw / W0));
        for (let y = 0; y < H0; y++) rowOf[y] = Math.min(sh - 1, Math.floor(y * sh / H0));
        for (let y = 0; y < H0; y += 2) for (let x = 0; x < W0; x += 2) cnt[rowOf[y] * sw + colOf[x]]++;
      }
      const acc = new Uint32Array(sw * sh);
      for (let y = 0; y < H0; y += 2) {
        const o = off + y * stride, r = rowOf[y] * sw;
        for (let x = 0; x < W0; x += 2) acc[r + colOf[x]] += buf[o + x];
      }
      const g = new Uint8Array(outW * outH);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        // video luma is "limited range" (16–235): stretch to 0–255 like the canvas path
        let v = (acc[y * sw + x] / cnt[y * sw + x] - 16) * 1.1644;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        let X = x, Y = y;
        if (rot === 90) { X = sh - 1 - y; Y = x; } else if (rot === 180) { X = sw - 1 - x; Y = sh - 1 - y; } else if (rot === 270) { X = y; Y = sw - 1 - x; }
        g[Y * outW + X] = v;
      }
      return g;
    }

    return {
      w: outW, h: outH,
      // any drawable source (video element, canvas) – main thread
      element: canvasShrink,
      // a VideoFrame – luma plane when possible, canvas otherwise
      async frame(frame, mode) {
        if (mode !== "canvas" && !lumaBroken && LUMA_FORMATS.has(frame.format)) {
          try { return await lumaShrink(frame); } catch (e) { lumaBroken = true; }
        }
        return canvasShrink(frame);
      }
    };
  }

  root.SkipShrink = { makeShrinker, geometry };
})(typeof self !== "undefined" ? self : this);
