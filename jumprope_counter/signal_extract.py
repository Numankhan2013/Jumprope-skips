"""Turn a video into a 1-D "how high is the body right now" signal.

Two backends:

* ``pose``   – MediaPipe Pose Landmarker. Tracks shoulders + hips, so the
               signal is the body's vertical position measured in torso
               lengths. Most accurate on real footage. Model is downloaded
               once (~5 MB) and cached.
* ``motion`` – Pure OpenCV dense optical flow. Tracks the vertical
               motion of everything that moves. No model needed, works on
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


def extract_motion(path, *, max_fps=30.0, max_width=240, start=0.0, end=None, progress=True) -> BodySignal:
    """Dense optical flow: integrate the median motion of whatever is moving.

    For someone skipping in front of a still camera, "whatever is moving" is
    overwhelmingly their body, so the integrated vertical flow is their height.
    Slow drift from integration is removed later by the band-pass filter.
    """
    prev = None
    ts, vys, vxs, heights = [], [], [], []
    for t, frame in _frames(path, max_fps, max_width, start, end, progress):
        gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (3, 3), 0)
        vy = vx = 0.0
        if prev is not None:
            flow = cv2.calcOpticalFlowFarneback(prev, gray, None, 0.5, 3, 13, 3, 5, 1.1, 0)
            mag = np.hypot(flow[..., 0], flow[..., 1])
            moving = mag > 0.3
            if moving.sum() > 0.001 * mag.size:
                vy = float(np.median(flow[..., 1][moving]))
                vx = float(np.median(flow[..., 0][moving]))
                rows = np.nonzero(moving)[0]
                lo, hi = np.percentile(rows, [2, 98])
                heights.append(hi - lo)
        prev = gray
        ts.append(t)
        vys.append(vy)
        vxs.append(vx)
    fps = _effective_fps(path, max_fps)
    t = np.asarray(ts, float)
    body = np.median(heights) if heights else 100.0
    # Express in "torso lengths" (≈ 1/3 of the moving body) to share thresholds with pose.
    unit = max(body / 3.0, 1.0)
    return BodySignal(t=t, y=np.cumsum(vys) / unit, x=np.cumsum(vxs) / unit, fps=fps,
                      duration=(t[-1] - t[0] + 1 / fps) if len(t) else 0.0, backend="motion")


def extract(path, backend="auto", **kw) -> BodySignal:
    if backend == "pose" or (backend == "auto" and pose_available()):
        sig = extract_pose(path, **kw)
        found = np.isfinite(sig.y).mean() if len(sig.y) else 0.0
        if backend == "pose" or found >= 0.5:
            return sig
        print(f"  pose tracker only found you in {found:.0%} of frames; "
              "switching to motion tracking", file=sys.stderr)
    kw.pop("model", None)
    return extract_motion(path, **kw)
