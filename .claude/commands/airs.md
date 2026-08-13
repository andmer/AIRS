---
description: Run a full match video through the AIRS AI-referee pipeline (annotate → two-pass adjudication via subagents → score/review/render). Usage — /airs videos/MATCH.mp4
---

Run the complete AIRS pipeline on the match video: **$ARGUMENTS**

You are the ORCHESTRATOR. You annotate the match and coordinate; you must NEVER perform
a perception or adjudication pass yourself — you will read ground truth below, which
contaminates you. Fresh subagents (isolated contexts) do the two passes. All model work
runs on Claude Code usage — no API key needed. Expect a 15-touch bout to take ~20–40
minutes and a meaningful amount of subscription usage; say so before starting.

## Phase 0 — preconditions

- Video file exists; `ffprobe` it (duration/resolution). node_modules present (else `npm install`).
- Derive a touch-id prefix from the filename (e.g. `Y12MS.mp4` → `y12ms`, ids `y12ms01`…).
  Grep clips/touches.csv to ensure the prefix is unused.
- Track progress with the task tools (annotate / ground truth / frames / two-pass / outputs).

## Phase 1 — detect lamp events

`node scripts/detect-lights.mjs $ARGUMENTS` → one line per candidate: `onset end sides(L|R|L+R)`.
Defaults are calibrated for USA Fencing 720p stream framing (overhead lamp panels).

**Calibrate before trusting it.** Find one clearly-lit moment and one calm moment (a
quick 1fps contact-sheet sweep of a 30s window works), then measure the lamp crops:
`ffmpeg -ss <t> -i <video> -frames:v 1 -vf "crop=<w:h:x:y>,signalstats,metadata=print" -f null -`
and read UAVG/VAVG. Baseline V ≈ 130; left lamp lit (red) pushes V up (+10 or more),
right lamp lit (green) pulls V down. Set thresholds ~6 below/above the lit values via
`LAMP_LEFT/LAMP_RIGHT/LAMP_L_THRESH/LAMP_R_THRESH` env overrides.

**Expect junk.** On cut-heavy broadcasts, half or more of the detections can be replays,
pre-bout graphics, or camera-cut artifacts — that is what Phase 2's classification is
for. A short lamp interval (<0.5s) usually means a camera cut truncated it, not a short
light: the onset may be real but verify it (see anchor refinement below). If detection
looks very noisy, a full-match 1fps timestamped contact-sheet survey
(`fps=1,scale=212:-2,drawtext=...pts...,tile=6x5`) is the reliable cross-check — it also
reveals score changes that happen with NO lamps (cards), which detection alone cannot see.

## Phase 2 — classify events and read ground truth (you, visually)

For each candidate event, extract two frames with ffmpeg:
- **onset frame** at `onset + 0.1s`
- **settled frame** at `min(onset + 10s, next_candidate_onset − 1.5s)` (last event: onset + 20s)

Read them in batches (tile several per image if helpful). For each event decide:
- **Replay/junk?** Blue border, "VIEW"/"REVIEW" tag, playback-% label, fencer-name banners,
  protocol/results screens, pre-bout graphics → DROP (broadcast replays re-show lamps).
- **Score** from the clearest display (overhead panels or bottom overlay), as-seen
  left|right. Screen-left fencer is "left" everywhere in this system.

**Orientation self-check (do this first):** on the first two or three single-lamp
events, the lit side MUST match the side whose score increments. If it doesn't, the lamp
crops are swapped or the orientation assumption is wrong — stop and recalibrate before
deriving anything.

Then fold live events in order against the running score:
- left +1 → ref call `left`; right +1 → `right`; unchanged + single lamp → annulled,
  EXCLUDE with a note.
