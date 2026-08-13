# Project context for Claude Code

This is a **falsification probe**, not a product. Its single job is to answer whether an
LLM can adjudicate sabre priority well enough to be worth building a system around. It
should stay small enough to throw away. (A previous build of the same idea lives in
`../airs1`; this version merges its contract with a v2 schema and fixes its scorer.)

## Non-negotiables

- **Ground truth never enters a prompt.** `clips/ground_truth.csv` is read by `probe.mjs`
  only to enumerate touch ids, and by `score.mjs` after the fact. Any change that lets the
  expected call reach the model invalidates every result produced since. If you need a
  contaminated variant for debugging, fork the script and name it `probe-contaminated.mjs`.
- **The two passes stay separate.** Perception describes; adjudication decides. Merging
  them into one call would be cheaper and would destroy the ability to tell a blade-reading
  failure from a rule-application failure. That distinction is the point. The separation
  runs through the schema too: perception reports physical facts only (blade `deflection`
  magnitude, never "parry"; `left`/`right` screen position, never "attacker").
- **`no_call` is a success state.** Do not tune prompts to reduce it, and do not let the
  scorer count abstentions as misses — `score.mjs` deliberately excludes them from the
  accuracy denominator and reports them on their own line, split by perception quality.
  Suppressing honest abstention is how you get a system that narrates confidently over
  footage it cannot see.
- **Frames are labelled by offset in the filename.** `-0320ms.jpg` is read by `probe.mjs`
  and turned into the text label the model sees. Do not rename frames.
- **`left`/`right` means screen position in the frames.** Ground truth must be recorded in
  the same frame of reference: fixed camera side per clip, and if a clip is mirrored, enter
  the CSV row as-seen. The scoring-box light state in `context.json` follows the same
  convention.

## Layout

```
prompts/00_rules_preamble.md   cached in both passes — the priority reference
prompts/01_perception.md       pass 1, describe only, no priority vocabulary
prompts/02_adjudication.md     pass 2, apply convention to the perception record
scripts/extract-frames.sh      ffmpeg, non-uniform sampling anchored on the box light
scripts/probe.mjs              two-pass runner, prompt caching, defensive JSON parsing, stub mode
scripts/score.mjs              accuracy, calibration bands, abstentions, disagreement report
scripts/review.mjs             post-hoc visual review: filmstrip + timeline overlay + analysis → reviews/*.html
scripts/render.mjs             post-hoc annotated match video (banner, light flash, slow replay) → renders/*.mp4
scripts/detect-lights.mjs      lamp-event detection via chroma shift on the overhead lamp panels (no model calls)
scripts/assemble-interactive.mjs  merge interactive-mode p1/p2 files into results JSONL (optional id-prefix arg)
.claude/commands/airs.md       /airs videos/MATCH.mp4 — full pipeline as a slash command (subagent playbook)
clips/touches.csv              manifest written while scrubbing: touch_id, clip, light_time_s
RUNBOOK.md                     match mp4 → annotated scoring video, step by step
SPEC.md                        PRD/spec: hypothesis, architecture, decision criteria, results, roadmap
tests/                         npm test (plumbing + annotation invariants), npm run test:golden (lamp detector)
clips/ground_truth.csv         touch_id, call, tier, action, notes — the referee's calls (real data; lamp state encoded in action/notes)
frames/<touch_id>/             extracted frames + context.json lamp sidecar (both untracked; sidecar = lights object ONLY, no notes)
videos/                        raw match footage (untracked, too large for git)
results/run-<stamp>.jsonl      first line is a meta row (models, prompt hash, stub flag, mode)
results/interactive/           per-touch p1-/p2- pass files from interactive-mode subagents (untracked)
```

