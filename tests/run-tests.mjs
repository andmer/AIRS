#!/usr/bin/env node
/**
 * AIRS regression tests. No API calls, no Claude Code usage.
 *
 *   npm test                      # fast: hermetic stub pipeline + scorer golden numbers
 *                                 #       + assembler prefix filter + annotation invariants
 *   npm run test:golden           # also re-runs lamp detection on videos/JMS.mp4 and
 *                                 #       diffs against tests/golden/jms-lights.txt (~1 min)
 *
 * What each layer proves:
 * - Stub pipeline: probe's defensive parsing / error rows and score.mjs semantics
 *   (abstentions excluded from accuracy, PERCEPTION/JUDGMENT tagging, alternate-none
 *   surfacing, rescue counting) against known deterministic stub numbers.
 * - Assembler: prefix filtering keeps multi-match repos from mixing runs.
 * - Annotation invariants: single-light touches awarded to the lit side, simultaneous
 *   touches have both lamps, manifest/ground-truth/context files agree 1:1.
 * - Golden lamp detection: the chroma detector still reproduces the JMS events exactly.
 *
 * Model judgment (perception/adjudication quality) is deliberately NOT unit-tested —
 * that is what the probe itself measures against the referee.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const GOLDEN = process.argv.includes("--golden");
let failures = 0;

function check(name, cond, detail = "") {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

// ---------------------------------------------------------------- 1. stub pipeline
console.log("stub pipeline (hermetic sandbox):");
const sandbox = mkdtempSync(join(tmpdir(), "airs-test-"));
cpSync(join(ROOT, "scripts"), join(sandbox, "scripts"), { recursive: true });
cpSync(join(ROOT, "prompts"), join(sandbox, "prompts"), { recursive: true });
mkdirSync(join(sandbox, "clips"), { recursive: true });
cpSync(join(ROOT, "tests/fixtures/ground_truth.csv"), join(sandbox, "clips/ground_truth.csv"));

const probeOut = run("node", ["scripts/probe.mjs"], { cwd: sandbox, env: { ...process.env, PROBE_STUB: "1" } });
check("stub probe runs and logs the intentional t006 failure", probeOut.includes("FAILED") && probeOut.includes("t006"));

const resultsFile = readdirSync(join(sandbox, "results")).find((f) => f.endsWith(".jsonl"));
check("results file written", !!resultsFile);
const rows = readFileSync(join(sandbox, "results", resultsFile), "utf8").trim().split("\n").map(JSON.parse);
check("meta row stamps stub:true", rows[0]?.meta?.stub === true);
check("t006 recorded as error row, run continued to t015", rows.some((r) => r.touch_id === "t006" && r.error) && rows.some((r) => r.touch_id === "t015"));

const scoreOut = run("node", ["scripts/score.mjs", join("results", resultsFile)], { cwd: sandbox });
check("scorer golden line: decided/correct/abstentions/errors", scoreOut.includes("decided 11   correct 4 (36%)   abstentions 3   errors 1"), "stub semantics changed");
check("abstentions excluded from accuracy and split by quality", scoreOut.includes("on partial/poor perception: 2") && scoreOut.includes("on good perception:         1"));
check("alternate-reading rescues counted", scoreOut.includes("Alternate-reading rescues: 3/7"));
check("alternate 'none' on contested touches surfaced", scoreOut.includes("ALTERNATE-READING FAILURES") && scoreOut.includes("[t010]") && scoreOut.includes("[t014]"));
check("disagreements tagged with both failure kinds", scoreOut.includes("likely failure: PERCEPTION") && scoreOut.includes("likely failure: JUDGMENT"));
check("no spurious calibration warning at 36% top-band share", !scoreOut.includes("CALIBRATION FAILURE"));

// ---------------------------------------------------------------- 2. assembler prefix filter
console.log("assembler prefix filter:");
writeFileSync(join(sandbox, "clips/touches.csv"), "touch_id,clip,light_time_s\naa01,x.mp4,1.0\nbb01,x.mp4,2.0\n");
mkdirSync(join(sandbox, "results/interactive"), { recursive: true });
for (const id of ["aa01", "bb01"]) {
  writeFileSync(join(sandbox, `results/interactive/p1-${id}.json`), JSON.stringify({ perception_quality: "good" }));
  writeFileSync(join(sandbox, `results/interactive/p2-${id}.json`), JSON.stringify({ call: "left", confidence: 0.8 }));
}
run("node", ["scripts/assemble-interactive.mjs", "aa"], { cwd: sandbox });
const asm = readdirSync(join(sandbox, "results")).filter((f) => f.includes("interactive")).sort().pop();
const asmRows = readFileSync(join(sandbox, "results", asm), "utf8").trim().split("\n").map(JSON.parse).filter((r) => !r.meta);
check("prefix 'aa' assembles exactly the aa touches", asmRows.length === 1 && asmRows[0].touch_id === "aa01");

// ---------------------------------------------------------------- 3. annotation invariants (real repo data)
console.log("annotation invariants (clips/ + frames/ in this repo):");
const touchRows = readFileSync(join(ROOT, "clips/touches.csv"), "utf8").trim().split("\n")
  .filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("touch_id"))
  .map((l) => l.split(",").map((s) => s.trim()));
const gt = new Map(readFileSync(join(ROOT, "clips/ground_truth.csv"), "utf8").trim().split("\n").slice(1)
  .filter((l) => l.trim()).map((l) => { const [id, call] = l.split(","); return [id.trim(), call.trim()]; }));

const ids = touchRows.map((r) => r[0]);
check("touch ids unique", new Set(ids).size === ids.length);
check("every touch has a ground-truth row", ids.every((id) => gt.has(id)), ids.filter((id) => !gt.has(id)).join(","));
check("every touch has a light-state sidecar", ids.every((id) => existsSync(join(ROOT, `frames/${id}/context.json`))));

let lightViolations = [];
for (const id of ids) {
  const lights = JSON.parse(readFileSync(join(ROOT, `frames/${id}/context.json`), "utf8")).lights ?? {};
  const call = gt.get(id);
  if (lights.left === true && lights.right === false && call !== "left") lightViolations.push(`${id}: left-only lamp but call=${call}`);
  if (lights.right === true && lights.left === false && call !== "right") lightViolations.push(`${id}: right-only lamp but call=${call}`);
  if (call === "simultaneous" && !(lights.left === true && lights.right === true)) lightViolations.push(`${id}: simultaneous without both lamps`);
}
check("single-light touches awarded to the lit side; sims have both lamps", lightViolations.length === 0, lightViolations.join("; "));

// ---------------------------------------------------------------- 4. golden lamp detection (optional, ~1 min)
if (GOLDEN) {
  console.log("golden lamp detection (videos/JMS.mp4):");
  if (!existsSync(join(ROOT, "videos/JMS.mp4"))) {
    check("videos/JMS.mp4 present", false, "golden test needs the source video locally");
  } else {
    const detected = run("node", ["scripts/detect-lights.mjs", "videos/JMS.mp4"], { cwd: ROOT }).trim();
    const golden = readFileSync(join(ROOT, "tests/golden/jms-lights.txt"), "utf8").trim();
    check("detector reproduces the committed JMS events exactly", detected === golden,
      "run `node scripts/detect-lights.mjs videos/JMS.mp4 > tests/golden/jms-lights.txt` only if the change is intentional");
  }
} else {
  console.log("golden lamp detection: skipped (npm run test:golden)");
}

rmSync(sandbox, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall tests passed");
process.exit(failures ? 1 : 0);
