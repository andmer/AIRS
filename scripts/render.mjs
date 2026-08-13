#!/usr/bin/env node
/**
 * Render an annotated match video from a scored run: one segment per touch cut from
 * the source clip, with the AIRS call vs the referee's call burned in, a red flash at
 * the light, and a 1/4-speed replay of the final action — concatenated in run order.
 *
 *   node scripts/render.mjs results/run-....jsonl            # every touch in the run
 *   node scripts/render.mjs results/run-....jsonl t001 t007  # named touches only
 *
 * Needs a drawtext-capable ffmpeg (`brew install ffmpeg-full` — homebrew's plain
 * `ffmpeg` formula is built without text rendering). The keg-only ffmpeg-full binary
 * is auto-detected; override with FFMPEG=/path/to/ffmpeg. Also needs
 * clips/touches.csv (touch_id,clip,light_time_s) and clips/ground_truth.csv.
 * Post-hoc only — nothing here ever reaches a prompt.
 * Output: renders/<run>-annotated.mp4 (per-touch segments kept in renders/segments/).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, resolve } from "node:path";

const runPath = process.argv[2];
if (!runPath) {
  console.error("usage: node scripts/render.mjs results/run-....jsonl [touch ids...]");
  process.exit(1);
}
const named = process.argv.slice(3);

const FFMPEG = process.env.FFMPEG
  ?? (existsSync("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg") ? "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" : "ffmpeg");
const FONT = process.env.BANNER_FONT ?? "Menlo";   // resolved via fontconfig
const FONTSIZE = process.env.BANNER_FONTSIZE ?? "h/26";
const PRE_S = 2.5;          // segment starts this long before the light
const POST_S = 1.0;         // and ends this long after it
const REPLAY_FROM = 0.8;    // slow replay covers light-0.8s .. light+0.1s
const REPLAY_FACTOR = 4;

// clips/touches.csv: touch_id,clip,light_time_s  (skip header and # comments)
const touches = new Map();
for (const line of readFileSync("clips/touches.csv", "utf8").trim().split("\n")) {
  const l = line.trim();
  if (!l || l.startsWith("#") || l.startsWith("touch_id")) continue;
  const [id, clip, light] = l.split(",").map((s) => s.trim());
  touches.set(id, { clip, light: parseFloat(light) });
}

const truth = new Map();
for (const line of readFileSync("clips/ground_truth.csv", "utf8").trim().split("\n").slice(1)) {
  if (!line.trim()) continue;
  const [id, call, tier, action] = line.split(",").map((s) => s.trim());
  truth.set(id, { call, tier, action });
}

const lines = readFileSync(runPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const meta = lines.find((l) => l.meta)?.meta;
const rows = lines.filter((l) => !l.meta && (!named.length || named.includes(l.touch_id)));

function bannerLines(r, gt, replay) {
  const L = [];
  const head = [r.touch_id, gt ? `tier ${gt.tier}` : null, gt?.action].filter(Boolean).join("  -  ");
  L.push(replay ? `${head}  -  REPLAY 1/${REPLAY_FACTOR}x` : head);
  if (r.error) {
    L.push(`AIRS: RUN ERROR - ${r.error.slice(0, 70)}`);
    return L;
  }
  const a = r.adjudication;
  if (!a) {
    L.push("AIRS: perception only (pass 1) - no call made");
    return L;
  }
  if (a.call === "no_call") {
    L.push(`AIRS: NO CALL @ ${a.confidence} - abstained (${a.rule_cited})`);
    if (gt) L.push(`REF: ${gt.call.toUpperCase()}`);
  } else {
    L.push(`AIRS: ${a.call.toUpperCase()} @ ${a.confidence} - ${a.rule_cited}`);
    if (gt) {
      const hit = a.call === gt.call;
      const kind = r.perception?.perception_quality === "good" ? "JUDGMENT" : "PERCEPTION";
      L.push(hit
        ? `REF: ${gt.call.toUpperCase()} - AGREE`
        : `REF: ${gt.call.toUpperCase()} - DISAGREE (${kind} failure)`);
      const alt = a.alternate_reading;
      if (!hit && alt && alt.call !== "none") L.push(`alt reading: ${alt.call} (${alt.plausibility})`);
    }
  }
  return L.map((s) => s.replace(/[\r\n]/g, " "));
}

// textfile + expansion=none sidesteps drawtext's escaping rules entirely.
const drawtext = (txt) =>
  `drawtext=textfile=${txt}:expansion=none:font=${FONT}:fontcolor=white:` +
  `fontsize=${FONTSIZE}:line_spacing=8:box=1:boxcolor=black@0.55:boxborderw=14:x=18:y=18`;

function ffmpeg(args) {
  execFileSync(FFMPEG, ["-nostdin", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}

const ENC = ["-an", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
const title = basename(runPath).replace(/\.jsonl$/, "") + (named.length ? `-${named.join("-")}` : "");
const segDir = join("renders", "segments");
mkdirSync(segDir, { recursive: true });

const segments = [];
for (const r of rows) {
  const t = touches.get(r.touch_id);
  if (!t) {
    console.warn(`skip ${r.touch_id}: no entry in clips/touches.csv`);
    continue;
  }
  if (!existsSync(t.clip)) {
    console.warn(`skip ${r.touch_id}: clip not found: ${t.clip}`);
    continue;
  }
  const gt = truth.get(r.touch_id);
  process.stdout.write(`${r.touch_id} ... `);

  // Main segment: approach + light, banner + red border flash at the light.
  const txtMain = join(segDir, `${r.touch_id}-main.txt`);
  writeFileSync(txtMain, bannerLines(r, gt, false).join("\n"));
  const start = Math.max(0, t.light - PRE_S);
  const flashA = (t.light - start).toFixed(3);
  const flashB = (t.light - start + 0.25).toFixed(3);
  const segMain = join(segDir, `${r.touch_id}-main.mp4`);
  ffmpeg([
    "-ss", start.toFixed(3), "-to", (t.light + POST_S).toFixed(3), "-i", t.clip,
    "-vf", `drawbox=x=0:y=0:w=iw:h=ih:color=red@0.35:thickness=20:enable='between(t,${flashA},${flashB})',${drawtext(txtMain)}`,
    ...ENC, segMain,
  ]);

  // Slow replay of the final action.
  const txtReplay = join(segDir, `${r.touch_id}-replay.txt`);
  writeFileSync(txtReplay, bannerLines(r, gt, true).join("\n"));
  const segReplay = join(segDir, `${r.touch_id}-replay.mp4`);
  ffmpeg([
    "-ss", Math.max(0, t.light - REPLAY_FROM).toFixed(3), "-to", (t.light + 0.1).toFixed(3), "-i", t.clip,
    "-vf", `setpts=${REPLAY_FACTOR}*PTS,${drawtext(txtReplay)}`,
    ...ENC, segReplay,
  ]);

  segments.push(segMain, segReplay);
  console.log("ok");
}

if (!segments.length) {
  console.error("nothing to render — fill clips/touches.csv first");
  process.exit(1);
}

const listPath = join(segDir, `concat-${title}.txt`);
writeFileSync(listPath, segments.map((s) => `file '${resolve(s)}'`).join("\n") + "\n");
const outPath = join("renders", `${title}-annotated.mp4`);
ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, ...ENC, outPath]);
console.log(`\nWrote ${outPath}${meta?.stub ? "  [from a STUB run — banners are canned]" : ""}`);
console.log(`Open it:  open ${outPath}`);
