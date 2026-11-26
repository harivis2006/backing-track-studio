"use strict";
// The audio engine: plays every part in sync with the Web Audio API, loops, the metronome/count-in
// scheduler, and keeping the video in step. Positions are always in original-song seconds.

// "Song time" = seconds in the original recording; that's what the UI always shows.
// Loaded buffers may be a slowed copy: buffer seconds = song seconds / rate.
// speed/semis = what the user picked; rate/rateSemis = what the loaded audio actually is.
let ctx, master, clickBus, stems = [], takes = [], duration = 0, playing = false, startedAt = 0, offset = 0;
let stemSources = [], segSources = [], clickNodes = [], segments = [], nextSeg = null, clickHorizon = 0;
let loopA = null, loopB = null, speed = 1, semis = 0, rate = 1, rateSemis = 0, loadedVariant = null, loadToken = 0;
let beats = null;  // {tempo, times[], downbeat}
const vid = $("#vid");

function ensureCtx() {
  if (ctx) return;
  try { ctx = new AudioContext({latencyHint:"interactive", sampleRate:44100}); }
  catch { ctx = new AudioContext({latencyHint:"interactive"}); }
  clickBufs = [makeClick(1200, false), makeClick(1800, true)];
  master = ctx.createGain(); master.connect(ctx.destination);
  clickBus = ctx.createGain(); clickBus.gain.value = prefs.clickVol; clickBus.connect(ctx.destination);  // not in exports
}
const live = () => stems.filter(s => !s.empty && s.buf);
const playableTakes = () => takes.filter(t => t.buf && t.rate === rate && t.semis === rateSemis);
const allParts = () => [...stems, ...takes];
function audible(p) {
  if (p.empty || (p.isTake && !(p.buf && p.rate === rate && p.semis === rateSemis))) return false;
  const anySolo = allParts().some(x => x.solo && !x.empty);
  return anySolo ? p.solo : !p.mute;
}
const loopOn = () => $("#loop").checked && loopA !== null;

function applyGains() {
  for (const p of allParts()) {
    if (p.gain) p.gain.gain.setTargetAtTime(audible(p) ? p.vol : 0, ctx.currentTime, 0.015);
    p.row.classList.toggle("off", !audible(p));
    p.mBtn.setAttribute("aria-pressed", p.mute); p.sBtn.setAttribute("aria-pressed", p.solo);
    p.volEl.title = `Volume ${Math.round(p.vol*100)}% (double-click to reset)`;
  }
  const muted = stems.filter(s => !s.empty && !audible(s)).map(s => s.name).sort().join();
  document.querySelectorAll("#presets button[data-stems]").forEach(b => {
    b.classList.toggle("on", b.dataset.stems === muted && muted !== "");
    b.classList.toggle("na", b.dataset.stems && b.dataset.stems.split(",").every(n => stems.find(s => s.name === n)?.empty));
  });
  saveState(); drawAll();
}

// --- position
function now() { return playing ? offset + Math.max(0, ctx.currentTime - startedAt) * rate : offset; }
function curPos() {
  let t = now();
  if (playing && loopOn() && t >= loopB) t = loopA + ((t - loopA) % (loopB - loopA));
  return clamp(t, 0, duration);
}
const beatLen = () => beats ? 60 / beats.tempo : 0.5;  // song seconds per beat (typical)

// --- play / pause
function play(from = curPos(), {countIn = prefs.countIn} = {}) {
  if (!live().length) return;
  ensureCtx(); ctx.resume(); stopAll();
  if (loopOn() && (from < loopA || from >= loopB - 0.05)) from = loopA;
  if (from >= duration - 0.05) from = 0;
  let lead = 0, cin = null;
  if (countIn && beats) {
    // count in from the start of the bar you're in, in the song's own tempo at that point
    const i = beatIndexAt(from + 0.05);
    let d = i; while (d > 0 && !beats.isDown[d]) d--;
    if (d >= 0 && beats.isDown[d] && from - beats.times[d] < beatLen() * beats.perBar + 0.1 && (!loopOn() || beats.times[d] >= loopA - 0.05)) from = beats.times[d];
    const g = localBeat(Math.max(0, d)) / rate, n = countBeats();
    lead = n * g; cin = {n, g, per: n / prefs.countBars};
  }
  const t0 = ctx.currentTime + 0.08 + lead;
  stemSources = live().map(s => {
    const src = ctx.createBufferSource(); src.buffer = s.buf; src.connect(s.gain);
    if (loopOn()) { src.loop = true; src.loopStart = loopA / rate; src.loopEnd = loopB / rate; }
    src.start(t0, from / rate);
    return src;
  });
  stemSources[0].onended = () => { if (playing && !loopOn()) endOfSong(); };
  startedAt = t0; offset = from; playing = true; lastSyncPos = from;
  segments = []; nextSeg = {ctx: t0, song: from}; clickHorizon = ctx.currentTime;
  if (lead) countInClicks(ctx.currentTime + 0.08, cin);
  scheduleAhead();
  updatePlayBtn();
  if (current?.video) { vid.pause(); vid.currentTime = from; vid.playbackRate = rate; if (!lead) vid.play().catch(() => {}); }
}
function endOfSong() {
  if (recording) stopRecording();
  playing = false; stopAll(); offset = 0; vid.pause(); updatePlayBtn(); drawAll(); updateTime();
}
function stopAll() {
  for (const s of [...stemSources, ...segSources]) { s.onended = null; try { s.stop(); } catch {} }
  for (const c of clickNodes) { try { c.stop(); } catch {} }
  stemSources = []; segSources = []; clickNodes = []; segments = []; nextSeg = null;
  countTimers.forEach(clearTimeout); countTimers = []; showCountdown("");
}
function pause() {
  if (recording) { stopRecording(); return; }
  offset = curPos(); stopAll(); playing = false; updatePlayBtn();
  if (current?.video) { vid.pause(); vid.currentTime = offset; }
  saveState(); drawAll(); updateTime();
}
function toggle() { playing ? pause() : play(); }
function seek(t) {
  t = clamp(t, 0, duration);
  if (recording) return;
  if (playing) play(t, {countIn:false}); else { offset = t; if (current?.video) vid.currentTime = t; }
  drawAll(); updateTime();
}
function updatePlayBtn() {
  for (const b of [$("#play"), $("#fsPlay")]) { b.textContent = playing ? "❚❚" : "▶"; b.setAttribute("aria-label", playing ? "Pause" : "Play"); }
}

