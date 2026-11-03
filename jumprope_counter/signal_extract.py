"""Turn a video into a 1-D "how high is the body right now" signal.

Two backends:

* ``pose``   – MediaPipe Pose Landmarker. Tracks shoulders + hips, so the
               signal is the body's vertical position measured in torso
               lengths. Most accurate on real footage. Model is downloaded
               once (~5 MB) and cached.
* ``motion`` – Block matching (same algorithm as the phone page). Tracks the
               vertical motion of everything that moves. No model needed, works on
               anything, but needs a still camera and is fooled more easily
               by other moving things in the shot.

Both return a :class:`BodySignal` where *smaller y means higher up* (image
coordinates), normalised by body size so thresholds are camera-independent.
"""

from __future__ import annotations

import os
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

POSE_MODEL_URLS = {
    "lite": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    "full": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_full/float16/latest/pose_landmarker_full.task",
    "heavy": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
}

# MediaPipe landmark indices
_L_SHOULDER, _R_SHOULDER, _L_HIP, _R_HIP = 11, 12, 23, 24


@dataclass
class BodySignal:
    t: np.ndarray        # seconds, shape (n,)
    y: np.ndarray        # body height signal (smaller = higher), NaN where unknown
    x: np.ndarray        # body horizontal position, same units (used to ignore walking)
    fps: float           # sample rate of t / y
    duration: float      # seconds of video analysed
    backend: str
    valid: np.ndarray | None = None  # False where the camera itself was moving


@dataclass
class _VideoInfo:
    fps: float
    frames: int
    width: int
    height: int


def _open(path: str | os.PathLike) -> tuple[cv2.VideoCapture, _VideoInfo]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise FileNotFoundError(f"Could not open video: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    if not (1.0 < fps < 1000.0):
        fps = 30.0
    info = _VideoInfo(
        fps=fps,
        frames=int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0),
        width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
        height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
    )
    return cap, info


def _frames(path, max_fps: float, max_width: int, start: float, end: float | None, progress: bool):
    """Yield (time_s, bgr_frame) at <= max_fps, resized to <= max_width."""
    cap, info = _open(path)
    step = max(1, int(round(info.fps / max_fps))) if max_fps else 1
    first = int(round(start * info.fps))
    last = int(round(end * info.fps)) if end is not None else None
    if first:
        cap.set(cv2.CAP_PROP_POS_FRAMES, first)
    idx = first
    total = (last or info.frames) - first
    try:
        while last is None or idx < last:
            if (idx - first) % step:
                if not cap.grab():
                    break
                idx += 1
                continue
            ok, frame = cap.read()
            if not ok:
                break
            h, w = frame.shape[:2]
            if w > max_width:
                frame = cv2.resize(frame, (max_width, int(h * max_width / w)), interpolation=cv2.INTER_AREA)
            yield idx / info.fps, frame
            idx += 1
            if progress and total > 0 and (idx - first) % 300 < step:
                pct = 100.0 * (idx - first) / total
                print(f"\r  analysing video… {pct:5.1f}%", end="", file=sys.stderr, flush=True)
    finally:
        cap.release()
        if progress:
            print("\r  analysing video… done   ", file=sys.stderr)


def _effective_fps(path, max_fps: float) -> float:
    cap, info = _open(path)
    cap.release()
    step = max(1, int(round(info.fps / max_fps))) if max_fps else 1
    return info.fps / step


# --------------------------------------------------------------------------- pose


def _model_path(variant: str) -> Path:
    cache = Path(os.environ.get("JUMPROPE_CACHE", Path.home() / ".cache" / "jumprope_counter"))
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f"pose_landmarker_{variant}.task"
    if not path.exists():
        print(f"  downloading pose model ({variant}) → {path}", file=sys.stderr)
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(POSE_MODEL_URLS[variant], tmp)
        tmp.replace(path)
    return path


def pose_available() -> bool:
    try:
        import mediapipe  # noqa: F401
        from mediapipe.tasks.python import vision  # noqa: F401
    except Exception:
        return False
    return True


