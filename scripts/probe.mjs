#!/usr/bin/env node
/**
 * Two-pass sabre touch probe.
 *
 *   node scripts/probe.mjs                 # every touch in clips/ground_truth.csv
 *   node scripts/probe.mjs t017 t023       # named touches only
 *   node scripts/probe.mjs --pass1-only    # perception only, skip adjudication
 *
 *   PROBE_STUB=1 node scripts/probe.mjs    # dry run: canned responses, no API, no frames
 *
 * Ground truth is never sent to the model. It is read solely to enumerate touch ids
 * and is merged in later by score.mjs. If you find yourself wanting to pass a hint
 * "just to see", make a copy of this file and label it as contaminated.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const PERCEPTION_MODEL = process.env.PERCEPTION_MODEL ?? "claude-sonnet-5";
const ADJUDICATION_MODEL = process.env.ADJUDICATION_MODEL ?? "claude-opus-5";
const STUB = process.env.PROBE_STUB === "1";

const args = process.argv.slice(2);
const pass1Only = args.includes("--pass1-only");
const named = args.filter((a) => !a.startsWith("--"));

const RULES = readFileSync("prompts/00_rules_preamble.md", "utf8");
const PERCEPTION = readFileSync("prompts/01_perception.md", "utf8");
const ADJUDICATION = readFileSync("prompts/02_adjudication.md", "utf8");
// Stamped into results so runs remain comparable after prompt edits.
const PROMPTS_HASH = createHash("sha256").update(RULES + PERCEPTION + ADJUDICATION).digest("hex").slice(0, 12);

// SDK loaded only for real runs, so the stubbed dry run works before npm install.
const client = STUB ? null : new (await import("@anthropic-ai/sdk")).default();

/** Models occasionally wrap JSON in fences despite instructions. Strip, then parse. */
function parseJson(text, label) {
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch { /* fall through */ }
    }
    throw new Error(`${label}: unparseable JSON. Raw head: ${cleaned.slice(0, 240)}`);
  }
}

