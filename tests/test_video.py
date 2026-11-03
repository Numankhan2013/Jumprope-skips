"""End-to-end: render a jumping figure to a real video file and count it."""

import cv2
import numpy as np
import pytest

from jumprope_counter.cli import main
from jumprope_counter.counter import count_skips
from jumprope_counter.signal_extract import extract_motion

from .synth import workout


def _render(path, plan, fps=30, size=(480, 360)):
    _, y, x, true = workout(plan, fps=fps, amp=0.25, noise=0.0)
    w, h = size
    out = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    rng = np.random.default_rng(0)
    bg = rng.integers(90, 140, (h, w, 3), dtype=np.uint8)
    bg = cv2.GaussianBlur(bg, (9, 9), 0)
    torso = 60  # px per "torso length"
    for i, (yy, xx) in enumerate(zip(y - 3.0, x)):
        f = bg.copy()
        cx = int(w / 2 + (xx * torso) % (w / 2) - w / 4) if xx > 1 else int(w / 2 + xx * torso)
        feet = int(h - 30 + yy * torso)
        cv2.line(f, (cx - 12, feet), (cx - 8, feet - 70), (40, 40, 40), 10)
        cv2.line(f, (cx + 12, feet), (cx + 8, feet - 70), (40, 40, 40), 10)
        cv2.rectangle(f, (cx - 22, feet - 140), (cx + 22, feet - 70), (30, 60, 200), -1)
        cv2.circle(f, (cx, feet - 160), 18, (150, 180, 220), -1)
        out.write(f)
    out.release()
    return true


def test_motion_backend_on_rendered_video(tmp_path):
    vid = tmp_path / "skips.mp4"
    plan = [("rest", 3), ("jump", 40, 110), ("rest", 3), ("jump", 25, 120), ("rest", 2)]
    true = _render(vid, plan)
    sig = extract_motion(vid, progress=False)
    r = count_skips(sig.t, sig.y, sig.fps, horizontal=sig.x)
    assert abs(r.skips - true) <= 2, (r.skips, true)
    assert len(r.segments) == 2


def test_cli_end_to_end(tmp_path, capsys):
    vid = tmp_path / "skips.mp4"
    _render(vid, [("rest", 3), ("jump", 30, 110), ("rest", 2)])
    rc = main([str(vid), "--weight", "154lb", "--height", "5'9", "--backend", "motion",
               "--csv", str(tmp_path / "s.csv"), "--plot", str(tmp_path / "s.png"),
               "--annotate", str(tmp_path / "a.mp4")])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Total skips" in out and "TOTAL burned" in out
    assert (tmp_path / "s.png").stat().st_size > 0
    assert len((tmp_path / "s.csv").read_text().splitlines()) > 25
    assert cv2.VideoCapture(str(tmp_path / "a.mp4")).get(cv2.CAP_PROP_FRAME_COUNT) > 100


def test_manual_mode(capsys):
    assert main(["--skips", "5000", "--minutes", "45", "--rest-minutes", "10",
                 "--weight", "80", "--height", "180", "--age", "28", "--sex", "male"]) == 0
    assert "TOTAL burned" in capsys.readouterr().out
