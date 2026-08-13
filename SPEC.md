# AIRS — AI Referee System: PRD / Spec

**Status: proof-of-concept validated on one real match (2026-08-13). Verdict: continue —
the rules engine holds; camera quality is the bottleneck. Current form: post-hoc batch
analysis. Target form (end of roadmap): near-real-time advisory calls at the strip.**

## 1. Product hypothesis

An AI can adjudicate sabre right-of-way from video well enough to be worth building a
refereeing/teaching system around. The measurable question at every phase: **does the
AI's independent call agree with the referee's** — and when it disagrees, *why*.

The end-state product is an **advisory** system: a second opinion delivered seconds after
the light, with calibrated confidence, an alternate reading, and the evidence — a video-
review assistant and training tool. An AI that overrules human referees is a non-goal.

## 2. The question that shapes the architecture

A wrong call has two very different causes with two very different fixes:

- **PERCEPTION failure** — the model misread the video (blur, resolution, occlusion).
  Fix: better capture — closer camera, higher fps, CV assistance.
- **JUDGMENT failure** — the model saw clearly and misapplied the convention.
  Fix: none downstream. If this dominates on clean footage, the idea does not work.

Everything below exists to keep those two separable. JMS result: 9/9 disagreements were
PERCEPTION, 0 JUDGMENT — which is why the roadmap invests in capture, not in rules.

## 3. Layer specification

Each layer lists: purpose → interface → current implementation → known limits → what
changes for real time (RT).

### L0 — Capture

- **Purpose**: get photons to pixels with enough spatiotemporal resolution to resolve
  the arm-then-foot test (decisive windows are 40–300ms; sabre lockout ≈ 120ms).
- **Interface**: video file (today) / live feed (RT). Requirement: fixed framing during
  phrases, both fencers + scoring lamps visible, known left/right orientation.
- **Current**: broadcast 720p30 wide shot. Fencers ≈150px, blades ≈1px.
- **Limits**: 30fps cannot order events inside a 33ms+ window; wide shot destroys blade
  detail; broadcast cuts/pans lose phrases entirely (JMS m29). This is the proven
  bottleneck.
- **RT path**: owned camera(s), strip-perpendicular, 720p+ at 120–240fps, tight framing
  or 2-camera (full-strip + center-strip). Ring buffer in memory (last ~4s) so the
  decisive window is already captured when the light fires. No broadcast dependency.

### L1 — Touch detection & segmentation

- **Purpose**: find each phrase's anchor (the light) and cut the analysis window.
- **Interface**: video → list of `(touch_id, light_time_s, lamp_sides)`; persisted as
  `clips/touches.csv` + `frames/<id>/context.json`.
- **Current**: `detect-lights.mjs` — chroma shift on the overhead lamp panels
  (signalstats, calibrated crops), merged L/R events; orchestrator triages live vs
  broadcast-replay visually and excludes cards/annulled events.
- **Limits**: calibrated per venue/stream framing; misses lights during camera cuts;
  replay triage needs a vision pass.
- **RT path**: replace pixel-watching with the **scoring box itself** — a hardware tap or
  photodiode/GPIO on the lamps gives millisecond-exact lockout events and sides, and
  eliminates replay/card ambiguity (no broadcast graphics exist on an owned feed).
  Fallback: same chroma detector running on the live buffer (adds ≤100ms).

### L2 — Ground truth (eval mode) / referee capture (RT mode)

- **Purpose**: the oracle. Offline: the referee's actual calls, derived from scoreboard
  transitions + lamp sides. RT: the referee's call captured *after* AIRS commits its
  own, turning every live touch into a labeled eval sample.
- **Interface**: `clips/ground_truth.csv` (`touch_id, call, tier, action, notes`).
- **Contamination rule (non-negotiable)**: ground truth never reaches a prompt; whoever
  has seen it never performs a pass. Enforced by isolated pass contexts and tested
  invariants (`npm test`).
- **Current**: orchestrating session reads scoreboard at settled points; cards (score
  change without lights) and annulled flashes excluded; tiers are non-referee judgment.
