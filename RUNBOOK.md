# Runbook: match mp4 → annotated scoring video

**One-command path:** in a Claude Code session, `/airs videos/MATCH.mp4` automates steps
2–9 of this runbook via subagents on Claude Code usage (no API key), replacing manual
scrubbing with detector-assisted annotation — see `.claude/commands/airs.md`. The manual
steps below remain the reference for what the command does and for API runs.

From a raw match recording to a reassembled video with the AIRS call burned into every
touch. Times below assume a 15–35 touch bout. Ground truth (the referee's actual calls)
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

## 1. (Optional) Re-encode with dense keyframes

ffmpeg's input seeking (`-ss` before `-i`) is frame-accurate with re-encoded output, so
extraction works directly on the original — the validated JMS run did exactly that. The
dense re-encode matters for *player* scrubbing (HTML5/QuickTime seeks are
keyframe-approximate) and as a fix if extracted frames ever look offset from their
labels:

```bash
ffmpeg -i videos/MATCH.mp4 -g 1 -c:v libx264 -crf 18 -an clips/match-dense.mp4
```

## 2. Find and log every touch  (~1-2 min per touch)

Fast path: `node scripts/detect-lights.mjs videos/MATCH.mp4` finds lamp events by chroma
shift (calibrate crops per venue — see `.claude/commands/airs.md` Phase 1); verify each
candidate against full frames, watching for the lamp-gap trap (two lamp onsets >0.2s
apart = a camera pan faked one side). Manual path: frame-step in mpv (`.` / `,`).
For each touch:

1. Find the **first frame where a scoring lamp is lit**. That timestamp in seconds
   (e.g. `74.312`) is the light time — the anchor everything else hangs off.
2. Append a row to `clips/touches.csv`:  `m01,videos/MATCH.mp4,74.312`
3. Record which lamps lit in `frames/m01/context.json` — exactly
   `{ "lights": { "left": bool|null, "right": bool|null } }`, null = unknown. Nothing
   else goes in this file (its contents reach pass 2; a stray note can leak the answer).
   Record lamp uncertainty in ground_truth.csv's notes column instead — that is the
   tracked record (sidecars are untracked).

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

`clips/ground_truth.csv` holds real match data (currently the 31 JMS touches). New
matches append rows under their own id prefix; never edit existing matches' rows except
to correct a verified annotation error. (The original 15-row starter template lives on
as the test fixture in `tests/fixtures/ground_truth.csv`.)

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

Full-resolution pages run ~1MB per touch. For a shareable (<16MB) edition, build
downscaled thumbnails and point the generator at them with `FRAMES_ROOT`:

```bash
for d in frames/m*/; do id=$(basename "$d"); mkdir -p /tmp/frames-small/$id; \
  for f in "$d"*ms.jpg; do ffmpeg -loglevel error -y -i "$f" -vf scale=420:-2 -q:v 8 \
  "/tmp/frames-small/$id/$(basename "$f")"; done; done
FRAMES_ROOT=/tmp/frames-small node scripts/review.mjs results/run-<stamp>.jsonl
```

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

- **Contamination**: `context.json` lights feed the adjudication pass (ground data);
  `touches.csv` feeds extraction and the post-hoc tools; `ground_truth.csv` calls must
  never reach a prompt — they are for score/review/render only. If you want to hint the
  model, stop (see CLAUDE.md non-negotiables).
- **30 fps ceiling**: tier-3 touches (hand-vs-foot, contested tempo) are expected to be
  unresolvable at 30 fps. Correct behavior is a hard-case flag and a hedged or abstained
  call — that is a finding. Re-shoot at 240 fps before concluding the model can't do it.
- **Stub runs render too** (banners come from canned data; the stub notice appears in
  the terminal and on the review page, not burned into the mp4) — useful for checking
  the video pipeline before the API run.
