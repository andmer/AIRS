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
  .filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("touch_id"))
  .map((l) => l.split(",")[0].trim())
  .filter((id) => id.startsWith(prefix));

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
    out.push({ touch_id: id, frames: 20, perception, adjudication });
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