- **Limits**: manual/agent labor; tier labels unvalidated until coach review.
- **RT path**: scorekeeper input or scoreboard OCR *post-call*; AIRS's call is committed
  and timestamped before the referee's is recorded — the live system continuously
  measures its own agreement rate (L5 becomes monitoring).

### L3 — Perception (pass 1)

- **Purpose**: convert frames to physical facts, no rules vocabulary: arm extension
  timings + interruptions, foot events, blade contact with deflection magnitude
  (never "parry" — that's a ruling), hits, line, quality self-grade + reasons.
- **Interface**: 20 labeled frames in → `p1-<id>.json` (schema: `prompts/01_perception.md`).
  Optional `context.json.timeline` (CV measurements as text) is treated as primary
  evidence over pixels when present.
- **Current**: claude-sonnet, one isolated context per touch; 20 non-uniform frames
  anchored on the light (dense in the final 400ms), 768px, ~60–90s per touch.
- **Limits**: everything L0 can't show; honest degradation is working (quality grades
  drove all abstentions and all failure tagging in JMS).
- **RT path**: the big latency and accuracy lever is the **CV timeline layer**: pose
  estimation (arm angle, foot contact) + blade-region tracking computed continuously on
  the live buffer, emitted as text. Perception then reads a numeric timeline + a handful
  of keyframes instead of 20 images — smaller, faster (Haiku-class viable), and more
  accurate (numbers beat blurred pixels). Target ≤3s.

### L4 — Adjudication (pass 2)

- **Purpose**: apply sabre convention to the perception record. Never sees frames.
- **Interface**: `p1-<id>.json` + lamp state in → `p2-<id>.json`: phrase reconstruction,
  evidence, hard-case flags, rule cited, call, confidence (banded, calibration-checked),
  alternate reading, decisive uncertainty (schema: `prompts/02_adjudication.md`).
- **Current**: claude-opus, isolated context, ~30–60s per touch. `no_call` at ≤0.3
  confidence is a success state and is never tuned away.
- **Limits**: only as good as its input — by design. JMS showed zero rule-application
  failures on clean perception.
- **RT path**: already small (text-only, ~2k tokens in / ~1k out). Prompt caching +
  streaming brings it to ~2–5s. Confidence gates the output: high-confidence → show the
  call; contested band → show "split call" + both readings; low → abstain visibly.

### L5 — Scoring & evaluation → live monitoring

- **Purpose**: the measurement. Agreement vs referee; tier split; calibration table
  (accuracy must track confidence bands); abstention accounting; PERCEPTION/JUDGMENT
  disagreement report with rule cited and decisive uncertainty.
- **Interface**: results JSONL (meta row: models, prompt hash, mode) + ground truth →
  terminal report (`score.mjs`).
- **Current**: post-hoc. Semantics locked by golden tests.
- **RT path**: same math over a rolling window; agreement rate, calibration drift, and
  abstention rate become the live health dashboard of the deployed system. Prompt/model
  changes gate on the frozen golden set (labeled touches) before going live.

### L6 — Presentation

- **Purpose**: make results arguable and shareable.
- **Current**: `review.mjs` (per-touch HTML: filmstrip, timeline overlay, both panels),
  `render.mjs` (annotated video: AIRS vs REF banner, light flash, ¼-speed replay),
  private share artifacts.
- **RT path**: a strip-side/stream overlay showing the committed call + confidence within
  seconds of the light, with the phrase reconstruction one tap away; the post-hoc review
  page remains the deep-dive artifact.

### Orchestration (cross-cutting)

Two execution modes, same contracts: **API probe** (`probe.mjs`, canonical instrument,
needs a key; Batches API past ~100 touches) and **interactive mode** (`/airs
videos/MATCH.mp4` — Claude Code subagents on subscription usage, stamped
`mode: interactive`, not 1:1 comparable with API runs). RT requires the API mode: a
resident process consuming lockout events, not a chat session.

## 4. Decision criteria (pre-registered)

