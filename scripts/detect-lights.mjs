#!/usr/bin/env node
/**
 * Detect scoring-lamp events in a match video by chroma shift on the overhead lamp
 * panels (calibrated on USA Fencing 720p stream framing; override via env).
 *
 *   node scripts/detect-lights.mjs videos/MATCH.mp4
 *
 * Prints one event per line: "<onset_s> <end_s> <L|R|L+R>". Pure ffmpeg + node —
 * no model calls. Used standalone or by airs-match.mjs.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const video = process.argv[2];
if (!video) {
  console.error("usage: node scripts/detect-lights.mjs <video.mp4>");
  process.exit(1);
}

// Lamp panel crops (w:h:x:y) and V-plane thresholds; baseline V ≈ 130.
const LAMP_LEFT = process.env.LAMP_LEFT ?? "140:30:380:86";   // red when lit: V > 136
const LAMP_RIGHT = process.env.LAMP_RIGHT ?? "140:30:752:86"; // green when lit: V < 124
const L_THRESH = parseFloat(process.env.LAMP_L_THRESH ?? "136");
const R_THRESH = parseFloat(process.env.LAMP_R_THRESH ?? "124");

const work = mkdtempSync(join(tmpdir(), "airs-lamps-"));
execFileSync("ffmpeg", [
  "-nostdin", "-loglevel", "error", "-i", video,
  "-filter_complex",
  `[0:v]split=2[a][b];[a]crop=${LAMP_LEFT},signalstats,metadata=print:key=lavfi.signalstats.VAVG:file=${work}/L.log[oa];` +
  `[b]crop=${LAMP_RIGHT},signalstats,metadata=print:key=lavfi.signalstats.VAVG:file=${work}/R.log[ob]`,
  "-map", "[oa]", "-f", "null", "-", "-map", "[ob]", "-f", "null", "-",
]);

function parse(f) {
  const out = [];
  let t = null;
  for (const line of readFileSync(join(work, f), "utf8").split("\n")) {
    const mt = line.match(/pts_time:([\d.]+)/);
    if (mt) { t = parseFloat(mt[1]); continue; }
    const mv = line.match(/VAVG=([\d.]+)/);
    if (mv && t != null) out.push([t, parseFloat(mv[1])]);
  }
  return out;
}

function intervals(frames, lit) {
  const iv = [];
  let start = null, last = null, n = 0;
  for (const [t, v] of frames) {
    if (lit(v)) { if (start == null) { start = t; n = 0; } n++; last = t; }
    else if (start != null) { if (n >= 3) iv.push([start, last]); start = null; }
  }
  if (start != null && n >= 3) iv.push([start, last]);
  return iv;
}

const events = [];
for (const [s, e] of intervals(parse("L.log"), (v) => v > L_THRESH)) events.push({ side: "L", s, e });
for (const [s, e] of intervals(parse("R.log"), (v) => v < R_THRESH)) events.push({ side: "R", s, e });
events.sort((a, b) => a.s - b.s);

const merged = [];
for (const ev of events) {
  const m = merged[merged.length - 1];
  if (m && ev.s - m.s < 1.5) { m.sides.add(ev.side); m.e = Math.max(m.e, ev.e); }
  else merged.push({ s: ev.s, e: ev.e, sides: new Set([ev.side]) });
}
for (const m of merged) console.log(`${m.s.toFixed(2)} ${m.e.toFixed(2)} ${[...m.sides].sort().join("+")}`);
rmSync(work, { recursive: true, force: true });