def extract_pose(path, *, model="lite", max_fps=30.0, max_width=640, start=0.0, end=None,
                 progress=True) -> BodySignal:
    os.environ.setdefault("GLOG_minloglevel", "2")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    opts = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(_model_path(model))),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    ts, ys, xs = [], [], []
    with vision.PoseLandmarker.create_from_options(opts) as landmarker:
        last_ms = -1
        for t, frame in _frames(path, max_fps, max_width, start, end, progress):
            ms = max(int(round(t * 1000)), last_ms + 1)  # must be strictly increasing
            last_ms = ms
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            res = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ms)
            y = x = np.nan
            if res.pose_landmarks:
                lm = res.pose_landmarks[0]
                sh = (lm[_L_SHOULDER].y + lm[_R_SHOULDER].y) / 2
                hp = (lm[_L_HIP].y + lm[_R_HIP].y) / 2
                torso = hp - sh
                if torso > 1e-3:
                    # mid-torso height, in torso lengths
                    y = ((sh + hp) / 2) / torso
                    # x is normalised by width, torso by height: rescale by aspect ratio
                    aspect = frame.shape[1] / frame.shape[0]
                    x = (sum(lm[i].x for i in (_L_SHOULDER, _R_SHOULDER, _L_HIP, _R_HIP)) / 4) * aspect / torso
            ts.append(t)
            ys.append(y)
            xs.append(x)
    fps = _effective_fps(path, max_fps)
    t = np.asarray(ts, float)
    return BodySignal(t=t, y=np.asarray(ys, float), x=np.asarray(xs, float), fps=fps,
                      duration=(t[-1] - t[0] + 1 / fps) if len(t) else 0.0, backend="pose")


# --------------------------------------------------------------------------- motion


_B, _R = 8, 4  # block size and search radius (pixels at 160 px width)


def _is_background(bx: int, by: int, w: int, h: int) -> bool:
    """Top 20 % of the frame, plus the outer side strips in the upper half."""
    return by + _B <= 0.2 * h or ((bx + _B <= 0.12 * w or bx >= 0.88 * w) and by + _B <= 0.5 * h)


