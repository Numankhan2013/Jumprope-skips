import numpy as np
import pytest

from jumprope_counter.counter import count_skips

from .synth import workout


def _count(plan, **kw):
    t, y, x, true = workout(plan, **{k: v for k, v in kw.items() if k in ("fps", "amp", "noise", "seed")})
    fps = kw.get("fps", 30.0)
    r = count_skips(t, y, fps, horizontal=x)
    return r, true


def test_steady_set():
    r, true = _count([("rest", 3), ("jump", 120, 120), ("rest", 3)])
    assert abs(r.skips - true) <= 1
    assert len(r.segments) == 1
    assert 110 <= r.skips_per_minute <= 130


@pytest.mark.parametrize("rate", [70, 100, 140, 170])
def test_paces(rate):
    r, true = _count([("rest", 2), ("jump", 80, rate), ("rest", 2)])
    assert abs(r.skips - true) <= 1, (rate, r.skips, true)


def test_beginner_with_stumbles_rests_and_walking():
    plan = [("rest", 4), ("jump", 14, 95), ("rest", 3), ("jump", 6, 90), ("walk", 4),
            ("rest", 2), ("jump", 45, 105), ("rest", 8), ("jump", 9, 100), ("rest", 2.5),
            ("jump", 30, 110), ("walk", 3), ("rest", 3)]
    for seed in range(5):
        r, true = _count(plan, seed=seed)
        # ±3: set edges are trimmed when weaker than the set's typical skip
        # (that's what removes the rope-catch / swing-in bumps in real video),
        # which occasionally costs a genuinely weak first/last skip here.
        assert abs(r.skips - true) <= 3, (seed, r.skips, true)
        assert len(r.segments) == 5
        # resting/walking time must not be billed as jumping
        assert r.jumping_seconds < 0.75 * r.total_seconds


def test_long_session_accuracy():
    plan = []
    for i in range(25):
        plan += [("jump", 180 + 7 * i, 115 + (i % 5) * 5), ("rest", 20)]
    r, true = _count(plan, seed=3, noise=0.01)
    assert true > 5000
    assert abs(r.skips - true) / true < 0.005


def test_standing_still_is_zero():
    r, _ = _count([("rest", 30)])
    assert r.skips == 0
    assert r.jumping_seconds == 0


def test_low_fps_video():
    r, true = _count([("rest", 2), ("jump", 60, 120), ("rest", 2)], fps=15.0)
    assert abs(r.skips - true) <= 1


def test_dropped_frames_are_tolerated():
    t, y, x, true = workout([("rest", 2), ("jump", 100, 110), ("rest", 2)])
    y = y.copy()
    rng = np.random.default_rng(1)
    y[rng.random(len(y)) < 0.05] = np.nan  # pose lost in 5 % of frames
    r = count_skips(t, y, 30.0, horizontal=x)
    assert abs(r.skips - true) <= 2
