#!/usr/bin/env node
/**
 * Detect scoring-lamp events in a match video by chroma shift on the overhead lamp
 * panels (calibrated on USA Fencing 720p stream framing; override via env).
 *
 *   node scripts/detect-lights.mjs videos/MATCH.mp4
 *
 * Prints one event per line: "<onset_s> <end_s> <L|R|L+R>", with " gap=<s>" appended on
 * L+R events (the spread between the two sides' detected onsets). A gap much larger
 * than the ~120ms sabre lockout means a camera pan dragged a graphic through a lamp
 * crop and one side is likely FAKE — verify against full frames before trusting it.
 * Pure ffmpeg + node — no model calls. Used standalone or by the /airs command.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
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

const FFMPEG = process.env.FFMPEG
  ?? (existsSync("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg") ? "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" : "ffmpeg");

const work = mkdtempSync(join(tmpdir(), "airs-lamps-"));
try {
execFileSync(FFMPEG, [
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
  if (m && ev.s - m.s < 1.5) {
    if (m.onsets[ev.side] == null) m.onsets[ev.side] = ev.s;
    m.e = Math.max(m.e, ev.e);
  } else merged.push({ s: ev.s, e: ev.e, onsets: { [ev.side]: ev.s } });
}
for (const m of merged) {
  const sides = Object.keys(m.onsets).sort().join("+");
  const gap = m.onsets.L != null && m.onsets.R != null
    ? ` gap=${Math.abs(m.onsets.L - m.onsets.R).toFixed(2)}`
    : "";
  console.log(`${m.s.toFixed(2)} ${m.e.toFixed(2)} ${sides}${gap}`);
}
} finally {
  rmSync(work, { recursive: true, force: true });
}
