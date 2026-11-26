"use strict";
// Your instrument (auto-mute + transposition), mic level meters, A/B compare, loop pass counter,
// desktop notifications, the collapsible track list.

const INSTRUMENTS = [
  {id:"none", label:"Not set", transpose:0, mute:[]},
  {id:"alto", label:"Alto sax (E♭)", transpose:9, mute:["winds"]},
  {id:"bari", label:"Baritone sax (E♭)", transpose:9, mute:["winds"]},
  {id:"tenor", label:"Tenor sax (B♭)", transpose:2, mute:["winds"]},
  {id:"soprano", label:"Soprano sax (B♭)", transpose:2, mute:["winds"]},
  {id:"trumpet", label:"Trumpet (B♭)", transpose:2, mute:["winds"]},
  {id:"clarinet", label:"Clarinet (B♭)", transpose:2, mute:["winds"]},
  {id:"trombone", label:"Trombone (C)", transpose:0, mute:["winds"]},
  {id:"flute", label:"Flute (C)", transpose:0, mute:["winds"]},
  {id:"horn", label:"French horn (F)", transpose:7, mute:["winds"]},
  {id:"voice", label:"Voice", transpose:0, mute:["vocals"]},
  {id:"guitar", label:"Guitar", transpose:0, mute:["guitar"]},
  {id:"piano", label:"Piano / keys", transpose:0, mute:["piano"]},
  {id:"bass", label:"Bass", transpose:0, mute:["bass"]},
  {id:"drums", label:"Drums", transpose:0, mute:["drums"]},
];
if (!prefs.instrument) prefs.instrument = {9:"alto", 2:"tenor", 7:"horn"}[prefs.inst] || "none";  // older setting
$("#instSel").innerHTML = INSTRUMENTS.map(i => `<option value="${i.id}">${i.label}${i.mute.length ? ` — mutes ${i.mute.map(n => STEM_INFO[n].label).join(", ")}` : ""}</option>`).join("");

// --- loop pass counter
let loopPass = 1;
function updateLoopPass() {
  if (!playing || !loopOn()) { if (loopPass !== 1) { loopPass = 1; updateLoopHint(); } return; }
  const raw = offset + Math.max(0, ctx.currentTime - startedAt) * rate;
  const pass = raw < loopB ? 1 : 2 + Math.floor((raw - loopB) / (loopB - loopA));
  if (pass !== loopPass) { loopPass = pass; updateLoopHint(); }
}

// --- microphone level meters (while recording, and the test in Settings)
let recAnalyser = null, testAnalyser = null, testSrc = null;
const meterBuf = new Float32Array(2048);
function level(an) { an.getFloatTimeDomainData(meterBuf); let m = 0; for (const v of meterBuf) m = Math.max(m, Math.abs(v)); return m; }
function showLevel(el, an) {
  const v = level(an), db = 20 * Math.log10(v + 1e-6);
  el.querySelector("i").style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%";
  el.classList.toggle("clip", v > 0.98);
  return v;
}
let quietSince = 0;
function tickMeters() {
  if (recAnalyser && recording) {
    const v = showLevel($("#recMeter"), recAnalyser);
    if (v > 0.98) $("#recMeter").title = "Too loud — move back from the mic or turn the input down";
    if (v < 0.003) { if (!quietSince) quietSince = performance.now(); }
    else quietSince = 0;
  }
  if (testAnalyser) {
    const v = showLevel($("#testMeter"), testAnalyser);
    $("#micTestNote").textContent = v > 0.98 ? "Too loud" : v > 0.02 ? "Good level" : "Play or speak…";
  }
}
setInterval(tickMeters, 50);
function attachRecMeter() {
  recAnalyser = ctx.createAnalyser(); recAnalyser.fftSize = 2048;
  micNode.connect(recAnalyser); $("#recMeter").classList.add("show");
}
function detachRecMeter() { try { recAnalyser?.disconnect(); } catch {} recAnalyser = null; $("#recMeter").classList.remove("show"); }
$("#micTest").onclick = async () => {
  if (testAnalyser) return stopMicTest();
  ensureCtx(); await ctx.resume();
  try { await getMic(); } catch (e) { $("#micTestNote").textContent = e.name === "NotAllowedError" ? "Microphone access is blocked for this page" : e.message; return; }
  testSrc = ctx.createMediaStreamSource(micStream); testAnalyser = ctx.createAnalyser(); testAnalyser.fftSize = 2048;
  testSrc.connect(testAnalyser); $("#testMeter").classList.add("show"); $("#micTest").textContent = "Stop test";
  fillMics();  // device names become available once permission is granted
};
function stopMicTest() {
  try { testSrc?.disconnect(); } catch {} testSrc = testAnalyser = null;
  $("#testMeter").classList.remove("show"); $("#micTest").textContent = "Test microphone"; $("#micTestNote").textContent = "";
}
$("#settings").addEventListener("close", stopMicTest);

// --- A/B: hear the original song with nothing removed, then flip back
let abSaved = null;
function setAB(on) {
  if (on === !!abSaved) return;
  if (on) {
    abSaved = allParts().map(p => [p, p.mute, p.solo]);
    stems.forEach(s => { s.mute = false; s.solo = false; }); takes.forEach(t => { t.mute = true; t.solo = false; });
  } else {
    abSaved.forEach(([p, m, so]) => { p.mute = m; p.solo = so; }); abSaved = null;
  }
  $("#abBtn").setAttribute("aria-pressed", on); $("#abNote").style.display = on ? "inline" : "none";
  applyGains();
}
$("#abBtn").onclick = () => setAB(!abSaved);
// any manual mute/solo change ends A/B first, so you never get stuck in "original" by accident
document.addEventListener("click", e => { if (abSaved && e.target.closest(".ms, .presets button")) setAB(false); }, true);

// --- desktop notifications when a song finishes while you're in another app
function askNotify() { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); }
function notify(title, body, id) {
  if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  const n = new Notification(title, {body, tag: id});
  n.onclick = () => { window.focus(); openJob(id); n.close(); };
}
$("#linkForm").addEventListener("submit", askNotify);
$("#drop").addEventListener("click", askNotify);

// --- collapsible track list (handy on small windows)
$("#quitBtn").onclick = async () => {
  const busy = jobs.some(j => j.status === "running" || j.status === "queued");
  if (!confirm(busy ? "A song is still being processed. Quit anyway? It will carry on next time you open the app." : "Quit Backing Track Studio? Open it again any time from the app or run.sh.")) return;
  saveState(); try { await fetch("/api/quit", {method:"POST"}); } catch {}
  document.body.innerHTML = `<div style="margin:auto;text-align:center;color:#8a92a2;grid-column:1/-1"><h2 style="color:#e9ebf0">Backing Track Studio has stopped</h2><p>Open it again with the app or run.sh. You can close this tab.</p></div>`;
};
$("#libToggle").onclick = () => { document.body.classList.toggle("nolib"); requestAnimationFrame(drawAll); };
