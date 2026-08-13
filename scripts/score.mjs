#!/usr/bin/env node
/**
 * Score a probe run against ground truth.
 *
 *   node scripts/score.mjs results/run-....jsonl
 *
 * The accuracy number is the least interesting output here. The disagreement report at
 * the bottom is what tells you whether to keep going: it separates "misread the blade"
 * from "misapplied the rule", and those have completely different fixes.
 *
 * Scoring semantics: no_call is a SUCCESS state, not a miss. Abstentions are excluded
 * from the accuracy numerator and denominator and reported on their own line — counting
 * them as misses would recreate exactly the pressure to tune abstention away.
 */

import { readFileSync } from "node:fs";

const runPath = process.argv[2];
if (!runPath) {
  console.error("usage: node scripts/score.mjs results/run-....jsonl");
  process.exit(1);
}

const truth = new Map();
for (const line of readFileSync("clips/ground_truth.csv", "utf8").trim().split("\n").slice(1)) {
  if (!line.trim()) continue;
  const [id, call, tier, action, notes] = line.split(",").map((s) => s.trim());
  truth.set(id, { call, tier, action, notes });
}

const lines = readFileSync(runPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const meta = lines.find((l) => l.meta)?.meta;
const rows = lines.filter((l) => !l.meta);

const stats = { decided: 0, correct: 0, errors: 0, byTier: {} };
const abstentions = { n: 0, byQuality: {}, onGoodPerception: [] };
const buckets = [
  { lo: 0.9, hi: 1.01, n: 0, correct: 0, label: "0.9+" },
  { lo: 0.7, hi: 0.9, n: 0, correct: 0, label: "0.7-0.9" },
  { lo: 0.4, hi: 0.7, n: 0, correct: 0, label: "0.4-0.7" },
  { lo: 0.0, hi: 0.4, n: 0, correct: 0, label: "<0.4" },
];
const disagreements = [];
const altNoneContested = [];
let altRescues = 0;

for (const r of rows) {
  const gt = truth.get(r.touch_id);
  if (!gt) continue;
  if (r.error) { stats.errors++; continue; }
  const a = r.adjudication;
  if (!a) continue; // pass1-only rows

  const tier = gt.tier || "?";
  stats.byTier[tier] ??= { n: 0, correct: 0, abstained: 0 };
  const quality = r.perception?.perception_quality ?? "?";

  if (a.call === "no_call") {
    abstentions.n++;
    abstentions.byQuality[quality] = (abstentions.byQuality[quality] ?? 0) + 1;
    stats.byTier[tier].abstained++;
    if (quality === "good") {
      abstentions.onGoodPerception.push({ id: r.touch_id, tier, uncertainty: a.decisive_uncertainty ?? "" });
    }
    continue;
  }

  stats.decided++;
  stats.byTier[tier].n++;
  const hit = a.call === gt.call;
  if (hit) { stats.correct++; stats.byTier[tier].correct++; }

  const b = buckets.find((x) => a.confidence >= x.lo && a.confidence < x.hi);
  if (b) { b.n++; if (hit) b.correct++; }

  // On a contested touch (tier 2/3), "no alternate reading exists" is itself a failure.
  if ((tier === "2" || tier === "3") && a.alternate_reading?.call === "none") {
    altNoneContested.push({ id: r.touch_id, tier, action: gt.action, conf: a.confidence });
  }

  if (!hit) {
    if (a.alternate_reading?.call === gt.call) altRescues++;
    disagreements.push({
      id: r.touch_id,
      tier,
      action: gt.action,
      expected: gt.call,
      got: a.call,
      conf: a.confidence,
      perception: quality,
      perceptionReasons: (r.perception?.quality_reasons ?? []).join("; "),
      rule: a.rule_cited,
      ruleDetail: a.rule_detail ?? "",
      hardCases: (a.hard_case_flags ?? []).join(", "),
      altHit: a.alternate_reading?.call === gt.call,
      uncertainty: a.decisive_uncertainty ?? "",
    });
  }
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(0) + "%" : "—");

console.log(`\n=== ${runPath} ===`);
if (meta) {
  console.log(`models ${meta.perception_model} → ${meta.adjudication_model}   prompts ${meta.prompts_sha256}${meta.stub ? "   [STUB RUN — not real results]" : ""}`);
}
console.log(`decided ${stats.decided}   correct ${stats.correct} (${pct(stats.correct, stats.decided)})   abstentions ${abstentions.n}   errors ${stats.errors}`);

if (abstentions.n) {
  const q = abstentions.byQuality;
  console.log(`\nAbstentions (no_call — a success state, excluded from accuracy)`);
  console.log(`  on partial/poor perception: ${(q.partial ?? 0) + (q.poor ?? 0)}  (working as designed)`);
  console.log(`  on good perception:         ${q.good ?? 0}  (over-abstention — read these)`);
  for (const a of abstentions.onGoodPerception) {
    console.log(`    [${a.id}] tier ${a.tier} — decisive uncertainty: ${a.uncertainty || "(none given)"}`);
  }
}

console.log("\nBy tier (decided calls; abstentions shown separately)");
for (const [tier, s] of Object.entries(stats.byTier).sort()) {
  console.log(`  tier ${tier}: ${s.correct}/${s.n}  ${pct(s.correct, s.n)}   abstained ${s.abstained}`);
}

console.log("\nCalibration  (accuracy should track the band; if it doesn't, confidence is noise)");
for (const b of buckets) {
  const bar = b.n ? "#".repeat(Math.round((b.correct / b.n) * 20)) : "";
  console.log(`  ${b.label.padEnd(8)} n=${String(b.n).padStart(3)}  ${pct(b.correct, b.n).padStart(4)}  ${bar}`);
}
const topHeavy = buckets[0].n;
if (stats.decided >= 5 && topHeavy / stats.decided > 0.9) {
  console.log(`  !! CALIBRATION FAILURE: ${pct(topHeavy, stats.decided)} of decided calls are above 0.9 — the confidence signal is noise.`);
}

console.log(`\nAlternate-reading rescues: ${altRescues}/${disagreements.length}`);
console.log("  (wrong primary call but the right answer was named as the alternate —");
console.log("   these are near-misses, and a teaching tool can surface both.)");

if (altNoneContested.length) {
  console.log(`\nALTERNATE-READING FAILURES: alternate "none" on a contested touch (tier 2/3)`);
  for (const f of altNoneContested) {
    console.log(`  [${f.id}] tier ${f.tier} — ${f.action} @ ${f.conf} — a contested touch always has a defensible counter-reading`);
  }
}

console.log("\n--- DISAGREEMENTS: read these, not the percentage ---");
for (const d of disagreements) {
  const kind = d.perception === "poor" || d.perception === "partial" ? "PERCEPTION" : "JUDGMENT";
  console.log(`\n[${d.id}] tier ${d.tier} — ${d.action}`);
  console.log(`  expected ${d.expected}, got ${d.got} @ ${d.conf}   likely failure: ${kind}`);
  if (d.altHit) console.log(`  (alternate reading had it right)`);
  if (kind === "PERCEPTION") console.log(`  perception said: ${d.perceptionReasons || "(no reasons given)"}`);
  console.log(`  rule cited: ${d.rule}${d.ruleDetail ? ` — ${d.ruleDetail}` : ""}`);
  if (d.hardCases) console.log(`  hard-case flags: ${d.hardCases}`);
  if (d.uncertainty) console.log(`  decisive uncertainty: ${d.uncertainty}`);
}

console.log(`
--- READING THE RESULT ---
Chance on a two-way call is 50%. The bar for continuing is not "beats chance overall",
it is "beats chance on tier 1 by a wide margin AND the failures cluster in PERCEPTION
rather than JUDGMENT". Perception failures are an engineering problem you can fix with
better capture, higher frame rates, and the CV layer. Judgment failures on clean
perception mean the reasoning layer does not hold, and no amount of downstream
engineering rescues that.
`);
