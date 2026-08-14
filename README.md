# AIRS — AI Referee System for Sabre

**The question:** can an AI, shown only what a camera sees, make the same right-of-way
call as a certified referee?

AIRS is a **falsification probe** built to answer that question before anything bigger
gets built. The measurement is always the same: a blind AI call vs. the referee's actual
call, touch by touch, on real tournament footage. Three matches (83 touches) have been
through the pipeline so far. The headline: **100% agreement on single-light touches
across every run; two-light priority calls are the wall, and every miss traces to one
specific, fixable perception gap.**

---

## Executive summary of the approach

### Two AI passes, deliberately separated

Every touch runs through two isolated model calls that never share context:

```
video ──► frame extraction ──► PASS 1: PERCEPTION ──► physical-fact JSON ──► PASS 2: ADJUDICATION ──► call JSON
           20 frames around      (claude-sonnet,           what happened        (claude-opus, never sees
           the scoring light      sees only frames)         and when             frames; gets perception
                                                                                 record + lamp state)
```

1. **Perception** (Claude Sonnet) sees only 20 JPEG frames sampled non-uniformly around
   the scoring light — densest in the final 400ms, where the decision lives. It reports
   *physical facts only*: when each arm starts and completes extension, when each foot
   lands, when and how blades contact, whether hits arrive. It is **forbidden from using
   refereeing vocabulary** ("attack", "parry" — it says "deflection" with a magnitude) and
   **forbidden from reading the scoring lamps** out of the pixels. Fencers are `left` /
   `right` by screen position, never "attacker".
2. **Adjudication** (Claude Opus) **never sees a single frame.** It receives the
   perception JSON plus the human-verified lamp state, applies sabre right-of-way
   convention, and produces a call, a confidence, a rule citation, a phrase
   reconstruction, an alternate reading with plausibility, and the single decisive
   uncertainty that would flip its call.

The separation is the point. When the AI disagrees with the referee, the two-pass split
tells us whether it **saw** the action wrong (a camera/engineering problem) or
**reasoned** wrong (a rules problem that would kill the concept). So far, every miss
traces to perception.

### A strict blindness firewall

- The referee's call **never reaches a prompt**. `clips/ground_truth.csv` is read only to
  enumerate touch ids before a run and to score results after it.
- Each pass runs in a fresh, isolated context. In interactive mode the orchestrating
  session — which has read the ground truth by necessity — never performs a pass itself.
- Pass 2's only ground data is the lamp state, pasted inline as a bare
  `{"lights": {"left": bool|null, "right": bool|null}}` object. The sidecar file that
  stores it contains nothing else, so nothing else *can* leak.

### Ground truth is derived, verified, and physics-checked

The referee's calls are reconstructed from the broadcast, independently of the AI:

- **Lamp detection** (`scripts/detect-lights.mjs`): chroma-shift analysis on the overhead
  lamp panels finds candidate scoring events — no model calls involved.
- **Score folding**: every candidate is classified against scoreboard transitions
  (left +1 → referee called left, and so on), and the full sequence must fold exactly
  into the final score before the annotation is accepted.
- **Full-frame verification with a physics check**: two lamps of one touch cannot light
  more than ~0.2s apart (the sabre lockout is ~120ms). Any detector event violating that
  is verified against full frames — this rule caught multiple camera-pan fakes,
  broadcast-replay banners impersonating lamps, and one corrupted annotation in an
  earlier run.
- Broadcast hazards are handled explicitly: replays, video-review delays (scores settle
  10–25s late), card-awarded points (score change with no lamps, excluded), pre-bout
  test lights, and cameras that cut away mid-phrase.

### Honesty is engineered in, not hoped for

- **Abstention is a success state.** When footage is genuinely unreadable, the correct
  output is `no_call` at low confidence. The scorer excludes abstentions from the
  accuracy denominator and reports them separately, split by perception quality —
  and the prompts are never tuned to suppress them.
- **Failure attribution.** Every disagreement is tagged PERCEPTION (the model reported
  degraded perception quality) or JUDGMENT (perception was good, so the reasoning is at
  fault). The scorer warns loudly when the attribution becomes degenerate (no
  good-quality perception rows, so JUDGMENT is unreachable).
- **Calibration is measured.** Accuracy must track the confidence band; the scorer
  prints an explicit CALIBRATION FAILURE warning when confidence is noise.
- **Alternate readings are scored.** A miss whose alternate reading names the referee's
  call is a near-miss a teaching tool can surface — tracked as "rescues".

## Results to date (three real matches, 83 touches)