`frames/context.example.json` shows the optional per-touch sidecar: the **human-recorded
light state** (known at annotation time — more reliable than asking the vision model to
read lamps out of pixels) and, once a CV layer exists, a derived measurement timeline.
The timeline slot matters — arm angles as text are read far more reliably than arm angles
inferred from motion-blurred JPEGs, so when the CV layer lands, accuracy should jump
without any prompt change.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...        # nothing loads a .env file; export it
./scripts/extract-frames.sh videos/MATCH.mp4 74.312 m01
node scripts/probe.mjs m01 --pass1-only    # eyeball perception before spending a full run
node scripts/probe.mjs
node scripts/score.mjs results/run-<stamp>.jsonl
```

Dry run without an API key or frames: `PROBE_STUB=1 node scripts/probe.mjs` uses
deterministic canned responses (including one intentional parse failure, for ids ending
in "6") so the whole pipeline down through the disagreement report can be exercised for
free. The results meta row is stamped `stub: true` so a stub run can never be mistaken
for data.

Models are `claude-sonnet-5` (perception) and `claude-opus-5` (adjudication), overridable
via `PERCEPTION_MODEL` / `ADJUDICATION_MODEL`. Both models run adaptive thinking by
default and `max_tokens` caps thinking + JSON together — that is why it is 8000, not
2000; lowering it risks truncated JSON (`stop_reason: max_tokens`, surfaced in the
per-touch error).

## Interactive mode (Claude Code, no API key)

For debugging prompts and schemas, a Claude Code session can run both passes with
subagents instead of probe.mjs. The discipline that makes this valid:

- **One subagent per pass, fresh context each.** The pass-1 subagent gets
  `00_rules_preamble.md` + `01_perception.md` and Reads the frames in `frames/<id>/`
  (Claude Code renders JPEGs; the filenames carry the offsets). The pass-2 subagent gets
  the preamble + `02_adjudication.md` + the perception JSON + the lights object pasted
  INLINE by the orchestrator — it never reads context.json itself and never sees frames.
  (Inline keeps it byte-equivalent to what probe.mjs sends, and guarantees nothing but
  the lights object can reach pass 2.)
- **The orchestrating session must not do either pass inline.** It has usually read
  `ground_truth.csv` and the frames, so it is contaminated by construction. Subagents
  inherit nothing from the session's context; they are clean as long as the expected
  call is never pasted into their prompts.
- Pin subagent models to match the probe (perception: sonnet, adjudication: opus).
- Append rows to `results/run-<stamp>-interactive.jsonl` with a meta row containing
  `"mode": "interactive"` — score.mjs works unchanged. Interactive runs are valid
  proof-of-concept evidence (the JMS results in SPEC.md are one), but they are not
  1:1 comparable with API runs — the Claude Code harness system prompt differs from a
  raw API call, and they bill Claude Code usage rather than the API key. The API probe
  is the canonical instrument for cross-run comparisons once a key exists.

## Cost

Roughly 20 frames at 768px plus text, times two passes. The rules preamble and pass
prompt are cached (`cache_control` on the system blocks), so the marginal cost per touch
after the first is modest. A 15-touch run is small. Before scaling past ~100 touches,
move offline runs to the Batches API.

## What good and bad look like

Continue if tier 1 accuracy is high and the failures cluster as PERCEPTION. Perception
failures are an engineering problem — better capture, higher frame rate, the CV layer.

Stop and rethink if tier 1 fails on clean perception, or if calibration is flat (the
scorer prints an explicit CALIBRATION FAILURE warning when >90% of decided calls sit
above 0.9). Flat calibration means the confidence signal is noise, and the confidence
signal is what makes the eventual teaching tool honest rather than authoritative-sounding.

Also read: abstentions on *good* perception (over-abstention), and the
ALTERNATE-READING FAILURES section — alternate "none" on a tier 2/3 touch means the
model is not modelling the distribution of defensible calls.

## Things that will waste your afternoon

- HTML5 and ffmpeg seeks are keyframe-approximate. If a frame looks off by more than a few
  ms from its label, re-encode the clip with dense keyframes first:
  `ffmpeg -i in.mp4 -g 1 -c:v libx264 -crf 18 out.mp4`
- 30 fps source cannot resolve the arm-then-foot test. Expect tier 3 to be unresolvable
  until you shoot at 240 fps. **That is a finding, not a bug** — a correct outcome is the
  model flagging `hand_vs_foot_timing` and abstaining or hedging, not conjuring a call.
- Broadcast footage cuts away mid-phrase. Check the frames before blaming the model.

## Footage note

Coach-staged clips train and debug. Filming minors needs a specific written release
covering third-party API transmission — a standard camp photo release does not cover it.
Keep marked-up clips local.
