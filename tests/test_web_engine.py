"""The phone page's JS engine must count the same as the Python one."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from jumprope_counter.counter import count_skips
from jumprope_counter.signal_extract import extract_motion

from .test_video import _render

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(not (shutil.which("node") and shutil.which("ffmpeg")),
                                reason="needs node and ffmpeg")


def test_js_engine_matches_python(tmp_path):
    vid = tmp_path / "skips.mp4"
    true = _render(vid, [("rest", 3), ("jump", 40, 110), ("rest", 3), ("jump", 25, 140), ("rest", 2)])
    w, h = 160, 120
    frames = subprocess.run(["ffmpeg", "-v", "error", "-i", str(vid), "-vf", f"scale={w}:{h}",
                             "-pix_fmt", "gray", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    out = subprocess.run(["node", str(ROOT / "web" / "test_node.js"), str(w), str(h), "30"],
                         input=frames, capture_output=True, check=True).stdout
    js = json.loads(out)
    sig = extract_motion(vid, progress=False)
    py = count_skips(sig.t, sig.y, sig.fps, horizontal=sig.x, valid=sig.valid)
    assert abs(js["skips"] - true) <= 2, (js["skips"], true)
    assert abs(py.skips - true) <= 2, (py.skips, true)
    assert abs(js["skips"] - py.skips) <= 1


def test_pocket_mode_counts_synthetic_accelerometer_workouts():
    """Phone-in-pocket counting on simulated sensor data: exact sets, walking ignored."""
    r = subprocess.run(["node", str(ROOT / "web" / "test_accel.js")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_built_page_scripts_parse():
    """docs/index.html is what the site serves: every inlined script must be valid JavaScript."""
    check = ("const fs=require('fs');const h=fs.readFileSync(process.argv[1],'utf8');let n=0;"
             "for(const m of h.matchAll(/<script id=\"(\\w+)\">([\\s\\S]*?)<\\/script>/g)){new Function(m[2]);n++}"
             "if(n<5)throw new Error('expected 5 inlined scripts, found '+n);")
    r = subprocess.run(["node", "-e", check, str(ROOT / "docs" / "index.html")], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
