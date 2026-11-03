"""Synthetic jump-rope workouts with a known number of skips."""

from __future__ import annotations

import numpy as np


def workout(plan, fps=30.0, amp=0.08, noise=0.006, seed=0):
    """Build (t, y, x, true_skips) from a plan.

    plan items:
      ("jump", n_skips, rate_per_min)   – n bounces at that pace
      ("rest", seconds)                 – standing, slight sway
      ("walk", seconds)                 – walking sideways (bobs ~1.8 Hz!)
    y uses image convention (smaller = higher), torso-length units.
    """
    rng = np.random.default_rng(seed)
    ys, xs = [], []
    pos_x = 0.0
    true = 0
    for item in plan:
        kind = item[0]
        if kind == "jump":
            n, rate = item[1], item[2]
            period = 60.0 / rate
            m = int(round(n * period * fps))
            tt = np.arange(m) / fps
            phase = (tt / period) % 1.0
            # airborne parabola for 60 % of the cycle, knee-bend dip on landing
            air = np.clip(phase / 0.6, 0, 1)
            h = np.where(phase < 0.6, 4 * air * (1 - air), -0.25 * np.sin(np.pi * (phase - 0.6) / 0.4))
            a = amp * rng.uniform(0.7, 1.3, n).repeat(int(np.ceil(m / n)))[:m]
            ys.append(-a * h)
            xs.append(pos_x + 0.05 * np.sin(2 * np.pi * 0.1 * tt))
            true += n
        elif kind == "rest":
            m = int(round(item[1] * fps))
            tt = np.arange(m) / fps
            ys.append(0.01 * np.sin(2 * np.pi * 0.3 * tt))
            xs.append(pos_x + 0.05 * np.sin(2 * np.pi * 0.2 * tt))
        elif kind == "walk":
            m = int(round(item[1] * fps))
            tt = np.arange(m) / fps
            ys.append(-0.06 * np.abs(np.sin(np.pi * 1.8 * tt)))
            xs.append(pos_x + 2.5 * tt)  # ~1.2 m/s
            pos_x += 2.5 * item[1]
    y = np.concatenate(ys) + rng.normal(0, noise, sum(map(len, ys)))
    x = np.concatenate(xs) + rng.normal(0, noise, len(y))
    t = np.arange(len(y)) / fps
    return t, y + 3.0, x, true
