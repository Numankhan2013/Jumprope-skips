# Jump Rope Skip Counter 🪢

Film yourself skipping, then run one command. You get back:

- **how many skips** you did (plus how many sets, your longest streak, and your pace)
- **how long** you were actually jumping and how long you spent resting
- **how many calories** you burned, worked out from your skip rate, jumping time, weight, height, age and sex

It's meant for long sessions (thousands of skips) and for people who trip on the rope a lot. Every
time the rope catches, you stop, and you start again, the counter notices and starts a new set.
Those pauses are billed as rest, so they don't inflate your calorie number.

## On your phone (no install)

`web/` is a single web page that does the whole analysis **inside your phone's browser**: pick a
video from your gallery and get skips, sets, pace and calories. Nothing is uploaded, so there's
no file-size limit. It uses the same counting algorithm as the Python version (see below), and
scores 51/51 on the test clip in a real browser.

- **Fast path:** WebCodecs + [mp4box.js](https://github.com/gpac/mp4box.js) decode MP4/MOV with
  the phone's hardware decoder, faster than playing the video back. Works in current Chrome
  (Android) and Safari 16.4+ (iPhone). Handles the rotate flag that phones put on portrait videos,
  and files whose index is at the end.
- **Fallback:** if the fast path isn't available, it plays the video (muted) and analyses frames
  as they're shown. This runs at real-time speed and is less exact if the phone drops frames.
- **Check the count:** after analysis you can play your video with the live counter on top.

**Live site:** `docs/index.html` is the built, self-contained page. To publish it on GitHub Pages
(free, gives `https://numankhan2013.github.io/jumprope-skips/`):

1. On GitHub open the repo → **Settings** → **Pages**.
2. Under *Build and deployment*, set **Source: Deploy from a branch**.
3. Pick the branch that holds `docs/` and the **/docs** folder, then **Save**.
4. Wait about a minute and open the URL GitHub shows.

After changing anything in `web/`, rebuild with `python web/build.py` (writes `docs/index.html`).

**Other free hosts** (need your own account): Cloudflare Pages
(`npx wrangler pages deploy docs --project-name skip-count` → `skip-count.pages.dev`), or Vercel
(`npx vercel deploy docs --prod` → `*.vercel.app`). It's one static file, so any static host works.

## History, insights and cloud sync

After counting a video (or typing in a session under *Already know your count?*), tap **Save to
history**. The **Your history** card then shows skips today / this week / this month / all time,
your day streak, best set ever, recent pace, a 14-day bar chart, short insights (vs. last week,
pace trend, biggest day) and every saved session (tap × to delete).

Sessions live on your phone first. Under **Cloud sync**, sign in with Google to back them up to
Firebase (project `chasing-greatness`, free Spark plan) and see them on every device. Data sits in
`users/{uid}/skips/{id}` plus `users/{uid}/skipmeta/state` (profile and deletions); Firestore rules
let only you read or write your own data. Merging is newest-edit-wins per session, and deletions
sync too. Sign-in works on `numankhan2013.github.io` (an authorized domain in Firebase Auth).

The logic is in `web/journal.js`, which `web/build.py` inlines into `docs/index.html`.

## Install (command line)

```bash
pip install -r requirements.txt
```

(Python 3.9+. `mediapipe` is only needed if you want `--backend pose`.)

## Use

```bash
python -m jumprope_counter my_workout.mp4 --weight 70kg --height 175cm --age 25 --sex male
```

Units are flexible: `--weight 154lb`, `--height 5'9`, `--height 1.75m` all work.

```
  ── Skips ─────────────────────────────────
  Total skips      : 5132
  Sets             : 41  (87, 12, 230, 64, …)
  Best set         : 412 in a row
  Video length     : 58:10
  Time jumping     : 46:02
  Time resting     : 12:08
  Pace (jumping)   : 111 skips/min
  Tracker          : pose

  ── Calories ──────────────────────────────
  You              : 70.0 kg, 175 cm, age 25, male
  Resting burn     : 1674 kcal/day (Mifflin-St Jeor)
  Intensity        : 11.8 MET while jumping
  Jumping          : 633 kcal
  Rests            : 28 kcal
  TOTAL burned     : 661 kcal   (likely range 562–760)
  Extra vs. resting: 593 kcal
```
*(illustrative numbers)*

### Check the count yourself

```bash
python -m jumprope_counter my_workout.mp4 --weight 70 --height 175 \
    --annotate checked.mp4   # copy of your video with a live counter in the corner
    --plot bounce.png        # graph of your bounce with every counted skip marked
    --csv skips.csv          # timestamp of every skip
```

Watch `checked.mp4` for a minute. If the number goes up on every jump, you can trust the total.

### Already know your count? Skip the video

```bash
python -m jumprope_counter --skips 5000 --minutes 45 --rest-minutes 10 --weight 70 --height 175
```

### Other options

| flag | what it does |
|---|---|
| `--start 30 --end 1800` | only look at that part of the video (in seconds) |
| `--sensitivity 1.5` | set it higher if skips are being missed, lower (e.g. `0.7`) if it counts too many |
| `--backend pose` | use MediaPipe body landmarks instead of motion tracking (less accurate in testing, see below) |
| `--model lite/full/heavy` | pose model size, only for `--backend pose` |

## Filming tips (these matter more than anything else)

1. **Use a still camera.** Prop the phone up; don't hand-hold it.
2. **Keep your whole body in the frame**, head to feet, with some space above your head for the jump.
3. **Be the only person moving** in the shot.
4. Normal 30 fps is plenty. Light that's good enough to see you clearly is good enough.
5. Shoot from the front or side, whichever you like.

## How it works

**Counting.** Dense optical flow measures how everything in the frame moved since the previous
frame. Adding up the vertical motion of the moving pixels (that's you) gives a bounce signal: one
bump per jump. Frames where most of the picture moves are skipped, because that's the camera being
picked up, not you jumping. Then the program:

1. band-passes that signal to 0.8–5 Hz (48–300 jumps/min), which removes drift and jitter;
2. finds the stretches where you're actually bouncing, using a rolling amplitude check. Standing,
   fiddling with the rope, and **walking** (going up and down while also moving sideways) are
   thrown out;
3. counts one skip per bounce peak, with a minimum spacing based on your own cadence so that
   wobbles aren't counted twice;
4. rejects bumps much smaller than your typical skip at that point in the video, and trims the
   weak bump at each end of a set (the swing that starts it, and the hop where the rope catches
   your feet).

**Tested on real footage.** A 39 s phone clip with two camera angles (upper body only, then
full body), four rope catches, and two stretches of handling the phone. The ground truth of
**51 skips** was established independently of the program: slit-scan images, tracking the
sweater's stripe, the sound of the rope slapping the ground, and frame-by-frame checks of every
borderline moment. The program scores **51/51**: no misses, no extras, set sizes 19/9/10/5/8
exactly. MediaPipe pose tracking scored between 5 and 60 on the same clip, which is why motion is
the default.

On synthetic workouts with known answers (stumbles, rests, walking, 15 fps video, dropped frames)
it lands within ±1–2 skips per session. A 5,000+ skip session came out under 0.5 % off. See `tests/`.

**Different places.** Sound is never used, so the surface (grass, concrete, wood) doesn't
matter to the count. The verified clip was altered to simulate other locations and checked
against the same 51:

| condition | real skips found | extras |
|---|---|---|
| original | 51/51 | 0 |
| dim, grainy light | 51/51 | +2 |
| brightness pumping (clouds, auto-exposure) | 51/51 | +2 |
| trees swaying in the background | 51/51 | +1 |
| phone vibrating in time with your jumps | 51/51 | +1 |
| phone wobbling (badly propped) | 51/51 | 0 |
| filmed from 2× / 3× further away | 51/51 | +7 / +8 |

Camera shake is handled by measuring how the background moves (top of the frame and upper side
strips) and subtracting it. Filming from far away is the one real weak spot: the arm swing that
starts each set looks as big as a jump, adding about one skip per set. The phone page detects
this and asks you to move the phone closer (fill at least half the frame's height).

**Calories.** Calculated in three steps:

1. **Intensity from your real pace.** The *Compendium of Physical Activities* rates rope jumping
   at 8.8 MET for slow skipping (<100/min), 11.8 for moderate (100–120/min) and 12.3 for fast
   (120–160/min). The program blends between these using the pace measured from your video,
   counting only the time you were actually jumping.
2. **Your own metabolism, not a textbook average.** The usual "1 MET = 3.5 ml O₂/kg/min" is
   too high for most adults. So the program estimates *your* resting burn from weight, **height**,
   age and sex (Mifflin-St Jeor) and scales the MET by that. This is the "corrected MET" method
   (Kozey et al., 2010), and it's the step that uses your height.
   `kcal = MET × resting kcal/day ÷ 1440 × minutes`
3. **Rests count at a lower rate.** Pauses are billed at 2 MET (standing and recovering), not at
   jumping intensity.

"Extra vs. resting" subtracts what you'd have burned sitting still for the same time. Use that
number if you're tracking food intake against exercise.

**Accuracy, honestly:** the skip count can be close to exact with good footage. The calorie figure
is limited by science, not by this code: any estimate from weight, height and activity is about
±15–20 % for an individual, which is why the program prints a range. A chest-strap heart-rate
monitor is the only cheap way to do better.

## A note on a short rope

If your rope is too short you'll find yourself tucking your knees or hopping twice per turn. The
counter counts **jumps** (times you leave the ground), so a double-bounce counts as two. That
matches the energy you spent, but not the number of rope turns. A common rule for rope length:
stand on the middle of the rope and the handles should reach your armpits.

## Run the tests

```bash
pip install pytest && python -m pytest tests
```
