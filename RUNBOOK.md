# Runbook: match mp4 → annotated scoring video

**One-command path:** in a Claude Code session, `/airs videos/MATCH.mp4` runs this whole
runbook via subagents on Claude Code usage (no API key) — see `.claude/commands/airs.md`.
The manual steps below remain the reference for what the command does and for API runs.

From a raw match recording to a reassembled video with the AIRS call burned into every
touch. Times below assume a ~15-touch bout. Ground truth (the referee's actual calls)
only ever feeds the post-hoc tools — the probe reads touch ids and nothing else.

## 0. One-time setup

```bash
cd ~/Projects/AIRS
npm install
export ANTHROPIC_API_KEY=sk-ant-...     # nothing loads a .env; export it
ffmpeg -version                          # brew install ffmpeg if missing
brew install ffmpeg-full                 # needed by step 9 — plain ffmpeg has no drawtext
```

Optional smoke test of the whole pipeline without spending anything:
`PROBE_STUB=1 node scripts/probe.mjs && node scripts/score.mjs results/run-<stamp>.jsonl`

## 1. Re-encode the match with dense keyframes  (~minutes, once)

Seeks in the original are keyframe-approximate; every later step depends on
frame-accurate timestamps. Do this first, use the dense file everywhere after:

```bash
ffmpeg -i match.mp4 -g 1 -c:v libx264 -crf 18 -an clips/match-dense.mp4
```

## 2. Scrub the match and log every touch  (~1-2 min per touch)

Open `clips/match-dense.mp4` in a player with frame-stepping (mpv: `.` and `,` step
frames, timestamp on screen; QuickTime: arrow keys when paused). For each touch:

1. Find the **first frame where a scoring lamp is lit**. That timestamp in seconds
   (e.g. `74.312`) is the light time — the anchor everything else hangs off.
2. Append a row to `clips/touches.csv`:  `t001,clips/match-dense.mp4,74.312`
3. Record which lamps lit in `frames/t001/context.json` (create the dir; copy the shape
   from `frames/context.example.json` — lights only, the timeline slot stays empty until
   a CV layer exists). This is human-recorded ground data for the adjudication pass.

Skip touches where the camera cut away mid-phrase — there is nothing to perceive.

## 3. Record ground truth  (~30 s per touch)

Append the referee's actual call to `clips/ground_truth.csv`:

```
touch_id,call,tier,action,notes
```

- `call` is `left|right|simultaneous` **as seen on screen** — screen-left fencer is
  "left" everywhere in this system; if a clip is mirrored, enter the row as-seen.
- `tier`: 1 = unambiguous, 2 = textbook but harder, 3 = genuinely contested (referees
  would split). Tier is your judgment; the seeded template rows show the intent.
- Read the call off the referee's hand signal / score change, not your own opinion.

The 15 seeded template rows are a shot list, not data — replace them with real touches
(or keep ids distinct and delete the template rows before scoring).

## 4. Extract frames  (~seconds per touch)

```bash
tail -n +2 clips/touches.csv | grep -v '^#' | while IFS=, read -r id clip light; do
  ./scripts/extract-frames.sh "$clip" "$light" "$id"
done
open frames/t001/     # eyeball: light visible in +0060ms.jpg, blades legible
```

If a frame looks off by more than a few ms from its label, step 1 was skipped or the
light time is wrong — fix before spending a run.

## 5. Perception sanity pass before paying for a full run

```bash
node scripts/probe.mjs t001 --pass1-only
```

Read the perception JSON in the results file. If the model can't see the blade on your
cleanest touch, fix capture (angle, light, backdrop) before burning a full run. For
free iteration on prompts, use interactive mode instead (CLAUDE.md → Interactive mode).

## 6. Full probe run  (~1-2 min per touch, 2 API calls each)

```bash
node scripts/probe.mjs                       # all touches in ground_truth.csv
# → results/run-<stamp>.jsonl  (meta row stamps models + prompt hash)
```

Per-touch failures (parse errors, refusals, truncation) are logged into the results
file and the run continues — don't babysit it.

## 7. Score

```bash
node scripts/score.mjs results/run-<stamp>.jsonl
```

Read bottom-up: the DISAGREEMENT report (PERCEPTION vs JUDGMENT split) is the
deliverable; the percentage is the least interesting line. Also check abstentions on
good perception, ALTERNATE-READING FAILURES, and the calibration warning.

## 8. Visual review (per-touch HTML)

```bash
node scripts/review.mjs results/run-<stamp>.jsonl        # or: ... t003 t007
open reviews/run-<stamp>.html
```

Filmstrip + timeline overlay of the perception record + both panels per touch. This is
the page to argue with a coach over.

## 9. Render the annotated match video

```bash
node scripts/render.mjs results/run-<stamp>.jsonl        # or: ... t003 t007
open renders/run-<stamp>-annotated.mp4
```

Per touch: the approach and light at full speed with the banner burned in (AIRS call,
confidence, rule vs REF call, AGREE/DISAGREE with the PERCEPTION/JUDGMENT tag, alternate
reading on misses), a red border flash at the light instant, then a 1/4-speed replay of
the final action — all touches concatenated in run order. Per-touch segments stay in
`renders/segments/` for cutting your own edit; everything under `renders/` is
regenerable and safe to delete.

Banners are drawn with ffmpeg's drawtext filter. Homebrew's plain `ffmpeg` formula is
built **without** text rendering — the render step needs `brew install ffmpeg-full`
(keg-only; render.mjs auto-detects it at `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`,
override with `FFMPEG=`). Font and size are `BANNER_FONT` (default Menlo) and
`BANNER_FONTSIZE` (default `h/26`, scales with resolution).

## Pitfalls

- **Contamination**: `touches.csv` and `context.json` (lights) may feed the probe;
  `ground_truth.csv` calls must not — they are for score/review/render only. If you
  want to hint the model, stop (see CLAUDE.md non-negotiables).
- **30 fps ceiling**: tier-3 touches (hand-vs-foot, contested tempo) are expected to be
  unresolvable at 30 fps. Correct behavior is a hard-case flag and a hedged or abstained
  call — that is a finding. Re-shoot at 240 fps before concluding the model can't do it.
- **Stub runs render too** (banners come from canned data, output is stamped as such) —
  useful for checking the video pipeline before the API run.
