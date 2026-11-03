"""Count skips from a body-height signal.

Pipeline
--------
1. Fill short gaps (frames where the body wasn't found) by interpolation.
2. Band-pass 0.8–5 Hz: keeps the bounce (48–300 jumps/min), throws away
   slow drift (walking around, camera wobble) and per-frame jitter.
3. Find *when* you are actually skipping: a rolling amplitude envelope must be
   above a floor (so standing still / fiddling with the rope doesn't count)
   and stay up for at least ~1 s.
4. Within those stretches, every apex of the bounce is one skip. Peaks must be
   at least ~55 % of a period apart and reasonably prominent compared with the
   local bounce size, so small wobbles between jumps aren't double counted.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.signal import butter, find_peaks, sosfiltfilt, welch


@dataclass
class Segment:
    start: float
    end: float
    skips: int

    @property
    def seconds(self) -> float:
        return self.end - self.start


@dataclass
class CountResult:
    skips: int
    skip_times: np.ndarray
    segments: list[Segment]
    jumping_seconds: float
    total_seconds: float
    cadence_hz: float
    filtered: np.ndarray = field(repr=False)
    envelope: np.ndarray = field(repr=False)
    active: np.ndarray = field(repr=False)

    @property
    def skips_per_minute(self) -> float:
        return 60.0 * self.skips / self.jumping_seconds if self.jumping_seconds > 0 else 0.0

    @property
    def rest_seconds(self) -> float:
        return max(self.total_seconds - self.jumping_seconds, 0.0)


def _fill_gaps(y: np.ndarray) -> np.ndarray:
    y = y.astype(float).copy()
    ok = np.isfinite(y)
    if ok.sum() < 2:
        raise ValueError("Could not find a person in the video (too few usable frames).")
    idx = np.arange(len(y))
    y[~ok] = np.interp(idx[~ok], idx[ok], y[ok])
    return y


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index pairs of True runs."""
    d = np.diff(np.concatenate(([0], mask.astype(np.int8), [0])))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def count_skips(
    t: np.ndarray,
    y: np.ndarray,
    fps: float,
    *,
    min_hz: float = 0.8,
    max_hz: float = 5.0,
    min_amplitude: float = 0.012,
    rel_prominence: float = 0.45,
    merge_gap_s: float = 1.0,
    min_segment_skips: int = 3,
    horizontal: np.ndarray | None = None,
    max_walk_speed: float = 0.8,
) -> CountResult:
    """Count skips.

    ``y`` uses image convention (smaller = higher) in torso-length units.
    ``min_amplitude`` is the smallest bounce (RMS, torso lengths) that counts
    as skipping — ~0.012 ≈ a 1.5 cm bounce for a typical adult.
    ``horizontal`` (optional, same units) lets us ignore walking: bobbing up and down
    while moving sideways faster than ``max_walk_speed`` torso-lengths/s is
    not a skip.
    """
    t = np.asarray(t, float)
    n = len(t)
    if n < fps * 2:
        raise ValueError("Video is too short to analyse (need at least 2 seconds).")
    total_seconds = float(t[-1] - t[0] + 1.0 / fps)

    up = -_fill_gaps(np.asarray(y))  # bigger = higher
    hi = min(max_hz, 0.45 * fps)
    sos = butter(2, [min_hz, hi], btype="bandpass", fs=fps, output="sos")
    x = sosfiltfilt(sos, up - np.median(up))

    # Rolling RMS envelope over ~1.2 s.
    win = max(3, int(round(1.2 * fps)))
    env = np.sqrt(uniform_filter1d(x * x, win, mode="nearest"))

    floor = max(min_amplitude, 0.15 * np.percentile(env, 95))
    active = env > floor

    if horizontal is not None and np.isfinite(horizontal).sum() >= 2:
        xs = uniform_filter1d(_fill_gaps(np.asarray(horizontal)), max(3, int(round(0.5 * fps))), mode="nearest")
        speed = np.abs(np.gradient(xs)) * fps
        active &= uniform_filter1d(speed, win, mode="nearest") < max_walk_speed

    # Merge tiny gaps (a stumble mid-set) and drop blips shorter than ~1 s.
    for s, e in _runs(~active):
        if s > 0 and e < n and (e - s) / fps < merge_gap_s:
            active[s:e] = True
    for s, e in _runs(active):
        if (e - s) / fps < 1.0:
            active[s:e] = False

    # Dominant cadence from the active part only.
    cadence = 2.0
    if active.sum() > fps * 2:
        f, p = welch(x[active], fs=fps, nperseg=min(int(active.sum()), int(8 * fps)))
        band = (f >= min_hz) & (f <= hi)
        if band.any():
            cadence = float(f[band][np.argmax(p[band])])

    # Allow speeding up to ~1.6x the dominant cadence without missing skips.
    distance = max(1, int(0.6 * fps / cadence))
    peaks, props = find_peaks(x, distance=distance, prominence=0)
    amp = np.sqrt(2.0) * env[peaks]  # sinusoid-equivalent amplitude
    keep = active[peaks] & (props["prominences"] >= rel_prominence * amp) & (x[peaks] > 0)
    peaks = peaks[keep]

    segments: list[Segment] = []
    final_peaks: list[int] = []
    period = 1.0 / cadence
    for s, e in _runs(active):
        seg_peaks = peaks[(peaks >= s) & (peaks < e)]
        if len(seg_peaks) < min_segment_skips:
            continue
        final_peaks.extend(seg_peaks.tolist())
        # Jumping time = first apex to last apex plus one period (half before, half after).
        start = max(float(t[seg_peaks[0]]) - period / 2, float(t[0]))
        end = min(float(t[seg_peaks[-1]]) + period / 2, float(t[-1]) + 1.0 / fps)
        segments.append(Segment(start, end, len(seg_peaks)))

    final = np.asarray(final_peaks, int)
    return CountResult(
        skips=len(final),
        skip_times=t[final] if len(final) else np.array([]),
        segments=segments,
        jumping_seconds=float(sum(sg.seconds for sg in segments)),
        total_seconds=total_seconds,
        cadence_hz=cadence,
        filtered=x,
        envelope=env,
        active=active,
    )
