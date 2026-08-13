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
Calibrated for USA Fencing 720p stream framing (overhead lamp panels). If output is empty
or absurd, extract a frame at a known touch, locate the lamp panels visually, and re-run
with `LAMP_LEFT/LAMP_RIGHT/LAMP_L_THRESH/LAMP_R_THRESH` env overrides.

## Phase 2 — classify events and read ground truth (you, visually)

For each candidate event, extract two frames with ffmpeg:
- **onset frame** at `onset + 0.1s`
- **settled frame** at `min(onset + 10s, next_candidate_onset − 1.5s)` (last event: onset + 20s)

Read them in batches (tile several per image if helpful). For each event decide:
- **Replay/junk?** Blue border, "VIEW"/"REVIEW" tag, playback-% label, fencer-name banners,
  protocol/results screens, pre-bout graphics → DROP (broadcast replays re-show lamps).
- **Score** from the clearest display (overhead panels or bottom overlay), as-seen
  left|right. Screen-left fencer is "left" everywhere in this system.

Then fold live events in order against the running score:
- left +1 → ref call `left`; right +1 → `right`; unchanged + both lamps → `simultaneous`;
  unchanged + single lamp → annulled, EXCLUDE with a note.
- Score changed with NO lamp event between two touches → card-awarded point: not a
  phrase, exclude and note it in the final report.
- Any other jump → flag for manual review; do not guess.

Tiers: single-light → 1; two-light → 2; video-reviewed/messy → 3 (your judgment, noted
as non-referee judgment).

Write, per included touch:
- `clips/touches.csv` row: `<id>,<video>,<onset>`
- `clips/ground_truth.csv` row: `<id>,<call>,<tier>,<action>,<notes>` (action style:
  "single light right" / "two lights ref left" / "both lights no award")
- `frames/<id>/context.json`: `{ "lights": { "left": bool, "right": bool } }`

## Phase 3 — extract frames

Loop `./scripts/extract-frames.sh <video> <onset> <id>` over the new rows. Spot-check one
touch: lamps lit in `+0000ms.jpg`/`+0060ms.jpg`, blades legible. If a perception agent
later reports the action sits far from t=0, the anchor is wrong (lamp detector can catch
a light late on camera cuts): re-extract with a corrected time and re-run that touch.

## Phase 4 — perception subagents (model: sonnet, one per touch, parallel batches of ~10)

Prompt template (substitute <id>; keep verbatim otherwise):

> Working directory: <project root>
>
> You are the PERCEPTION pass of a two-pass sabre adjudication probe. Follow these steps exactly:
> 1. Read prompts/00_rules_preamble.md and prompts/01_perception.md. Follow the perception prompt's instructions and output schema exactly, including its forbidden-vocabulary rule.
> 2. Read every file matching frames/<id>/*ms.jpg (there are 20). Each filename is that frame's offset in milliseconds relative to the scoring-box light: "-0320ms.jpg" = 320ms before the light, "+0060ms.jpg" = 60ms after. Study them in chronological order. LEFT/RIGHT = as seen in frame.
> 3. Do NOT read any other file in the project. Only the two prompt files and the 20 frames of <id>.
> 4. Produce the perception JSON per the schema in 01_perception.md. Use the Write tool to save EXACTLY that JSON (nothing else) to results/interactive/p1-<id>.json, then end your reply with just: done <id>

## Phase 5 — adjudication subagents (model: opus, one per touch, after its p1 exists)

> Working directory: <project root>
>
> You are the ADJUDICATION pass of a two-pass sabre refereeing probe. You never see video frames — only the perception record. Follow these steps exactly:
> 1. Read prompts/00_rules_preamble.md and prompts/02_adjudication.md. Follow the adjudication prompt exactly, including its output schema, hard constraints, and calibration bands.
> 2. Read results/interactive/p1-<id>.json — the perception record for touch <id>.
> 3. Read frames/<id>/context.json — the human-recorded scoring-box light state (treat as ground data).
> 4. Do NOT read any other file. You must not look at frames, anything in clips/, or any other results file.
> 5. Apply sabre convention to the perception record and produce the adjudication JSON per the schema. Use the Write tool to save EXACTLY that JSON (nothing else) to results/interactive/p2-<id>.json, then end your reply with just: done <id>

## Phase 6 — outputs

1. `node scripts/assemble-interactive.mjs <prefix>` → results/run-<stamp>-interactive.jsonl
2. `node scripts/score.mjs <results file>` — the agreement report
3. `node scripts/review.mjs <results file>` — per-touch review page
4. `node scripts/render.mjs <results file>` — annotated match video

## Final report

Lead with: does the AI agree with the referee? Overall agreement, the single-light vs
two-light split, abstentions, PERCEPTION vs JUDGMENT failure split, calibration, and
alternate-reading rescues. List excluded events (cards/annulled) and any anchors you
corrected. Give the paths to all three outputs.