| Match | Bout | Decided | Single-light | Two-light | Abstained |
|---|---|---|---|---|---|
| JMS (Junior Men's Sabre) | Primus d. Lim 15-14 | 20/28 (71%) | **15/15** | 4/11 | 3 |
| Y12MS (Y12 Men's Sabre) | Gu d. Koren 15-9 | 14/25 (56%) | **8/8** | 4/13 | 1 |
| Y14MS (Y14 Men's Sabre) | Wei d. Yang 15-11 | 13/21 (62%) | **10/10** | 3/10 | 5 |

- **Single-light touches: 33/33 across all runs.** When the box already says who hit,
  the AI has never contradicted the referee.
- **Two-light priority calls are the wall (~30–50%)** — and the failure is *specific*:
  in essentially every miss the adjudicator names the same decisive uncertainty — did
  that blade contact **deflect** the attack (a parry, priority passes) or **graze** it
  (a brush, priority holds)? 30fps/720p broadcast video cannot resolve it, so the
  convention logic defaults to the visible attacker. In most misses the referee's call
  appears as the AI's alternate reading (JMS 8/8, Y12MS 8/11, Y14MS 5/8 rescues).
- **Calibration works.** Best run (Y14MS): 0.9+ band 3/3, 0.7–0.9 band 6/6, 0.4–0.7
  band 33% — when the system is confident it has been right, and when it is unsure it
  says so. That property is what makes an honest teaching tool possible.
- **Abstentions land exactly where they should**: camera cutaways, pans, and
  never-broadcast lamps, all at 0.15–0.25 confidence.

**Verdict so far: the rules engine holds; the camera is the bottleneck.** The roadmap
therefore targets exactly two things — higher-speed capture (240fps) and a CV layer that
measures blade contact (the single missing signal) — feeding the same adjudicator
unchanged. See `SPEC.md` §8 for the phased path from batch analysis to a ≤15s live
advisory call.

---

## Repository layout

```
prompts/00_rules_preamble.md   cached in both passes — the priority reference
prompts/01_perception.md       pass 1, describe only, no priority vocabulary
prompts/02_adjudication.md     pass 2, apply convention to the perception record
scripts/extract-frames.sh      ffmpeg, non-uniform sampling anchored on the box light
scripts/probe.mjs              two-pass API runner (prompt caching, stub mode)
scripts/score.mjs              accuracy, calibration, abstentions, disagreement report
scripts/review.mjs             interactive review page: filmstrip + animated timeline player
scripts/render.mjs             annotated match video with live converging-timeline overlay
scripts/detect-lights.mjs      lamp-event detection via chroma shift (no model calls)
scripts/assemble-interactive.mjs  merge interactive-mode pass files into a results JSONL
.claude/commands/airs.md       /airs videos/MATCH.mp4 — the full pipeline as a slash command
clips/touches.csv              touch_id, clip, light_time_s (annotation manifest)
clips/ground_truth.csv         the referee's calls — read only by post-hoc tools
frames/<touch_id>/             extracted frames + lamp sidecar (untracked)
results/run-<stamp>.jsonl      one run = one file; first line is a meta row
reviews/  renders/             human-facing outputs (tracked as deliverables)
tests/                         npm test (plumbing + annotation invariants), golden lamp test
SPEC.md                        PRD: hypothesis, layer spec L0–L6, decision criteria, roadmap
RUNBOOK.md                     match mp4 → annotated scoring video, step by step
CLAUDE.md                      working agreements & non-negotiables for AI-assisted sessions
```

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...           # nothing loads a .env; export it
brew install ffmpeg-full                       # render step needs drawtext

# free end-to-end smoke test (deterministic canned responses, stamped stub:true)
PROBE_STUB=1 node scripts/probe.mjs
node scripts/score.mjs results/run-<stamp>.jsonl

# real run over annotated touches
node scripts/probe.mjs                         # or: probe.mjs m01 --pass1-only
node scripts/score.mjs  results/run-<stamp>.jsonl
node scripts/review.mjs results/run-<stamp>.jsonl
node scripts/render.mjs results/run-<stamp>.jsonl
```

**One-command path:** in a Claude Code session, `/airs videos/MATCH.mp4` runs the whole
pipeline — detector-assisted annotation, ground-truth folding with full-frame lamp
verification, frame extraction, both model fleets in isolated subagents, scoring, and
both visual outputs. See `RUNBOOK.md` for the manual reference procedure.

### Interactive mode vs API mode

Without an API key, a Claude Code session can run both passes with **subagents** (fresh
context per pass, models pinned to match the probe, results stamped `mode:
"interactive"`). This is valid proof-of-concept evidence and is how the current results
were produced, but interactive runs are not 1:1 comparable with API runs; `probe.mjs`
against the API is the canonical instrument for cross-run comparisons. `CLAUDE.md`
documents the discipline that keeps interactive mode blind.

## The outputs

- **Review page** (`reviews/*.html`, self-contained dark-mode HTML): per touch — a
  clickable filmstrip, a large frame viewer, and an **animated timeline player**: the
  left fencer's blue line grows in from the left, the right fencer's red line from the
  right, event dots pop in true time order as each line reaches them, and the lines meet
  at the centre LIGHT line at the touch. Space = play/pause, ←/→ = frame-by-frame.
  Below it, the full perception record and adjudication (rule cited, evidence, alternate
  reading, decisive uncertainty) side by side.
- **Annotated match video** (`renders/*-annotated.mp4`): every touch cut from the source
  with the AIRS call vs REF call banner burned in, a red flash at the light, the same
  converging timeline animated live under the footage (with per-lane event tickers), and
  a ¼-speed replay that ends dwelling on the lit lamps.

## Testing

```bash
npm test              # plumbing (stub-run scoring invariants) + annotation invariants
npm run test:golden   # lamp-detector golden numbers (needs the match video locally)
```

The annotation invariants are the guard rails that keep results trustworthy: unique
touch ids, every touch has a ground-truth row, action text consistent with the recorded
call, lamp sidecars present and consistent with single-light calls.

## Footage & privacy

Coach-staged clips are for training and debugging. Filming minors requires a specific
written release covering third-party API transmission — a standard camp photo release
does not cover it. Keep marked-up clips local; review pages and renders show junior
athletes' names, so share person-to-person rather than publicly.

## Documentation map

- `SPEC.md` — the PRD: hypothesis, pre-registered decision criteria, full layer
  specification (L0 capture → L6 presentation), results log, and the phased roadmap
  from post-hoc batch to strip-side real-time assist.
- `RUNBOOK.md` — the operational path from a raw match mp4 to scored, rendered outputs.
- `CLAUDE.md` — the non-negotiables (blindness firewall, pass separation, abstention
  policy) and the interactive-mode protocol.