- unchanged + both lamps → `simultaneous` — but NEVER conclude this from one frame.
  Video-reviewed touches settle 10–25 s late; confirm with a second, later frame (up to
  the next event's onset, or +25 s for the last event) before calling it simultaneous.
- Jump of 2, or a change that contradicts the lamp sides → there is probably a
  card-awarded point (score change with no lamps) hiding between the two events:
  extract a few frames across the gap, locate the no-lamp score change, EXCLUDE it as a
  card with a note, and keep the lamp event's own attribution. Only flag for manual
  review if you genuinely cannot resolve it — do not guess.

**Anchor refinement:** for any suspect onset (short/truncated lamp interval, camera cut
or pan near the light, or later, a perception agent reporting the action far from t=0),
extract a dense strip (2–10 fps tiled, or 30 fps over a ±1 s window, cropped if helpful)
and set the anchor at the first visibly-lit frame. When live lamps were cut away from,
the broadcast replay a few seconds later usually shows which lamps lit — use it for
`context.json`, and note the uncertainty.

Tiers: single-light → 1; two-light → 2; video-reviewed/messy → 3 (your judgment, noted
as non-referee judgment).

**Lamp-gap sanity check (proven necessary on JMS):** two lamps of one touch cannot light
more than ~0.2 s apart (120 ms lockout). If the detector's L and R onsets for one event
are further apart than that, the camera panned a name banner or graphic through a lamp
crop and one side is FAKE — extract a full frame mid-lamp-period and read the actual
panels before recording "both lights". Replays are equally polluting: their red/green
name banners can fake a lamp, so never take lamp sides from replay footage without a
full-frame check.

Write, per included touch:
- `clips/touches.csv` row: `<id>,<video>,<onset>`
- `clips/ground_truth.csv` row: `<id>,<call>,<tier>,<action>,<notes>` (action style:
  "single light right" / "two lights ref left" / "both lights no award"). Record lamp
  uncertainty in the notes column — it is the tracked record of lamp state.
- `frames/<id>/context.json`: exactly `{ "lights": { "left": bool|null, "right": bool|null } }`
  where `null` = unknown/not recorded. NOTHING else goes in this file — no notes, no
  outcome-adjacent text: its contents reach pass 2, so a stray comment can leak the answer.

## Phase 3 — extract frames

Loop `./scripts/extract-frames.sh <video> <onset> <id>` over the new rows. Spot-check one
touch: lamps lit in `+0000ms.jpg`/`+0060ms.jpg`, blades legible. If a perception agent
later reports the action sits far from t=0, the anchor is wrong (lamp detector can catch
a light late on camera cuts): re-extract with a corrected time and re-run that touch.

## Phase 4 — perception subagents (model: sonnet, one per touch, parallel batches of ~10)

Prompt template (substitute <id>; keep verbatim otherwise). For touches with a known
anomaly (camera pan, cut, uncertain anchor), append one factual sentence to step 2 —
e.g. "NOTE: the camera pans during this phrase — report what is genuinely visible and
degrade perception_quality honestly." Never hint at lights, calls, or expectations.
If the touch has a CV timeline (context.json `timeline` field), paste its text into the
prompt labeled "Derived timeline (primary evidence):" — the subagent still must not read
the file itself.

> Working directory: <project root>
>
> You are the PERCEPTION pass of a two-pass sabre adjudication probe. Follow these steps exactly:
> 1. Read prompts/00_rules_preamble.md and prompts/01_perception.md. Follow the perception prompt's instructions and output schema exactly, including its forbidden-vocabulary rule.
> 2. Read every file matching frames/<id>/*ms.jpg (20, unless the touch sits near the clip's start — trust the filenames). Each filename is that frame's offset in milliseconds relative to the scoring-box light: "-0320ms.jpg" = 320ms before the light, "+0060ms.jpg" = 60ms after. Study them in chronological order. LEFT/RIGHT = as seen in frame.
> 3. Do NOT read any other file in the project. Only the two prompt files and the frames of <id>.
> 4. Produce the perception JSON per the schema in 01_perception.md. Use the Write tool to save EXACTLY that JSON (nothing else) to results/interactive/p1-<id>.json, then end your reply with just: done <id>

## Phase 5 — adjudication subagents (model: opus, one per touch, after its p1 exists)

Substitute <id> and <lights> — where <lights> is the lights object YOU paste inline from
frames/<id>/context.json (e.g. `{"left": true, "right": false}`). The subagent must
never read the sidecar itself; passing it inline keeps this identical to the API path
(probe.mjs) and ensures nothing but the lights object can reach pass 2.

> Working directory: <project root>
>
> You are the ADJUDICATION pass of a two-pass sabre refereeing probe. You never see video frames — only the perception record. Follow these steps exactly:
> 1. Read prompts/00_rules_preamble.md and prompts/02_adjudication.md. Follow the adjudication prompt exactly, including its output schema, hard constraints, and calibration bands.
> 2. Read results/interactive/p1-<id>.json — the perception record for touch <id>.
> 3. Light state (human-recorded ground data; null = unknown): <lights>
> 4. Do NOT read any other file. You must not look at frames, context.json, anything in clips/, or any other results file.
> 5. Apply sabre convention to the perception record and produce the adjudication JSON per the schema. Use the Write tool to save EXACTLY that JSON (nothing else) to results/interactive/p2-<id>.json, then end your reply with just: done <id>

## Phase 6 — outputs

1. `node scripts/assemble-interactive.mjs <prefix>` → results/run-<stamp>-interactive.jsonl
   (must report 0 failed; chase any missing p1/p2 before continuing)
2. `node scripts/score.mjs <results file>` — the agreement report
3. `node scripts/review.mjs <results file>` — per-touch review page
4. `node scripts/render.mjs <results file>` — annotated match video
5. Verify the render: extract one frame from a known touch's segment and confirm the
   banner text (id, AIRS call, REF call) is present and correct before reporting.

## Final report

Lead with: does the AI agree with the referee? Overall agreement, the single-light vs
two-light split, abstentions, PERCEPTION vs JUDGMENT failure split, calibration, and
alternate-reading rescues. List excluded events (cards/annulled) and any anchors you
corrected. Give the paths to all three outputs.
