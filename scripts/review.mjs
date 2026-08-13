#!/usr/bin/env node
/**
 * Reassemble a probe run into a visual review: filmstrip + timeline overlay of the
 * perception record + the adjudication analysis, one section per touch, written as a
 * single self-contained HTML file (frames embedded as data URIs).
 *
 *   node scripts/review.mjs results/run-....jsonl            # every touch in the run
 *   node scripts/review.mjs results/run-....jsonl t001 t007  # named touches only
 *
 * Post-hoc only: reads results and ground truth AFTER the run, like score.mjs.
 * Nothing produced here ever reaches a prompt.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const runPath = process.argv[2];
if (!runPath) {
  console.error("usage: node scripts/review.mjs results/run-....jsonl [touch ids...]");
  process.exit(1);
}
const named = process.argv.slice(3);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtMs = (ms) => `${ms >= 0 ? "+" : ""}${ms}ms`;

const truth = new Map();
for (const line of readFileSync("clips/ground_truth.csv", "utf8").trim().split("\n").slice(1)) {
  if (!line.trim()) continue;
  const [id, call, tier, action, notes] = line.split(",").map((s) => s.trim());
  truth.set(id, { call, tier, action, notes });
}

const lines = readFileSync(runPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const meta = lines.find((l) => l.meta)?.meta;
const rows = lines.filter((l) => !l.meta && (!named.length || named.includes(l.touch_id)));

// --------------------------------------------------------------------------- frames

// FRAMES_ROOT lets a share/artifact build embed downscaled copies instead of the
// full-size frames (the full page is ~33MB; shareable pages must stay under 16MB).
const FRAMES_ROOT = process.env.FRAMES_ROOT ?? "frames";

function frameImages(touchId) {
  const dir = join(FRAMES_ROOT, touchId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /ms\.jpg$/.test(f))
    .map((f) => ({ offset: parseInt(f.replace(/ms\.jpg$/, ""), 10), file: join(dir, f) }))
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, file }) => ({ offset, src: `data:image/jpeg;base64,${readFileSync(file).toString("base64")}` }));
}

// --------------------------------------------------------------------------- timeline

const T0 = -2100, T1 = 180, W = 1060, H = 190;
const xOf = (ms) => Math.round(((ms - T0) / (T1 - T0)) * W);

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

function lane(markers, y, color) {
  let s = `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#3a3b3e"/>`;
  markers.forEach((m, i) => {
    const px = xOf(m.ms);
    const above = i % 2 === 0;
    s += `<circle class="dot" data-ms="${m.ms}" cx="${px}" cy="${y}" r="4" fill="${color}"><title>${esc(m.label)} ${fmtMs(m.ms)}</title></circle>`;
    s += `<text class="lbl" data-ms="${m.ms}" x="${px}" y="${above ? y - 9 : y + 17}" text-anchor="middle" font-size="10" fill="${color}">${esc(m.label)} ${fmtMs(m.ms)}</text>`;
  });
  return s;
}

function timelineSvg(p) {
  if (!p) return "";
  const yL = 46, yB = 96, yR = 146;
  let s = `<svg viewBox="0 0 ${W} ${H}" class="tl" data-t0="${T0}" data-t1="${T1}" data-w="${W}" style="width:100%;background:#17181a;border:1px solid #333;border-radius:6px">`;
  for (let ms = -2000; ms <= 0; ms += 500) {
    s += `<line x1="${xOf(ms)}" y1="20" x2="${xOf(ms)}" y2="${H - 22}" stroke="#26272a"/>`;
    s += `<text x="${xOf(ms)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#9a9a92">${fmtMs(ms)}</text>`;
  }
  s += `<line class="lightline" x1="${xOf(0)}" y1="14" x2="${xOf(0)}" y2="${H - 22}" stroke="#f59e0b" stroke-width="2"/>`;
  s += `<text x="${xOf(0)}" y="12" text-anchor="middle" font-size="10" fill="#f5b942">LIGHT</text>`;
  s += `<text x="4" y="${yL - 18}" font-size="11" font-weight="bold" fill="#5b9dff">LEFT</text>`;
  s += `<text x="4" y="${yR + 26}" font-size="11" font-weight="bold" fill="#ff7069">RIGHT</text>`;
  s += lane(markersFor(p.left), yL, "#5b9dff");
  s += lane(markersFor(p.right), yR, "#ff7069");
  const contacts = (p.blade_contact ?? []).filter((c) => c.ms != null);
  contacts.forEach((c, i) => {
    const px = xOf(c.ms);
    s += `<rect class="dot" data-ms="${c.ms}" x="${px - 4}" y="${yB - 4}" width="8" height="8" transform="rotate(45 ${px} ${yB})" fill="#b191ff"><title>${esc(c.description ?? "")}</title></rect>`;
    s += `<text class="lbl" data-ms="${c.ms}" x="${px}" y="${i % 2 === 0 ? yB - 9 : yB + 17}" text-anchor="middle" font-size="10" fill="#b191ff">contact/${esc(c.deflection)} ${fmtMs(c.ms)}</text>`;
  });
  // Playback layer: progress lines sweep each lane on the shared clock, a playhead
  // crosses both lanes, tips glow, and the light line bursts at t=0. All driven by
  // the inline player script; invisible until playback starts.
  s += `<line class="prog prog-l" x1="0" y1="${yL}" x2="0" y2="${yL}"/>`;
  s += `<line class="prog prog-r" x1="0" y1="${yR}" x2="0" y2="${yR}"/>`;
  s += `<line class="ph" x1="0" y1="14" x2="0" y2="${H - 22}"/>`;
  s += `<circle class="tip tip-l" cx="0" cy="${yL}" r="5"/>`;
  s += `<circle class="tip tip-r" cx="0" cy="${yR}" r="5"/>`;
  s += `<circle class="flash" cx="${xOf(0)}" cy="${yB}" r="12"/>`;
  return s + `</svg>`;
}

// --------------------------------------------------------------------------- panels

function filmstrip(touchId, p) {
  const frames = frameImages(touchId);
  if (!frames.length) return `<p class="nofr">No frames on disk for ${esc(touchId)} — timeline and analysis only.</p>`;
  const hot = new Set([...markersFor(p?.left), ...markersFor(p?.right)].map((m) => m.ms));
  for (const c of p?.blade_contact ?? []) if (c.ms != null) hot.add(c.ms);
  const figs = frames.map((f) =>
    `<figure class="${hot.has(f.offset) ? "hot" : ""}" data-ms="${f.offset}"><img src="${f.src}" alt="frame ${fmtMs(f.offset)}"><figcaption>${fmtMs(f.offset)}</figcaption></figure>`
  );
  return `<div class="filmstrip">${figs.join("")}</div>`;
}

// Play controls + live frame viewer. The viewer starts src-less and is fed by the
// player script from the filmstrip's data URIs, so frames are embedded only once.
function playerBar() {
  return `<div class="player">
    <button class="pp" type="button">&#9654; Play</button>
    <input class="scrub" type="range" min="${T0}" max="${T1}" step="5" value="${T0}">
    <span class="tro">${T0}ms</span>
    <label class="spdl">speed <select class="spd">
      <option value="18000">1/8&times;</option>
      <option value="9000" selected>1/4&times;</option>
      <option value="4500">1/2&times;</option>
    </select></label>
  </div>
  <img class="viewer" alt="current frame">`;
}

function perceptionPanel(p) {
  if (!p) return "";
  const reasons = (p.quality_reasons ?? []).map((r) => `<li>${esc(r)}</li>`).join("");
  const events = (p.events ?? []).map((e) =>
    `<li>${e.ms != null ? fmtMs(e.ms) : "t=?"} <b>${esc(e.actor)}</b>: ${esc(e.action)} <span class="dim">(conf ${esc(e.confidence)}, basis: ${esc(e.basis)})</span></li>`
  ).join("");
  return `<div class="panel">
    <h3>Perception <span class="q q-${esc(p.perception_quality)}">${esc(p.perception_quality)}</span></h3>
    <p>${esc(p.narration)}</p>
    ${reasons ? `<ul class="dim">${reasons}</ul>` : ""}
    ${events ? `<h4>Grounded events</h4><ul>${events}</ul>` : ""}
    <p class="dim">frames usable: ${esc(p.frames_usable)}</p>
  </div>`;
}

function adjudicationPanel(a, gt) {
  if (!a) return "";
  const phrase = (a.phrase ?? []).map((s) =>
    `<tr><td>${esc(s.order)}</td><td>${esc(s.actor)}</td><td>${esc(s.action)}</td><td>${s.ms != null ? fmtMs(s.ms) : "—"}</td><td>${esc(s.outcome)}</td></tr>`
  ).join("");
  const evidence = (a.evidence ?? []).map((e) => `<li>${esc(e)}</li>`).join("");
  const flags = (a.hard_case_flags ?? []).map((f) => `<span class="flag">${esc(f)}</span>`).join(" ");
  let verdict;
  if (a.call === "no_call") {
    verdict = `<span class="badge abstain">no_call — abstention (a success state)</span>`;
  } else if (gt) {
    verdict = a.call === gt.call
      ? `<span class="badge ok">✓ matches ground truth (${esc(gt.call)})</span>`
      : `<span class="badge miss">✗ expected ${esc(gt.call)}</span>`;
  } else {
    verdict = `<span class="dim">no ground truth row</span>`;
  }
  const alt = a.alternate_reading ?? {};
  return `<div class="panel">
    <h3>Adjudication: <b>${esc(a.call)}</b> @ ${esc(a.confidence)} ${verdict}</h3>
    ${flags ? `<p>${flags}</p>` : ""}
    <p><b>${esc(a.rule_cited)}</b> — ${esc(a.rule_detail)}</p>
    ${phrase ? `<table><tr><th>#</th><th>actor</th><th>action</th><th>t</th><th>outcome</th></tr>${phrase}</table>` : ""}
    ${evidence ? `<h4>Evidence</h4><ul>${evidence}</ul>` : ""}
    <h4>Alternate reading</h4>
    <p>${alt.call === "none" ? `<span class="badge miss">none given</span>` : `<b>${esc(alt.call)}</b> (plausibility ${esc(alt.plausibility)}) — ${esc(alt.why)}`}</p>
    ${a.decisive_uncertainty ? `<h4>Decisive uncertainty</h4><p>${esc(a.decisive_uncertainty)}</p>` : ""}
  </div>`;
}

function touchSection(r) {
  const gt = truth.get(r.touch_id);
  const head = `${esc(r.touch_id)}${gt ? ` — tier ${esc(gt.tier)} — ${esc(gt.action)}` : ""}`;
  const errBanner = r.error ? `<p class="badge miss">RUN ERROR: ${esc(r.error)}</p>` : "";
  if (r.error && !r.perception) {
    return `<section class="touch"><h2>${head}</h2>${errBanner}</section>`;
  }
  const p = r.perception;
  const q = p?.perception_quality;
  const kind =
    r.adjudication && gt && r.adjudication.call !== "no_call" && r.adjudication.call !== gt.call
      ? `<span class="badge kind">${q === "good" ? "JUDGMENT failure" : (q === "partial" || q === "poor") ? "PERCEPTION failure" : "failure (quality missing)"}</span>`
      : "";
  const strip = filmstrip(r.touch_id, p);
  const hasFrames = strip.includes("filmstrip");
  return `<section class="touch">
    <h2>${head} ${kind}</h2>
    ${errBanner}
    ${strip}
    ${hasFrames && p ? playerBar() : ""}
    ${timelineSvg(p)}
    <div class="panels">${perceptionPanel(p)}${adjudicationPanel(r.adjudication, gt)}</div>
  </section>`;
}

// --------------------------------------------------------------------------- page

const title = (basename(runPath).replace(/\.jsonl$/, "") + (named.length ? `-${named.join("-")}` : "")).replace(/[^\w.-]/g, "_");
const html = `<!doctype html><html><head><meta charset="utf-8">
<title>sabre probe review — ${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px; background: #101113; color: #e7e7e2; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin: 8px 0; } h3 { font-size: 14px; margin: 4px 0 8px; } h4 { font-size: 12px; margin: 10px 0 2px; text-transform: uppercase; color: #9a9a92; }
  .meta { color: #9a9a92; font-size: 13px; font-family: monospace; }
  .stub-banner { background: #3a2c10; border: 1px solid #f59e0b; color: #f2c66d; padding: 8px 12px; border-radius: 6px; font-weight: bold; }
  .touch { border-top: 2px solid #2c2d30; padding: 18px 0; }
  .filmstrip { display: flex; overflow-x: auto; gap: 4px; padding-bottom: 6px; margin-bottom: 10px; }
  .filmstrip figure { margin: 0; flex: 0 0 auto; width: 104px; }
  .filmstrip img { width: 100%; display: block; border: 2px solid transparent; border-radius: 3px; }
  .filmstrip figure.hot img { border-color: #f59e0b; }
  .filmstrip figure.cur img { border-color: #e7e7e2; }
  .filmstrip figure[data-ms] { cursor: pointer; }
  .filmstrip figcaption { font-size: 10px; text-align: center; font-family: monospace; color: #9a9a92; }
  .player { display: flex; align-items: center; gap: 10px; margin: 2px 0 8px; }
  .player button { background: #26272a; color: #e7e7e2; border: 1px solid #444; border-radius: 6px; padding: 4px 14px; font-size: 13px; cursor: pointer; min-width: 92px; }
  .player button:hover { background: #333; }
  .scrub { flex: 1; accent-color: #f59e0b; }
  .tro { font-family: monospace; font-size: 12px; color: #f2c66d; min-width: 66px; text-align: right; }
  .spdl { font-size: 12px; color: #9a9a92; }
  .spd { background: #26272a; color: #e7e7e2; border: 1px solid #444; border-radius: 4px; }
  .viewer { display: none; width: 100%; max-height: 420px; object-fit: contain; background: #000; border: 1px solid #333; border-radius: 6px; margin-bottom: 8px; }
  .viewer[src] { display: block; }
  /* timeline playback layer */
  svg.tl .dot, svg.tl .lbl, svg.tl .tip, svg.tl .flash { transform-box: fill-box; transform-origin: center; }
  svg.tl .dot, svg.tl .lbl { transition: opacity .25s, transform .25s, filter .25s; }
  svg.tl.playing .dot { opacity: .22; transform: scale(.7); }
  svg.tl.playing .lbl { opacity: .18; }
  svg.tl.playing .dot.on { opacity: 1; transform: scale(1.3); filter: drop-shadow(0 0 3px rgba(255,255,255,.7)); }
  svg.tl.playing .lbl.on { opacity: 1; }
  svg.tl .prog, svg.tl .tip, svg.tl .ph { display: none; }
  svg.tl.playing .prog, svg.tl.playing .tip, svg.tl.playing .ph { display: block; }
  svg.tl .prog-l { stroke: #5b9dff; stroke-width: 3; stroke-linecap: round; filter: drop-shadow(0 0 4px #5b9dff); }
  svg.tl .prog-r { stroke: #ff7069; stroke-width: 3; stroke-linecap: round; filter: drop-shadow(0 0 4px #ff7069); }
  svg.tl .tip-l { fill: #cfe3ff; filter: drop-shadow(0 0 5px #5b9dff); }
  svg.tl .tip-r { fill: #ffd9d7; filter: drop-shadow(0 0 5px #ff7069); }
  svg.tl .ph { stroke: #e7e7e2; stroke-width: 1; opacity: .55; stroke-dasharray: 3 3; }
  svg.tl .flash { fill: #f59e0b; opacity: 0; pointer-events: none; }
  svg.tl.lit .flash { animation: flashburst .8s ease-out; }
  svg.tl.lit .lightline { filter: drop-shadow(0 0 7px #f59e0b); }
  @keyframes flashburst { 0% { opacity: .95; transform: scale(.4); } 100% { opacity: 0; transform: scale(7); } }
  .panels { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
  .panel { flex: 1 1 340px; background: #1b1d1f; border: 1px solid #333; border-radius: 6px; padding: 12px; font-size: 13px; }
  .panel ul { margin: 4px 0; padding-left: 18px; } .panel table { border-collapse: collapse; font-size: 12px; margin: 6px 0; }
  .panel th, .panel td { border: 1px solid #37383b; padding: 2px 8px; text-align: left; }
  .badge { padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: normal; }
  .ok { background: #14351f; color: #7fd89a; } .miss { background: #3a1517; color: #f0918f; }
  .abstain { background: #1b2145; color: #a5b4fc; } .kind { background: #3a2c10; color: #f2c66d; }
  .q { padding: 1px 8px; border-radius: 10px; font-size: 11px; }
  .q-good { background: #14351f; color: #7fd89a; } .q-partial { background: #3a2c10; color: #f2c66d; } .q-poor { background: #3a1517; color: #f0918f; }
  .flag { background: #2a2140; color: #c4b5fd; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-family: monospace; }
  .dim { color: #8b8b84; } .nofr { color: #8b8b84; font-style: italic; }
</style></head><body>
<h1>Touch review — ${esc(title)}</h1>
${meta?.stub ? `<p class="stub-banner">STUB RUN — canned responses, not real analysis</p>` : ""}
${meta ? `<p class="meta">models ${esc(meta.perception_model)} → ${esc(meta.adjudication_model)} · prompts ${esc(meta.prompts_sha256)} · ${esc(meta.run_at)}${meta.mode ? ` · mode ${esc(meta.mode)}` : ""}</p>` : ""}
${rows.map(touchSection).join("\n")}
<script>
(() => {
  for (const sec of document.querySelectorAll("section.touch")) {
    const svg = sec.querySelector("svg.tl");
    const strip = sec.querySelector(".filmstrip");
    if (!svg || !strip) continue;
    const T0 = +svg.dataset.t0, T1 = +svg.dataset.t1, Wd = +svg.dataset.w;
    const xOf = (ms) => ((ms - T0) / (T1 - T0)) * Wd;
    const frames = [...strip.querySelectorAll("figure[data-ms]")]
      .map((fig) => ({ ms: +fig.dataset.ms, img: fig.querySelector("img"), fig }))
      .sort((a, b) => a.ms - b.ms);
    const viewer = sec.querySelector(".viewer");
    const dots = [...svg.querySelectorAll("[data-ms]")];
    const progL = svg.querySelector(".prog-l"), progR = svg.querySelector(".prog-r");
    const tipL = svg.querySelector(".tip-l"), tipR = svg.querySelector(".tip-r");
    const ph = svg.querySelector(".ph");
    const pp = sec.querySelector(".pp"), scrub = sec.querySelector(".scrub");
    const tro = sec.querySelector(".tro"), spd = sec.querySelector(".spd");
    let t = T0, raf = null, lastTs = null, playedOnce = false;

    if (viewer && frames.length) viewer.src = frames[0].img.src;

    function setT(nt) {
      t = Math.max(T0, Math.min(T1, nt));
      svg.classList.add("playing");
      const x = xOf(t);
      progL.setAttribute("x2", x); progR.setAttribute("x2", x);
      tipL.setAttribute("cx", x);  tipR.setAttribute("cx", x);
      ph.setAttribute("x1", x);    ph.setAttribute("x2", x);
      for (const d of dots) d.classList.toggle("on", t >= +d.dataset.ms);
      svg.classList.toggle("lit", t >= 0);
      let cur = frames[0];
      for (const f of frames) if (f.ms <= t) cur = f;
      if (viewer && cur && viewer.src !== cur.img.src) viewer.src = cur.img.src;
      for (const f of frames) f.fig.classList.toggle("cur", f === cur);
      if (scrub) scrub.value = t;
      if (tro) tro.textContent = (t >= 0 ? "+" : "") + Math.round(t) + "ms";
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = null; lastTs = null;
      if (pp) pp.innerHTML = "&#9654; Play";
    }
    function play() {
      if (raf) { stop(); return; }
      if (t >= T1 - 1) setT(T0);
      if (pp) pp.innerHTML = "&#10074;&#10074; Pause";
      const step = (ts) => {
        if (lastTs == null) lastTs = ts;
        const dur = spd ? +spd.value : 9000;
        setT(t + ((ts - lastTs) * (T1 - T0)) / dur);
        lastTs = ts;
        if (t >= T1) { stop(); return; }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }
    if (pp) pp.addEventListener("click", play);
    if (scrub) scrub.addEventListener("input", () => { stop(); setT(+scrub.value); });
    for (const f of frames) f.fig.addEventListener("click", () => { stop(); setT(f.ms); });
    new IntersectionObserver((entries, obs) => {
      for (const e of entries) if (e.isIntersecting && !playedOnce) { playedOnce = true; play(); obs.disconnect(); }
    }, { threshold: 0.35 }).observe(sec);
  }
})();
</script>
</body></html>`;

mkdirSync("reviews", { recursive: true });
const outPath = join("reviews", `${title}.html`);
writeFileSync(outPath, html);
console.log(`Wrote ${outPath}  (${rows.length} touches, ${(html.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`Open it:  open ${outPath}`);