/** Thinking is on by default on these models; keep only the text blocks. */
function textOf(msg, label) {
  if (msg.stop_reason === "refusal") throw new Error(`${label}: model refused (stop_reason=refusal)`);
  if (msg.stop_reason === "max_tokens") throw new Error(`${label}: truncated (stop_reason=max_tokens) — raise max_tokens`);
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/** Frames are named "-0320ms.jpg" — the filename carries the label into the prompt. */
function loadFrames(touchId) {
  const dir = join("frames", touchId);
  if (!existsSync(dir)) throw new Error(`no frames dir for ${touchId} (run extract-frames.sh)`);
  const files = readdirSync(dir)
    .filter((f) => /ms\.jpg$/.test(f))
    .map((f) => ({ file: f, offset: parseInt(f.replace(/ms\.jpg$/, ""), 10) }))
    .sort((a, b) => a.offset - b.offset);
  if (!files.length) throw new Error(`frames dir for ${touchId} contains no *ms.jpg files`);
  return files.map(({ file, offset }) => ({
    offset,
    b64: readFileSync(join(dir, file)).toString("base64"),
  }));
}

/** Optional per-touch context: human-recorded light state, and later the CV timeline. */
function loadContext(touchId) {
  const p = join("frames", touchId, "context.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

// ---------------------------------------------------------------------------
// Stub mode: deterministic canned responses keyed on the touch's position in
// the run. No API calls, no frames on disk. Rotating calls/qualities guarantee
// the scored dry run has hits, misses, abstentions, both disagreement kinds,
// alternate-reading rescues, and one intentional parse failure (ids ending in
// "6") to exercise the error path. Never reads ground-truth calls.
// ---------------------------------------------------------------------------
function stubFencer(start) {
  return {
    arm: { extension_start_ms: start, extension_full_ms: start + 300, state_at_light: "extended", interruptions: [] },
    feet: {
      observable: "fully",
      events: [
        { type: "lunge_start", ms: start + 250, evidence: "seen", description: "" },
        { type: "lunge_land", ms: -110, evidence: "seen", description: "" },
      ],
    },
    hit: { landed: true, ms: -35, evidence: "inferred", location: "flank" },
    line: { established: false, established_ms: null, maintained_to_light: false },
    notes: "",
  };
}

function stubPerception(touchId, idx) {
  if (touchId.endsWith("6")) return "the blade { moved and then";
  const quality = ["good", "partial", "poor"][idx % 3];
  return JSON.stringify({
    frames_usable: 20 - (idx % 3) * 6,
    left: stubFencer(-800),
    right: stubFencer(-600),
    blade_contact: [],
    events: [{ ms: -600, actor: "left", action: "advance begins", confidence: 0.9, basis: "frame -600" }],
    narration: `Stub perception for ${touchId}.`,
    perception_quality: quality,
    quality_reasons: quality === "good" ? [] : ["stub: simulated degraded capture"],
  });
}

function stubAdjudication(touchId, idx) {
  const call = ["left", "right", "simultaneous", "no_call"][idx % 4];
  const confidence = call === "no_call" ? 0.2 : [0.95, 0.8, 0.55][idx % 4];
  const opposite = { left: "right", right: "left", simultaneous: "left", no_call: "left" };
  const alt = idx % 2 === 0 ? opposite[call] : "none";
  return JSON.stringify({
    phrase: [{ order: 1, actor: "left", action: "attack", ms: -800, outcome: call === "left" ? "lands" : "parried" }],
    evidence: ["left.arm.extension_start_ms=-800 precedes right lunge_start=-350"],
    hard_case_flags: idx % 5 === 0 ? ["hand_vs_foot_timing"] : [],
    rule_cited:
      call === "no_call" ? "insufficient_perception"
      : call === "simultaneous" ? "simultaneous_action"
      : "correct_attack",
    rule_detail: "Stub ruling.",
    call,
    confidence,
    alternate_reading: {
      call: alt,
      why: alt === "none" ? "" : "Stub counter-reading.",
      plausibility: alt === "none" ? 0 : 0.4,
    },
    decisive_uncertainty: "Stub: whether the contact deflected the blade.",
  });
}

// ---------------------------------------------------------------------------

async function perceptionPass(touchId, idx) {
  if (STUB) {
    return { json: parseJson(stubPerception(touchId, idx), `${touchId} pass1 [stub]`), usage: null, frameCount: 20 };
  }
  const frames = loadFrames(touchId);
  const ctx = loadContext(touchId);

  const content = [];
  for (const f of frames) {
    content.push({ type: "text", text: `Frame at ${f.offset >= 0 ? "+" : ""}${f.offset} ms relative to light:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.b64 } });
  }
  if (ctx.timeline) {
    content.push({ type: "text", text: `Derived timeline (primary evidence):\n${ctx.timeline}` });
  }
  content.push({ type: "text", text: "Describe the phrase. JSON only." });

  const msg = await client.messages.create({
    model: PERCEPTION_MODEL,
    max_tokens: 8000, // adaptive thinking is on by default and shares this cap with the JSON
    system: [
      // Static across every touch — cache it or the bill is silly.
      { type: "text", text: RULES, cache_control: { type: "ephemeral" } },
      { type: "text", text: PERCEPTION, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content }],
  });

  const label = `${touchId} pass1`;
  return { json: parseJson(textOf(msg, label), label), usage: msg.usage, frameCount: frames.length };
}

async function adjudicationPass(touchId, idx, perception) {
  if (STUB) {
    return { json: parseJson(stubAdjudication(touchId, idx), `${touchId} pass2 [stub]`), usage: null };
  }
  const ctx = loadContext(touchId);
  const lights = ctx.lights
    ? `Light state (human-recorded): ${JSON.stringify(ctx.lights)}`
    : "Light state: not recorded.";

  const msg = await client.messages.create({
    model: ADJUDICATION_MODEL,
    max_tokens: 8000,
    system: [
      { type: "text", text: RULES, cache_control: { type: "ephemeral" } },
      { type: "text", text: ADJUDICATION, cache_control: { type: "ephemeral" } },
    ],
    messages: [{
      role: "user",
      content: `Perception record:\n${JSON.stringify(perception, null, 2)}\n\n${lights}\n\nAdjudicate. JSON only.`,
    }],
  });

  const label = `${touchId} pass2`;
  return { json: parseJson(textOf(msg, label), label), usage: msg.usage };
}

function touchIds() {
  if (named.length) return named;
  return readFileSync("clips/ground_truth.csv", "utf8").trim().split("\n").slice(1)
    .map((r) => r.trim())
    .filter((r) => r && !r.startsWith("#"))
    .map((r) => r.split(",")[0].trim())
    .filter(Boolean);
}

const ids = touchIds();
mkdirSync("results", { recursive: true });
console.log(`Probing ${ids.length} touches — perception:${PERCEPTION_MODEL} adjudication:${ADJUDICATION_MODEL}${STUB ? " [STUB — no API calls]" : ""}\n`);

const out = [{
  meta: {
    run_at: new Date().toISOString(),
    perception_model: PERCEPTION_MODEL,
    adjudication_model: ADJUDICATION_MODEL,
    prompts_sha256: PROMPTS_HASH,
    stub: STUB,
    pass1_only: pass1Only,
  },
}];

for (const [idx, id] of ids.entries()) {
  process.stdout.write(`${id} ... `);
  try {
    const p1 = await perceptionPass(id, idx);
    if (pass1Only) {
      out.push({ touch_id: id, perception: p1.json, frames: p1.frameCount });
      console.log(`perception:${p1.json.perception_quality} (${(p1.json.quality_reasons ?? []).join("; ") || "no issues"})`);
      continue;
    }
    const p2 = await adjudicationPass(id, idx, p1.json);
    out.push({
      touch_id: id,
      frames: p1.frameCount,
      perception: p1.json,
      adjudication: p2.json,
      usage: { pass1: p1.usage, pass2: p2.usage },
    });
    console.log(`${p2.json.call} @ ${p2.json.confidence} (perception:${p1.json.perception_quality})`);
  } catch (err) {
    out.push({ touch_id: id, error: String(err.message ?? err) });
    console.log(`FAILED — ${err.message ?? err}`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `results/run-${stamp}.jsonl`;
writeFileSync(path, out.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.log(`\nWrote ${path}\nScore it:  node scripts/score.mjs ${path}`);
