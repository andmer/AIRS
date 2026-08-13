#!/usr/bin/env node
/**
 * Assemble an interactive-mode run (per-touch p1-/p2- JSON files written by Claude Code
 * subagents, see CLAUDE.md → Interactive mode) into the standard results JSONL that
 * score.mjs / review.mjs / render.mjs consume.
 *
 *   node scripts/assemble-interactive.mjs [id-prefix]
 *
 * Reads clips/touches.csv for the touch order, results/interactive/p{1,2}-<id>.json
 * for the pass outputs. Optional prefix limits assembly to one match's touches
 * (e.g. "y12ms"). Ground truth is never read here.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const RULES = readFileSync("prompts/00_rules_preamble.md", "utf8");
const PERCEPTION = readFileSync("prompts/01_perception.md", "utf8");
const ADJUDICATION = readFileSync("prompts/02_adjudication.md", "utf8");
const PROMPTS_HASH = createHash("sha256").update(RULES + PERCEPTION + ADJUDICATION).digest("hex").slice(0, 12);

const prefix = process.argv[2] ?? "";
const ids = readFileSync("clips/touches.csv", "utf8").trim().split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#") && !l.startsWith("touch_id"))
  .map((l) => l.split(",")[0].trim())
  .filter((id) => id && id.startsWith(prefix));

if (!ids.length) {
  console.error(`no touch ids in clips/touches.csv${prefix ? ` matching prefix "${prefix}"` : ""} — nothing to assemble`);
  process.exit(1);
}

// Contract checks from the prompt schemas; violations ride on the row for score.mjs to surface.
const CALLS = ["left", "right", "simultaneous", "no_call"];
const QUALITIES = ["good", "partial", "poor"];
function contractCheck(perception, adjudication) {
  const v = [];
  if (!QUALITIES.includes(perception?.perception_quality)) v.push(`perception_quality invalid: ${perception?.perception_quality}`);
  if (!CALLS.includes(adjudication?.call)) v.push(`call invalid: ${adjudication?.call}`);
  const c = adjudication?.confidence;
  if (typeof c !== "number" || c < 0 || c > 1) v.push(`confidence invalid: ${c}`);
  if (adjudication?.call === "no_call") {
    if (!(typeof c === "number" && c <= 0.3)) v.push(`no_call at confidence ${c} (must be <= 0.3)`);
    if (adjudication?.rule_cited !== "insufficient_perception") v.push(`no_call with rule_cited ${adjudication?.rule_cited}`);
  }
  if (adjudication?.alternate_reading?.call === adjudication?.call) v.push("alternate_reading.call equals call");
  return v;
}

const out = [{
  meta: {
    run_at: new Date().toISOString(),
    mode: "interactive",
    perception_model: "claude-sonnet (claude-code subagent)",
    adjudication_model: "claude-opus (claude-code subagent)",
    prompts_sha256: PROMPTS_HASH,
    stub: false,
  },
}];

let ok = 0, partial = 0, failed = 0;
for (const id of ids) {
  const p1 = `results/interactive/p1-${id}.json`;
  const p2 = `results/interactive/p2-${id}.json`;
  try {
    if (!existsSync(p1)) throw new Error(`${id}: perception output missing (${p1})`);
    const perception = JSON.parse(readFileSync(p1, "utf8"));
    if (!existsSync(p2)) {
      out.push({ touch_id: id, frames: 20, perception, error: `${id}: adjudication output missing (${p2})` });
      partial++;
      continue;
    }
    const adjudication = JSON.parse(readFileSync(p2, "utf8"));
    const row = { touch_id: id, frames: 20, perception, adjudication };
    const violations = contractCheck(perception, adjudication);
    if (violations.length) row.contract_violations = violations;
    out.push(row);
    ok++;
  } catch (err) {
    out.push({ touch_id: id, error: String(err.message ?? err) });
    failed++;
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const path = `results/run-${stamp}-interactive.jsonl`;
writeFileSync(path, out.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.log(`Wrote ${path}  (${ok} complete, ${partial} perception-only, ${failed} failed)`);
console.log(`Score it:  node scripts/score.mjs ${path}`);