def frame_motion(prev: np.ndarray, cur: np.ndarray) -> tuple[float, float, float]:
    """Block matching between two grayscale frames, same algorithm as web/core.js.

    1. Measure how the background (top band and upper side strips) moved: that
       is the camera. A phone on a vibrating floor or badly propped shakes.
    2. Blocks that moved differently from the camera are the person; return
       their median motion relative to the camera, and the fraction of
       textured blocks that did so (very high = the phone is being handled).
    """
    h, w = cur.shape
    nby, nbx = (h - 2 * _R) // _B, (w - 2 * _R) // _B
    if nby < 1 or nbx < 1:
        return 0.0, 0.0, 0.0
    cur = cur.astype(np.int16)
    prev = prev.astype(np.int16)
    ys, xs = slice(_R, _R + nby * _B), slice(_R, _R + nbx * _B)

    def blocks(img):  # (nby, nbx, B, B)
        return img.reshape(nby, _B, nbx, _B).swapaxes(1, 2)

    cb = blocks(cur[ys, xs])
    textured = (cb.max(axis=(2, 3)) - cb.min(axis=(2, 3))) >= 12
    zero = np.abs(cur[ys, xs] - prev[ys, xs]).reshape(nby, _B, nbx, _B).sum(axis=(1, 3))

    k = 2 * _R + 1
    sad = np.empty((k, k, nby, nbx), np.int32)
    for dy in range(-_R, _R + 1):
        for dx in range(-_R, _R + 1):
            shifted = prev[_R - dy:_R - dy + nby * _B, _R - dx:_R - dx + nbx * _B]
            sad[dy + _R, dx + _R] = np.abs(cur[ys, xs] - shifted).reshape(nby, _B, nbx, _B).sum(axis=(1, 3))
    flat = sad.reshape(k * k, nby, nbx)
    dyg, dxg = np.meshgrid(np.arange(-_R, _R + 1), np.arange(-_R, _R + 1), indexing="ij")
    order = np.argsort((dyg ** 2 + dxg ** 2).ravel(), kind="stable")  # ties → smallest shift
    best_i = order[np.argmin(flat[order], axis=0)]
    best = np.take_along_axis(flat, best_i[None], 0)[0].astype(float)
    bdy, bdx = best_i // k - _R, best_i % k - _R

    def refine(by, bx):
        dy, dx, b0 = int(bdy[by, bx]), int(bdx[by, bx]), best[by, bx]
        at = lambda ddx, ddy: float(sad[ddy + _R, ddx + _R, by, bx])  # noqa: E731
        fy, fx = float(dy), float(dx)
        if -_R < dy < _R:
            a, c = at(dx, dy - 1), at(dx, dy + 1)
            d = a - 2 * b0 + c
            if d > 0:
                fy += 0.5 * (a - c) / d
        if -_R < dx < _R:
            a, c = at(dx - 1, dy), at(dx + 1, dy)
            d = a - 2 * b0 + c
            if d > 0:
                fx += 0.5 * (a - c) / d
        return fy, fx

    # 1. camera motion from the background region
    gys, gxs = [], []
    for by, bx in zip(*np.nonzero(textured)):
        if _is_background(_R + bx * _B, _R + by * _B, w, h):
            fy, fx = refine(by, bx)
            gys.append(fy)
            gxs.append(fx)
    gy = gx = 0.0
    if len(gys) >= 6:
        gy, gx = float(np.median(gys)), float(np.median(gxs))
    cam_moving = np.hypot(gx, gy) >= 0.3
    ry, rx = int(round(gy)), int(round(gx))
    ry, rx = max(-_R, min(_R, ry)), max(-_R, min(_R, rx))

    # 2. blocks that moved differently from the camera
    cand = textured & ((zero >= 2 * _B * _B) | cam_moving)
    cand &= (sad[ry + _R, rx + _R] - best) >= 2 * _B * _B
    vys, vxs = [], []
    for by, bx in zip(*np.nonzero(cand)):
        fy, fx = refine(by, bx)
        dy, dx = fy - gy, fx - gx
        if np.hypot(dx, dy) >= 0.3:
            vys.append(dy)
            vxs.append(dx)
    n_tex = int(textured.sum())
    frac = len(vys) / n_tex if n_tex else 0.0
    vy = float(np.median(vys)) if len(vys) >= 3 else 0.0
    vx = float(np.median(vxs)) if len(vxs) >= 3 else 0.0
    return vy, vx, frac


def extract_motion(path, *, max_fps=30.0, max_width=160, start=0.0, end=None, progress=True) -> BodySignal:
    """Integrate the median motion of whatever is moving (block matching).

    For someone skipping in front of a still camera, "whatever is moving" is
    overwhelmingly their body, so the integrated vertical motion is their height.
    Slow drift from integration is removed later by the band-pass filter.
    Identical algorithm to the phone page (web/core.js), so both agree.
    """
    prev = None
    ts, vys, vxs, still = [], [], [], []
    h = None
    for t, frame in _frames(path, max_fps, max_width, start, end, progress):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h = gray.shape[0]
        vy = vx = frac = 0.0
        if prev is not None:
            vy, vx, frac = frame_motion(prev, gray)
        prev = gray
        ts.append(t)
        vys.append(vy)
        vxs.append(vx)
        # A person fills well under half the frame; if most of it moves, the
        # camera is being picked up / moved, and nothing there is a skip.
        still.append(frac < 0.6)
    fps = _effective_fps(path, max_fps)
    t = np.asarray(ts, float)
    unit = (h or 9) / 9.0  # ~"torso lengths" for someone filling the frame
    return BodySignal(t=t, y=np.cumsum(vys) / unit, x=np.cumsum(vxs) / unit, fps=fps,
                      duration=(t[-1] - t[0] + 1 / fps) if len(t) else 0.0, backend="motion",
                      valid=np.asarray(still, bool))


def extract(path, backend="motion", **kw) -> BodySignal:
    # Motion is the default: on real footage of low, fast skips it was far more
    # accurate than pose landmarks, which are smoothed and jitter at that scale.
    if backend == "pose":
        return extract_pose(path, **kw)
    kw.pop("model", None)
    return extract_motion(path, **kw)
