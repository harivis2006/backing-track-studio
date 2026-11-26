"use strict";
// Beats and bars: the beat grid from the server (peaks.json "beats") plus your corrections
// (½×, 2×, bars start earlier/later), and helpers to find beats and bar lines.

// --- beat grid: detected beats + bar starts, with the user's optional corrections (½×, 2×, shift bar start)
function buildGrid(raw, ov = {}) {
  if (!raw || !raw.times || raw.times.length < 8) return null;
  let times = raw.times.slice(), perBar = raw.perBar || 4;
  let downs = raw.downbeats ? raw.downbeats.slice() : [];
  if (!raw.downbeats) for (let i = ((raw.downbeat || 0) % 4); i < times.length; i += 4) downs.push(i);  // old format
  if (ov.scale === 2) {
    const t2 = [];
    times.forEach((t, i) => { t2.push(t); if (i + 1 < times.length) t2.push((t + times[i + 1]) / 2); });
    times = t2; downs = downs.map(d => d * 2); perBar *= 2;
  } else if (ov.scale === 0.5) {
    const par = downs.filter(d => d % 2 === 0).length >= downs.filter(d => d % 2 === 1).length ? 0 : 1;
    times = times.filter((_, i) => i % 2 === par);
    downs = downs.filter(d => d % 2 === par).map(d => (d - par) / 2); perBar = Math.max(1, Math.round(perBar / 2));
  }
  if (ov.shift) downs = downs.map(d => d + ov.shift).filter(d => d >= 0 && d < times.length);
  if (!downs.length) for (let i = 0; i < times.length; i += perBar) downs.push(i);
  const n = times.length, isDown = new Uint8Array(n), barOf = new Int32Array(n), beatInBar = new Int8Array(n);
  downs.forEach(d => isDown[d] = 1);
  let bar = 0, last = -1;
  for (let i = 0; i < n; i++) {
    if (isDown[i]) { bar++; last = i; }
    barOf[i] = bar; beatInBar[i] = last < 0 ? ((i - downs[0]) % perBar + perBar) % perBar + 1 : i - last + 1;
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  return {times, isDown, barOf, beatInBar, perBar, tempo: 60 / gaps[gaps.length >> 1], downs};
}
function beatIndexAt(t) {  // last beat at or before t (binary search)
  const T = beats.times; let lo = 0, hi = T.length - 1;
  if (t < T[0]) return -1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= t) lo = m; else hi = m - 1; }
  return lo;
}
const localBeat = i => { const T = beats.times; i = clamp(i, 0, T.length - 2); return T[i + 1] - T[i]; };
const countBeats = () => beats ? (beats.perBar >= 3 ? beats.perBar : beats.perBar * 2) * prefs.countBars : 0;

let rawBeats = null, beatOv = {};
function barsIn(a, b) {
  const n = beats.downs.filter(d => beats.times[d] >= a - 0.05 && beats.times[d] < b - 0.05).length;
  return n === 1 ? "1 bar" : `${n} bars`;
}
function barLine(t, steps) {
  // Bar starts `steps` bars away. Going back from the middle of a bar first returns to that bar's start.
  const D = beats.downs.map(d => beats.times[d]);
  let cur = -1;
  for (let i = 0; i < D.length && D[i] <= t + 0.05; i++) cur = i;
  const target = steps < 0 && cur >= 0 && t - D[cur] > 0.3 ? cur + steps + 1 : cur + steps;
  return D[clamp(target, 0, D.length - 1)] ?? t;
}
function updateTempoLabel() {
  const el = $("#tempoLabel");
  if (!beats) { el.innerHTML = `<span title="No steady beat was detected in this song">Time</span>`; return; }
  const ov = beatOv.scale && beatOv.scale !== 1 ? (beatOv.scale === 2 ? " (2×)" : " (½×)") : "";
  el.innerHTML = `<button id="tempoBtn" class="iconbtn" style="padding:1px 7px;font-size:12px" title="Detected tempo. Click to fix it if the click is at half or double speed, or the bars start on the wrong beat.">♩ ${Math.round(beats.tempo)}${ov}${beats.perBar !== 4 ? ` · ${beats.perBar}/bar` : ""} ▾</button>`;
  $("#tempoBtn").onclick = e => { e.stopPropagation(); toggleTempoMenu(); };
}
function toggleTempoMenu() {
  let m = $("#tempoMenu");
  if (m) { m.remove(); return; }
  m = document.createElement("div"); m.id = "tempoMenu"; m.className = "menu";
  const sc = beatOv.scale || 1;
  m.innerHTML = `<div class="hint" style="padding:4px 10px 6px">Tempo is detected automatically. If the click sounds wrong:</div>
    <button data-a="half" ${sc === 0.5 ? "disabled" : ""}>Click is twice as fast as the beat → <b>½×</b></button>
    <button data-a="double" ${sc === 2 ? "disabled" : ""}>Click is half as fast as the beat → <b>2×</b></button>
    <button data-a="earlier">Bars start one beat <b>earlier</b></button>
    <button data-a="later">Bars start one beat <b>later</b></button>
    <button data-a="reset" ${!beatOv.scale && !beatOv.shift ? "disabled" : ""}>Back to detected</button>`;
  const r = $("#tempoBtn").getBoundingClientRect();
  m.style.left = r.left + "px"; m.style.top = (r.bottom + 4) + "px";
  document.body.appendChild(m);
  m.onclick = e => {
    const a = e.target.closest("button")?.dataset.a; if (!a) return;
    const sc = beatOv.scale || 1;
    if (a === "half") beatOv = {scale: sc === 2 ? 1 : 0.5, shift: 0};
    if (a === "double") beatOv = {scale: sc === 0.5 ? 1 : 2, shift: 0};
    if (a === "earlier") beatOv = {...beatOv, shift: (beatOv.shift || 0) - 1};
    if (a === "later") beatOv = {...beatOv, shift: (beatOv.shift || 0) + 1};
    if (a === "reset") beatOv = {};
    applyBeatOv(); m.remove();
  };
}
function applyBeatOv() {
  beats = buildGrid(rawBeats, beatOv);
  updateTempoLabel(); updateLoopHint(); saveState(); drawAll(); updateTime();
  if (playing && prefs.metro) { for (const c of clickNodes) { try { c.stop(); } catch {} } clickNodes = []; clickHorizon = ctx.currentTime; scheduleClicks(); }
  toast(beats ? `Tempo now ♩ ${Math.round(beats.tempo)}` : "Tempo reset");
}
document.addEventListener("click", e => { if (!e.target.closest("#tempoMenu") && !e.target.closest("#tempoBtn")) $("#tempoMenu")?.remove(); });
