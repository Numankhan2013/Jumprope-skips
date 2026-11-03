"""Command line: ``python -m jumprope_counter my_video.mp4 --weight 70kg --height 175cm``"""

from __future__ import annotations

import argparse
import csv
import sys

import numpy as np

from .calories import estimate_calories, parse_height, parse_weight
from .counter import CountResult, count_skips
from .signal_extract import extract


def _fmt_time(sec: float) -> str:
    sec = int(round(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _write_annotated(src: str, dst: str, result: CountResult, start: float) -> None:
    import cv2

    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if start:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(start * fps)))
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    out = cv2.VideoWriter(dst, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    times = np.sort(result.skip_times)
    i = int(round(start * fps))
    scale = max(h / 720.0, 0.6)
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = i / fps
        n = int(np.searchsorted(times, t, side="right"))
        just = n and (t - times[n - 1]) < 0.12
        colour = (0, 255, 255) if just else (255, 255, 255)
        for thick, col in ((int(8 * scale), (0, 0, 0)), (int(3 * scale), colour)):
            cv2.putText(frame, f"{n}", (int(20 * scale), int(90 * scale)),
                        cv2.FONT_HERSHEY_DUPLEX, 3 * scale, col, max(thick, 1), cv2.LINE_AA)
        out.write(frame)
        i += 1
    cap.release()
    out.release()


def _write_plot(path: str, t, result: CountResult) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(14, 4))
    ax.plot(t, result.filtered, lw=0.7, color="#4a6fa5", label="body height (filtered)")
    ax.fill_between(t, result.filtered.min(), result.filtered.max(), where=result.active,
                    color="#4a6fa5", alpha=0.08, label="detected jumping")
    if len(result.skip_times):
        idx = np.searchsorted(t, result.skip_times)
        ax.plot(result.skip_times, result.filtered[idx], "o", ms=3, color="#d1495b", label="counted skip")
    ax.set_xlabel("time (s)")
    ax.set_title(f"{result.skips} skips")
    ax.legend(loc="upper right")
    fig.tight_layout()
    fig.savefig(path, dpi=130)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="jumprope-counter",
        description="Count jump-rope skips in a video and estimate calories burned.",
    )
    p.add_argument("video", nargs="?", help="video file (any format OpenCV/ffmpeg can read)")
    p.add_argument("--weight", required=True, help="body weight, e.g. 70kg or 154lb (default unit kg)")
    p.add_argument("--height", required=True, help="height, e.g. 175cm, 1.75m or 5'9 (default unit cm)")
    p.add_argument("--age", type=float, default=None, help="age in years (improves calorie accuracy; default 30)")
    p.add_argument("--sex", choices=["male", "female"], default=None, help="improves calorie accuracy")
    p.add_argument("--backend", choices=["auto", "pose", "motion"], default="auto",
                   help="pose = MediaPipe body tracking (best), motion = plain OpenCV (fallback)")
    p.add_argument("--model", choices=["lite", "full", "heavy"], default="full",
                   help="pose model size: bigger is slower but steadier (default full)")
    p.add_argument("--start", type=float, default=0.0, help="ignore video before this many seconds")
    p.add_argument("--end", type=float, default=None, help="ignore video after this many seconds")
    p.add_argument("--sensitivity", type=float, default=1.0,
                   help="raise (e.g. 1.5) if skips are missed, lower (e.g. 0.7) if it over-counts")
    p.add_argument("--annotate", metavar="OUT.mp4", help="write a copy of the video with a live counter")
    p.add_argument("--plot", metavar="OUT.png", help="save a graph of the bounce signal and counted skips")
    p.add_argument("--csv", metavar="OUT.csv", help="save the timestamp of every counted skip")
    p.add_argument("--skips", type=int, help="skip video analysis: use this many skips…")
    p.add_argument("--minutes", type=float, help="…done in this many minutes of jumping")
    p.add_argument("--rest-minutes", type=float, default=0.0, help="…plus this many minutes of rest")
    a = p.parse_args(argv)

    weight = parse_weight(a.weight)
    height = parse_height(a.height)
    age = a.age if a.age is not None else 30.0

    if a.skips is not None:
        if not a.minutes:
            p.error("--skips needs --minutes")
        skips, jump_s, rest_s = a.skips, a.minutes * 60, a.rest_minutes * 60
        print(f"\n  Manual entry: {skips} skips in {_fmt_time(jump_s)} of jumping")
    else:
        if not a.video:
            p.error("give a video file, or use --skips/--minutes")
        print(f"\n  Reading {a.video}", file=sys.stderr)
        kw = dict(start=a.start, end=a.end)
        if a.backend in ("auto", "pose"):
            kw["model"] = a.model
        sig = extract(a.video, backend=a.backend, **kw)
        s = max(a.sensitivity, 0.05)
        result = count_skips(sig.t, sig.y, sig.fps, horizontal=sig.x,
                             min_amplitude=0.012 / s, rel_prominence=min(0.45 / s, 0.9))
        skips, jump_s, rest_s = result.skips, result.jumping_seconds, result.rest_seconds

        missing = np.mean(~np.isfinite(sig.y))
        print(f"\n  ── Skips ─────────────────────────────────")
        print(f"  Total skips      : {skips}")
        print(f"  Sets             : {len(result.segments)}"
              + (f"  ({', '.join(str(sg.skips) for sg in result.segments[:12])}"
                 f"{', …' if len(result.segments) > 12 else ''})" if result.segments else ""))
        if result.segments:
            print(f"  Best set         : {max(sg.skips for sg in result.segments)} in a row")
        print(f"  Video length     : {_fmt_time(result.total_seconds)}")
        print(f"  Time jumping     : {_fmt_time(jump_s)}")
        print(f"  Time resting     : {_fmt_time(rest_s)}")
        print(f"  Pace (jumping)   : {result.skips_per_minute:.0f} skips/min")
        print(f"  Tracker          : {sig.backend}"
              + (f"  (body not found in {missing:.0%} of frames)" if missing > 0.05 else ""))

        if a.csv:
            with open(a.csv, "w", newline="") as f:
                wr = csv.writer(f)
                wr.writerow(["skip", "time_s"])
                for i, tt in enumerate(result.skip_times, 1):
                    wr.writerow([i, f"{tt:.3f}"])
        if a.plot:
            _write_plot(a.plot, sig.t, result)
        if a.annotate:
            print("  writing annotated video…", file=sys.stderr)
            _write_annotated(a.video, a.annotate, result, a.start)

    cal = estimate_calories(skips, jump_s, rest_s, weight, height, age, a.sex)
    print(f"\n  ── Calories ──────────────────────────────")
    print(f"  You              : {weight:.1f} kg, {height:.0f} cm, age {age:g}"
          + (f", {a.sex}" if a.sex else ""))
    print(f"  Resting burn     : {cal.rmr_kcal_day:.0f} kcal/day (Mifflin-St Jeor)")
    print(f"  Intensity        : {cal.met:.1f} MET while jumping")
    print(f"  Jumping          : {cal.jumping_kcal:.0f} kcal")
    print(f"  Rests            : {cal.rest_kcal:.0f} kcal")
    print(f"  TOTAL burned     : {cal.total_kcal:.0f} kcal   (likely range {cal.low_kcal:.0f}–{cal.high_kcal:.0f})")
    print(f"  Extra vs. resting: {cal.net_kcal:.0f} kcal")
    if a.age is None or a.sex is None:
        print("  tip: add --age and --sex for a tighter estimate")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
