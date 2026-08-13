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
const POST_S = 1.8;         // and ends this long after it — long enough to dwell on the lit lamp
const REPLAY_FROM = 0.8;    // slow replay covers light-REPLAY_FROM .. light+REPLAY_TO
const REPLAY_TO = 0.6;      // replay runs past the light so each touch ENDS on a lit lamp
const REPLAY_FACTOR = 4;

// clips/touches.csv: touch_id,clip,light_time_s  (skip header and # comments)
const touches = new Map();
for (const line of readFileSync("clips/touches.csv", "utf8").trim().split("\n")) {
  const l = line.trim();
  if (!l || l.startsWith("#") || l.startsWith("touch_id")) continue;
  const [id, clip, light] = l.split(",").map((s) => s.trim());
  const t = parseFloat(light);
  if (!Number.isFinite(t)) { console.warn(`skip malformed touches.csv row: ${l}`); continue; }
  touches.set(id, { clip, light: t });
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
  const gtCall = String(gt?.call ?? "?").toUpperCase();
  if (a.call === "no_call") {
    L.push(`AIRS: NO CALL @ ${a.confidence ?? "?"} - abstained (${a.rule_cited ?? "?"})`);
    if (gt) L.push(`REF: ${gtCall}`);
  } else {
    L.push(`AIRS: ${String(a.call ?? "?").toUpperCase()} @ ${a.confidence ?? "?"} - ${a.rule_cited ?? "?"}`);
    if (gt) {
      const hit = a.call === gt.call;
      const q = r.perception?.perception_quality;
      const kind = q === "good" ? "JUDGMENT" : (q === "partial" || q === "poor") ? "PERCEPTION" : "UNATTRIBUTED";
      L.push(hit
        ? `REF: ${gtCall} - AGREE`
        : `REF: ${gtCall} - DISAGREE (${kind} failure)`);
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

// ---------------------------------------------------------------- timeline band
// A 200px band is padded under the footage and the perception timeline is drawn
// into it with per-frame ffmpeg expressions. The two lanes MIRROR each other:
// the left fencer's blue bar grows from the LEFT edge, the right fencer's red
// bar grows from the RIGHT edge, and both meet at the centre LIGHT line at the
// instant the lamps fire (1/4 rate during the replay). Each lane's event dots
// sit on its own axis, so both fencers' dots brighten in true time order as
// their bar reaches them. Marker extraction matches scripts/review.mjs.

const BAND = 200, T0 = -2100, T1 = 180;
const ML = 50, MR = 1230, CX = 640, HALF = CX - ML;   // symmetric: MR - CX === HALF
const OVER = (T1 - 0) / (0 - T0);                      // bar overshoot past centre after the light
const xL = (ms) => Math.round(ML + ((ms - T0) / (0 - T0)) * HALF);
const xR = (ms) => Math.round(MR - ((ms - T0) / (0 - T0)) * HALF);
const fmtMs = (ms) => `${ms >= 0 ? "+" : ""}${ms}ms`;
const sane = (s) => String(s ?? "").replace(/[^\w /+.-]/g, "").slice(0, 30);

function markersFor(fencer) {
  const m = [];
  const arm = fencer?.arm ?? {};
  if (arm.extension_start_ms != null) m.push({ ms: arm.extension_start_ms, label: "arm start" });
  if (arm.extension_full_ms != null) m.push({ ms: arm.extension_full_ms, label: "arm full" });
  for (const i of arm.interruptions ?? []) if (i.ms != null) m.push({ ms: i.ms, label: "arm interrupted" });
  for (const e of fencer?.feet?.events ?? []) if (e.ms != null) m.push({ ms: e.ms, label: String(e.type ?? "?").replace(/_/g, " ") });
  if (fencer?.hit?.landed && fencer.hit.ms != null) m.push({ ms: fencer.hit.ms, label: "hit" });
  if (fencer?.line?.established && fencer.line.established_ms != null) m.push({ ms: fencer.line.established_ms, label: "line" });
  return m.sort((a, b) => a.ms - b.ms);
}

// Lane geometry, as offsets from the bottom of the padded frame.
const LANES = {
  L: { dotY: 144, barY: 142, baseY: 141, above: 168, below: 132, color: "0x5b9dff", axis: xL },
  R: { dotY: 56,  barY: 54,  baseY: 53,  above: 80,  below: 44,  color: "0xff7069", axis: xR },
};
const CONTACT = { dotY: 100, above: 124, below: 88, color: "0xb191ff" };

function laneFilters(markers, lane, evTime) {
  const F = [];
  markers.forEach((m, i) => {
    const px = lane.axis(m.ms);
    const th = evTime(m.ms).toFixed(3);
    const yTxt = i % 2 === 0 ? lane.above : lane.below;
    F.push(`drawbox=x=${px - 4}:y=ih-${lane.dotY}:w=8:h=8:color=${lane.color}@0.3:t=fill`);
    F.push(`drawbox=x=${px - 5}:y=ih-${lane.dotY + 1}:w=10:h=10:color=${lane.color}:t=fill:enable='gte(t,${th})'`);
    F.push(`drawtext=text=${sane(`${m.label} ${fmtMs(m.ms)}`)}:font=${FONT}:fontsize=15:fontcolor=${lane.color}:` +
      `alpha='if(gte(t,${th}),1,0.3)':x='max(2,min(w-text_w-2,${px}-text_w/2))':y=h-${yTxt}`);
  });
  return F;
}

// mode: {FA} for the full-speed main segment (light at t=FA seconds), or
// {replay:true} for the 1/4-speed replay (light at t=REPLAY_FROM*REPLAY_FACTOR).
function bandFilters(p, mode) {
  const evTime = mode.replay
    ? (ms) => (REPLAY_FROM + ms / 1000) * REPLAY_FACTOR
    : (ms) => mode.FA + ms / 1000;
  // Fraction of each half-axis covered: 0 at T0, 1 at the light, slightly past 1 after.
  const prog = mode.replay
    ? `clip(((t/${REPLAY_FACTOR}-${REPLAY_FROM})*1000+${-T0})/${-T0},0,${(1 + OVER).toFixed(4)})`
    : `clip(((t-${mode.FA})*1000+${-T0})/${-T0},0,${(1 + OVER).toFixed(4)})`;
  const F = [`pad=iw:ih+${BAND}:0:0:color=0x17181a`];
  // Lane baselines with 500ms notches on each mirrored axis; ends labelled -2000ms.
  for (const k of ["L", "R"]) {
    const lane = LANES[k];
    F.push(`drawbox=x=${ML}:y=ih-${lane.baseY}:w=${MR - ML}:h=2:color=0x3a3b3e:t=fill`);
    for (let ms = -2000; ms <= 0; ms += 500)
      F.push(`drawbox=x=${lane.axis(ms)}:y=ih-${lane.baseY + 4}:w=1:h=10:color=0x55565a:t=fill`);
  }
  F.push(`drawtext=text=-2000ms:font=${FONT}:fontsize=13:fontcolor=0x77787c:x=${ML}:y=h-${LANES.L.below}`);
  F.push(`drawtext=text=-2000ms:font=${FONT}:fontsize=13:fontcolor=0x77787c:x='${MR}-text_w':y=h-${LANES.R.above}`);
  // Centre LIGHT line — where the two bars meet at the touch.
  F.push(`drawbox=x=${CX - 1}:y=ih-${BAND - 24}:w=2:h=${BAND - 32}:color=0xf59e0b@0.9:t=fill`);
  F.push(`drawtext=text=LIGHT:font=${FONT}:fontsize=14:fontcolor=0xf5b942:x='${CX}-text_w/2':y=h-194`);
  F.push(`drawbox=x=${CX - 9}:y=ih-${BAND - 24}:w=18:h=${BAND - 32}:color=0xf59e0b@0.45:t=fill:` +
    `enable='between(t,${evTime(0).toFixed(3)},${(evTime(0) + (mode.replay ? 1.4 : 0.35)).toFixed(3)})'`);
  F.push(`drawtext=text=LEFT:font=${FONT}:fontsize=15:fontcolor=${LANES.L.color}:x=6:y=h-${LANES.L.above}`);
  F.push(`drawtext=text=RIGHT:font=${FONT}:fontsize=15:fontcolor=${LANES.R.color}:x=6:y=h-${LANES.R.above}`);
  if (p) {
    F.push(...laneFilters(markersFor(p.left), LANES.L, evTime));
    F.push(...laneFilters(markersFor(p.right), LANES.R, evTime));
    // Blade contacts approach the centre as the clash nears (left-style axis).
    const contacts = (p.blade_contact ?? []).filter((c) => c.ms != null);
    contacts.forEach((c, i) => {
      const px = xL(c.ms);
      const th = evTime(c.ms).toFixed(3);
      F.push(`drawbox=x=${px - 4}:y=ih-${CONTACT.dotY}:w=9:h=9:color=${CONTACT.color}@0.3:t=fill`);
      F.push(`drawbox=x=${px - 5}:y=ih-${CONTACT.dotY + 1}:w=11:h=11:color=${CONTACT.color}:t=fill:enable='gte(t,${th})'`);
      F.push(`drawtext=text=${sane(`contact/${c.deflection} ${fmtMs(c.ms)}`)}:font=${FONT}:fontsize=15:fontcolor=${CONTACT.color}:` +
        `alpha='if(gte(t,${th}),1,0.3)':x='max(2,min(w-text_w-2,${px}-text_w/2))':y=h-${i % 2 === 0 ? CONTACT.above : CONTACT.below}`);
    });
    // Converging bars: blue grows from the left, red from the right, meeting at the
    // centre LIGHT line at the touch. drawbox only evaluates x/w once, so the growth
    // is quantised into 10px segments enabled at their computed times (~1 per video
    // frame at 30fps — visually smooth), with a bright tip cap hopping between them.
    const SEGW = 10;
    const NSEG = Math.ceil((HALF * (1 + OVER)) / SEGW);
    const segT = (i) => evTime(T0 + ((i * SEGW) / HALF) * (0 - T0));
    for (let i = 0; i < NSEG; i++) {
      const on = segT(i).toFixed(3);
      const next = (i + 1 < NSEG ? segT(i + 1) : evTime(T1)).toFixed(3);
      F.push(`drawbox=x=${ML + i * SEGW}:y=ih-${LANES.L.barY}:w=${SEGW}:h=4:color=${LANES.L.color}:t=fill:enable='gte(t,${on})'`);
      F.push(`drawbox=x=${MR - (i + 1) * SEGW}:y=ih-${LANES.R.barY}:w=${SEGW}:h=4:color=${LANES.R.color}:t=fill:enable='gte(t,${on})'`);
      const capEn = i + 1 < NSEG ? `between(t,${on},${next})` : `gte(t,${on})`;
      F.push(`drawbox=x=${ML + (i + 1) * SEGW - 2}:y=ih-${LANES.L.dotY + 2}:w=4:h=14:color=0xcfe3ff:t=fill:enable='${capEn}'`);
      F.push(`drawbox=x=${MR - (i + 1) * SEGW - 2}:y=ih-${LANES.R.dotY + 2}:w=4:h=14:color=0xffd9d7:t=fill:enable='${capEn}'`);
    }
  }
  return F.join(",");
}

function ffmpeg(args) {
  execFileSync(FFMPEG, ["-nostdin", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}

const ENC = ["-an", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
const title = (basename(runPath).replace(/\.jsonl$/, "") + (named.length ? `-${named.join("-")}` : "")).replace(/[^\w.-]/g, "_");
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
    "-vf", `${bandFilters(r.perception, { FA: parseFloat(flashA) })},` +
      `drawbox=x=0:y=0:w=iw:h=ih-${BAND}:color=red@0.35:thickness=20:enable='between(t,${flashA},${flashB})',${drawtext(txtMain)}`,
    ...ENC, segMain,
  ]);

  // Slow replay of the final action.
  const txtReplay = join(segDir, `${r.touch_id}-replay.txt`);
  writeFileSync(txtReplay, bannerLines(r, gt, true).join("\n"));
  const segReplay = join(segDir, `${r.touch_id}-replay.mp4`);
  ffmpeg([
    "-ss", Math.max(0, t.light - REPLAY_FROM).toFixed(3), "-to", (t.light + REPLAY_TO).toFixed(3), "-i", t.clip,
    "-vf", `setpts=${REPLAY_FACTOR}*PTS,${bandFilters(r.perception, { replay: true })},${drawtext(txtReplay)}`,
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