// --- scheduler: takes and metronome clicks are placed pass-by-pass so they stay aligned through loops
function scheduleAhead() {
  if (!playing) return;
  const horizon = ctx.currentTime + 0.6;
  while (nextSeg && nextSeg.ctx < horizon) {
    const from = nextSeg.song, to = loopOn() ? loopB : duration;
    const seg = {ctx: nextSeg.ctx, from, to, end: nextSeg.ctx + (to - from) / rate};
    segments.push(seg); if (segments.length > 4) segments.shift();
    for (const t of playableTakes()) {  // take positions are in buffer time at the rate they were recorded
      const a = Math.max(t.start, from / rate), b = Math.min(t.start + t.buf.duration, to / rate);
      if (b <= a) continue;
      const src = ctx.createBufferSource(); src.buffer = t.buf; src.connect(t.gain);
      src.start(seg.ctx + (a - from / rate), a - t.start, b - a);
      segSources.push(src);
    }
    nextSeg = loopOn() ? {ctx: seg.end, song: loopA} : null;
  }
  if (segSources.length > 64) segSources = segSources.slice(-32);
  scheduleClicks();
}
function scheduleClicks() {
  if (!prefs.metro || !beats || !playing) return;
  const horizon = ctx.currentTime + 0.3;
  for (const seg of segments) {
    const lo = Math.max(clickHorizon, seg.ctx, ctx.currentTime), hi = Math.min(horizon, seg.end);
    if (hi <= lo) continue;
    const sLo = seg.from + (lo - seg.ctx) * rate, sHi = seg.from + (hi - seg.ctx) * rate;
    for (let i = Math.max(0, beatIndexAt(sLo)); i < beats.times.length && beats.times[i] < sHi; i++)
      if (beats.times[i] >= sLo) click(seg.ctx + (beats.times[i] - seg.from) / rate, isDownbeat(i));
  }
  clickHorizon = Math.max(clickHorizon, horizon);
}
// A short "woodblock" click: pitched tone + a little noise, pre-rendered once.
let clickBufs = null;
function makeClick(freq, accent) {
  const sr = ctx.sampleRate, n = Math.round(sr * 0.05), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    d[i] = (Math.sin(2 * Math.PI * freq * t) * 0.75 + Math.sin(2 * Math.PI * freq * 2.01 * t) * 0.2
            + (Math.random() * 2 - 1) * 0.3 * Math.exp(-t * 900)) * Math.exp(-t * (accent ? 70 : 95)) * (accent ? 1 : 0.7);
  }
  return b;
}
function click(when, accent) {
  if (when < ctx.currentTime) return;
  const s = ctx.createBufferSource(); s.buffer = clickBufs[accent ? 1 : 0]; s.connect(clickBus); s.start(when);
  clickNodes.push(s); if (clickNodes.length > 200) clickNodes = clickNodes.slice(-100);
}
let countTimers = [];
function countInClicks(start, {n, g, per}) {
  countTimers.forEach(clearTimeout); countTimers = [];
  for (let i = 0; i < n; i++) {
    click(start + i * g, i % per === 0);
    countTimers.push(setTimeout(() => { if (playing) showCountdown(String(i % per + 1)); }, (start + i * g - ctx.currentTime) * 1000));
  }
  countTimers.push(setTimeout(() => { showCountdown(""); if (playing && current?.video) vid.play().catch(() => {}); }, (start + n * g - ctx.currentTime) * 1000));
}
function showCountdown(txt) { $("#countdown").style.display = txt ? "grid" : "none"; $("#countdown span").textContent = txt; }
const isDownbeat = i => !!(beats && i >= 0 && beats.isDown[i]);

// --- video follows the audio clock
let lastSyncPos = 0;
function syncVideo() {
  if (!current?.video || !playing || vid.readyState < 2) return;
  if (ctx.currentTime < startedAt) return;  // counting in
  if (vid.paused) vid.play().catch(() => {});
  const target = curPos(), drift = vid.currentTime - target, wrapped = target < lastSyncPos;
  lastSyncPos = target;
  if (wrapped || Math.abs(drift) > 0.25) { vid.currentTime = target + 0.07 * rate; vid.playbackRate = rate; }
  else vid.playbackRate = rate * (1 - clamp(drift, -0.05, 0.05));
}