Continue if tier-1 agreement is high AND disagreements cluster as PERCEPTION. Stop if
tier 1 fails on clean perception or calibration is flat. Expected finding, not a bug:
30fps cannot resolve arm-then-foot; tier-3 touches should be flagged, not force-called.

## 5. Verification

| Layer | Failure mode | Check |
|---|---|---|
| Plumbing (L1 parse, L5 semantics, assembly) | code regression | `npm test`: hermetic stub pipeline, golden scorer numbers, assembler prefix filter |
| Annotations (L2) | lamp/scoreboard misread | `npm test` invariants: single-light call = lit side; sim ⇒ both lamps; manifest/gt/context 1:1 |
| Lamp detection (L1) | calibration drift | `npm run test:golden`: byte-exact JMS reproduction |
| Model judgment (L3/L4) | not unit-testable | the probe is the eval; regression = frozen golden touch set re-runs; RT = rolling agreement monitoring |

## 6. Results to date

**JMS.mp4** (Junior Men's Sabre, Summer Nationals 2026, Primus def. Lim 15–14; 31
analyzable touches; 2 card points + 1 annulled light excluded; interactive mode):
single-light **14/14 (100%)**; two-light priority **3/11 (27%)**; **9/9 disagreements
PERCEPTION, 0 JUDGMENT**; 5/9 misses named the referee's call as the alternate; 3
abstentions, all on degraded footage; calibration real (0.7–0.9 band → 93%, 0.4–0.7 →
38%). Share artifact:
https://claude.ai/code/artifact/fa395543-1ea5-4d5b-9c61-8e844eb1911f

## 7. Non-goals

- Replacing or overruling human referees; AIRS is advisory and pedagogical.
- Web UI / database / product infrastructure before the accuracy gates pass.
- Public distribution of junior athletes' footage; analysis pages shared person-to-person.

## 8. Roadmap — from batch to real time

Each phase has an exit gate; later phases are conditional on earlier gates.

**Phase A — post-hoc batch (done).** One match, hours of latency, interactive mode.
Gate passed: PERCEPTION-clustered failures, tier-1 100%, calibration real.

**Phase B — replicate & validate the oracle.** `/airs` on Y12MS.mp4 and Y14MS.mp4;
coach reviews `prompts/00_rules_preamble.md`, tier labels, and a sample of two-light
disagreements. *Gate: finding replicates across bouts; rules reference coach-approved.*

**Phase C — fix perception (the proven bottleneck).**
1. Capture experiment: same pipeline on owned footage — tight framing, then 120/240fps.
2. CV timeline layer feeding `context.json.timeline` (pose + blade track as text);
   perception prompt already treats it as primary evidence.
*Gate: two-light agreement ≥70% on tier-1/2 touches with coach-validated ground truth.
Until this gate passes, real-time work is premature — a fast wrong call is worthless.*

**Phase D — same-day automated pipeline.** API-mode runs (key provisioned), Batches for
cost; one command from video to outputs with no orchestrator judgment in the loop
(box-derived or hardware-logged light events replace visual triage). Frozen golden touch
set gates prompt/model changes. *Gate: full match processed unattended in <1 hour;
agreement within noise of Phase C.*

**Phase E — near-live advisory (target: call ≤15s after the light).** Resident process +
live camera ring buffer + scoring-box lockout trigger. Latency budget:

| Step | Budget |
|---|---|
| Lockout event → window cut from ring buffer | <0.5s |
| CV timeline extraction on the 4s window | 1–3s |
| Perception (timeline + keyframes, cached prompts, streaming) | ≤3s |
| Adjudication (text-only, cached, streaming) | 2–5s |
| Overlay render/commit | <1s |
| **Total** | **~8–12s** |

Confidence-gated output (call / split-call / visible abstention); AIRS's call committed
and timestamped before the referee's call is recorded; rolling agreement + calibration
monitoring. *Gate: sustained agreement at Phase-C levels, live, across a tournament day.*

**Phase F — strip-side assist (stretch).** Dedicated 240fps camera(s), box integration
hardened, sub-5s advisory via faster CV and smaller perception inputs; referee/coach UX
for consulting the second opinion during video review. Scope decided by Phase-E data.
