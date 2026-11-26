"use strict";
// Opening a song: building the part rows, loading audio (or a practice version), video, presets,
// and remembering your settings per song.

function closeStudio() {
  if (recording) stopRecording();
  if (playing) pause();
  loadToken++; current = null; teardown();
  vid.removeAttribute("src"); vid.load();
  $("#studio").style.display = "none"; $("#empty").style.display = "";
  renderLib();
}
function teardown() {
  if (abSaved) { abSaved = null; $("#abBtn").setAttribute("aria-pressed", false); $("#abNote").style.display = "none"; }
  stopAll(); playing = false;
  for (const p of allParts()) { try { p.gain?.disconnect(); } catch {} }
  stems = []; takes = []; beats = null; rawBeats = null; beatOv = {}; markers = []; songKey = null; syncToggles(); $("#tempoMenu")?.remove();
  $("#stemRows").innerHTML = ""; $("#takeRows").innerHTML = ""; $("#tempoLabel").textContent = "";
}
const abFlag = (p, k) => abSaved ? (abSaved.find(x => x[0] === p)?.[k] ?? (k === 1 ? p.mute : p.solo)) : (k === 1 ? p.mute : p.solo);
function saveState() {
  if (!current || !stems.length) return;
  store.set(current.id, {
    mute:Object.fromEntries(stems.map(s => [s.name, abFlag(s, 1)])), solo:Object.fromEntries(stems.map(s => [s.name, abFlag(s, 2)])),
    vol:Object.fromEntries(stems.map(s => [s.name, s.vol])),
    takes:Object.fromEntries(takes.map(t => [t.id, {mute:abFlag(t, 1), solo:abFlag(t, 2), vol:t.vol}])),
    master:+$("#master").value, loopA, loopB, loopOn:$("#loop").checked, speed, semis,
    hideVideo:!$("#videoWrap").classList.contains("show"), pos:curPos(),
    viewA:view.a, viewB:view.b, markers, beatOv,
  });
}
async function openJob(id) {
  const job = jobs.find(j => j.id === id); if (!job || job.status !== "done") return;
  if (recording) await stopRecording();
  if (playing) pause();
  clearTimeout(practiceTimer);
  const token = ++loadToken;
  current = job; localStorage.setItem("bts:last", id); renderLib();
  teardown();
  $("#empty").style.display = "none"; $("#studio").style.display = "flex";
  $("#title").textContent = job.title;
  document.title = job.title + " · Backing Track Studio";
  let srcLabel = "";
  try { srcLabel = /youtu\.?be/.test(job.url) ? "YouTube" : new URL(job.url).hostname; } catch {}
  $("#source").innerHTML = job.matched
    ? `From <a href="${esc(job.url)}" target="_blank" rel="noopener">Spotify</a> · audio from YouTube: <a href="${esc(job.matched.url)}" target="_blank" rel="noopener">${esc(job.matched.title)}</a> (${esc(job.matched.channel)})`
    : job.url ? `From <a href="${esc(job.url)}" target="_blank" rel="noopener">${esc(srcLabel)}</a>` : "";
  const st = store.get(id);
  ensureCtx();
  offset = st.pos && st.pos < (job.duration || 1e9) ? st.pos : 0;
  loopA = st.loopA ?? null; loopB = st.loopB ?? null; $("#loop").checked = !!st.loopOn && loopA !== null;
  $("#master").value = st.master ?? 1; master.gain.value = +$("#master").value;
  speed = st.speed || 1; semis = st.semis || 0; rate = 1; rateSemis = 0; loadedVariant = null; updatePracticeUI();
  setupVideo(job, !st.hideVideo);
  setLoading(0.05, true);
  let peaks;
  try { peaks = await (await api(`/api/jobs/${id}/peaks`)).json(); }
  catch (err) { if (token === loadToken) { toast(`Couldn't open track: ${err.message}`, {type:"err"}); setLoading(1, false); } return; }
  if (token !== loadToken) return;
  duration = peaks.duration || job.duration || 0;
  rawBeats = peaks.beats; beatOv = st.beatOv || {}; beats = buildGrid(rawBeats, beatOv);
  songKey = peaks.key || null; markers = Array.isArray(st.markers) ? st.markers.filter(m => m.t < duration) : [];
  setView(st.viewA ?? 0, st.viewB && st.viewB <= duration + 0.01 ? st.viewB : duration, {keep:true}); updateKeyName();
  updateTempoLabel();
  stems = job.stems.map(name => buildRow(name, peaks.stems[name], st));
  const inst = INSTRUMENTS.find(i => i.id === prefs.instrument);
  if (!st.mute && inst?.mute.length) {  // first time this song is opened
    const hit = stems.filter(s => inst.mute.includes(s.name) && !s.empty);
    hit.forEach(s => s.mute = true);
    if (hit.length) toast(`Muted ${hit.map(s => STEM_INFO[s.name].label).join(", ")} because you play ${inst.label.replace(/ \(.*\)/, "").toLowerCase()}. Press A to compare with the original.`, {ms: 7000});
  }
  syncToggles(); updateLoopHint(); applyGains(); updateTime();
  await loadVariant(token);
  if (token === loadToken) loadTakes(token);
}
function buildRow(name, pk, st) {
  const info = STEM_INFO[name] || {label:name, desc:""};
  const empty = !pk || pk.silent;
  const row = document.createElement("div"); row.className = "row" + (empty ? " empty" : "");
  row.innerHTML = `<div class="ctl"><div class="sw" style="background:var(--${name})"></div>
      <div class="nm"><b>${info.label}</b><small>${empty ? "Not in this song" : info.desc}</small></div>
      <button class="ms m" aria-pressed="false" title="Mute">M</button><button class="ms s" aria-pressed="false" title="Solo">S</button>
      <input type="range" min="0" max="1.5" step="0.01" value="1" aria-label="${info.label} volume"></div>
    <div class="wavewrap"><canvas class="wave"></canvas></div>`;
  $("#stemRows").appendChild(row);
  const s = {name, empty, row, buf:null, gain:null, peaks: pk ? Uint8Array.from(pk.peaks) : new Uint8Array(1),
             mute: !!st.mute?.[name], solo: !!st.solo?.[name], vol: st.vol?.[name] ?? 1,
             color: css(`--${name}`) || "#aaa", canvas: row.querySelector("canvas"),
             mBtn: row.querySelector(".m"), sBtn: row.querySelector(".s"), volEl: row.querySelector("input")};
  if (!empty) { s.gain = ctx.createGain(); s.gain.gain.value = 0; s.gain.connect(master); attachWaveMouse(s.canvas); }
  s.volEl.value = s.vol;
  s.mBtn.onclick = () => { s.mute = !s.mute; applyGains(); };
  s.sBtn.onclick = () => { s.solo = !s.solo; applyGains(); };
  s.volEl.oninput = () => { s.vol = +s.volEl.value; applyGains(); };
  s.volEl.ondblclick = () => { s.vol = 1; s.volEl.value = 1; applyGains(); };
  return s;
}
async function loadVariant(token, key = "") {
  const want = {speed, semis};
  const stale = () => token !== loadToken || want.speed !== speed || want.semis !== semis;
  if (want.speed !== 1 || want.semis !== 0) {
    const est = Math.max(3, Math.round((duration / 60) * 8));
    $("#practiceStatus").textContent = `Preparing ${Math.round(want.speed*100)}%, key ${want.semis>0?"+":""}${want.semis}… (~${est} s the first time; keep playing meanwhile)`;
    try {
      key = (await (await api(`/api/jobs/${current.id}/variant`, {method:"POST", headers:{"Content-Type":"application/json"},
             body:JSON.stringify({speed: want.speed, semitones: want.semis})})).json()).key;
    } catch (err) {
      if (stale()) return;
      toast(`Couldn't change speed/key: ${err.message}`, {type:"err"});
      speed = rate; semis = rateSemis; updatePracticeUI(); saveState(); $("#practiceStatus").textContent = "";
      return;
    }
    if (stale()) return;
  }
  if (key === loadedVariant && live().length) { $("#practiceStatus").textContent = ""; return; }
  const todo = stems.filter(s => !s.empty);
  let done = 0;
  setLoading(0.1, true);
  try {
    const url = s => `/api/jobs/${current.id}/stems/${s.name}${key ? "?v=" + encodeURIComponent(key) : ""}`;
    const bufs = await Promise.all(todo.map(async s => {
      let data;
      try { data = await (await api(url(s))).arrayBuffer(); }
      catch { data = await (await api(url(s), {cache:"reload"})).arrayBuffer(); }  // one retry, bypassing the cache
      const b = await ctx.decodeAudioData(data);
      setLoading(0.1 + 0.9 * (++done / todo.length), true);
      return b;
    }));
    if (stale()) return;
    if (recording) await stopRecording();
    const pos = curPos(), was = playing;  // measured with the OLD rate, before swapping
    if (was) { stopAll(); playing = false; }
    todo.forEach((s, i) => s.buf = bufs[i]);
    loadedVariant = key; rate = want.speed; rateSemis = want.semis;
    updateTakeRows(); applyGains(); updateKeyName();
    $("#practiceStatus").textContent = "";
    setLoading(1, false);
    offset = pos;
    if (was) play(pos, {countIn:false});
  } catch (err) {
    if (!stale()) { toast(`Couldn't load audio: ${err.message}`, {type:"err"}); setLoading(1, false); $("#practiceStatus").textContent = ""; }
  }
}
function setLoading(frac, on) {
  const bar = $("#loadingBar");
  bar.style.transform = `scaleX(${frac})`; bar.style.opacity = on ? 1 : 0;
  $("#play").disabled = $("#rec").disabled = on && !live().length;
  $("#exportBtn").disabled = on;
}
// ---- video: a panel you can resize by dragging its bottom edge, go fullscreen with, or pop out (picture-in-picture)
const vwrap = $("#videoWrap");
const VIDEO_MIN = 120, videoMax = () => Math.max(VIDEO_MIN, Math.round(Math.min(innerHeight * 0.7, innerHeight - 340)));  // always leave room for a few parts
function setVideoHeight(h, save = true) {
  h = clamp(Math.round(h), VIDEO_MIN, videoMax());
  vwrap.style.height = h + "px";
  if (save) { prefs.videoH = h; savePrefs(); }
  requestAnimationFrame(drawAll);
}
function showVideo(show) {
  vwrap.classList.toggle("show", show); $("#videoToggle").classList.toggle("on", show);
  if (!show && document.fullscreenElement === vwrap) document.exitFullscreen();
  if (!show && vwrap.classList.contains("pseudo")) fillWindow(false);
  saveState(); requestAnimationFrame(drawAll);
}
function setupVideo(job, show) {
  $("#videoToggle").hidden = !job.video;
  vwrap.classList.toggle("show", !!job.video && show);
  $("#videoToggle").classList.toggle("on", !!job.video && show);
  setVideoHeight(prefs.videoH || 240, false);
  $("#vidPip").hidden = !document.pictureInPictureEnabled;
  if (job.video) { vid.src = apiUrl(`/api/jobs/${job.id}/video`); vid.addEventListener("loadedmetadata", () => { vid.currentTime = offset; }, {once:true}); }
  else { vid.removeAttribute("src"); vid.load(); }
}
vid.addEventListener("error", () => {
  if (!current?.video || !vid.getAttribute("src")) return;
  vwrap.classList.remove("show"); $("#videoToggle").hidden = true;
  toast("This browser can't play the video for this track; the audio still works.", {type:"err"});
});
$("#videoToggle").onclick = () => showVideo(!vwrap.classList.contains("show"));
$("#vidHide").onclick = () => showVideo(false);
// Real fullscreen where the browser allows it; otherwise (or if it doesn't answer) the video fills the window.
function setFsLook(on) {
  vwrap.classList.toggle("fs", on);
  $("#vidFull").title = on ? "Exit fullscreen (F or Esc)" : "Fullscreen (F)";
  requestAnimationFrame(drawAll);
}
function fillWindow(on) { vwrap.classList.toggle("pseudo", on); setFsLook(on); }
function toggleFullscreen() {
  if (!current?.video) return;
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (vwrap.classList.contains("pseudo")) { fillWindow(false); return; }
  if (!vwrap.classList.contains("show")) showVideo(true);
  if (!document.fullscreenEnabled || !vwrap.requestFullscreen) { fillWindow(true); return; }
  let settled = false;
  vwrap.requestFullscreen().then(() => { settled = true; }, () => { settled = true; fillWindow(true); });
  setTimeout(() => { if (!settled && !document.fullscreenElement) fillWindow(true); }, 700);
}
$("#vidFull").onclick = toggleFullscreen;
vid.addEventListener("dblclick", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) vwrap.classList.remove("pseudo");   // leaving real fullscreen leaves both modes
  setFsLook(document.fullscreenElement === vwrap || vwrap.classList.contains("pseudo"));
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && vwrap.classList.contains("pseudo")) { e.preventDefault(); fillWindow(false); } });
$("#vidPip").onclick = async () => {
  try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await vid.requestPictureInPicture(); }
  catch { toast("Picture-in-picture isn't available for this video.", {type:"err"}); }
};
// in fullscreen the controls show while the mouse moves, then fade away
let awakeTimer;
vwrap.addEventListener("pointermove", () => {
  if (!vwrap.classList.contains("fs")) return;
  vwrap.classList.add("awake"); clearTimeout(awakeTimer);
  awakeTimer = setTimeout(() => vwrap.classList.remove("awake"), 2200);
});
// the fullscreen bar has its own play button and clock
$("#fsPlay").onclick = () => toggle();
// drag the grip to resize; double-click it to reset
$("#vidGrip").addEventListener("pointerdown", e => {
  e.preventDefault();
  const grip = e.currentTarget, y0 = e.clientY, h0 = vwrap.getBoundingClientRect().height;
  grip.setPointerCapture(e.pointerId); vwrap.classList.add("resizing");
  const move = ev => setVideoHeight(h0 + ev.clientY - y0, false);
  const up = () => { grip.removeEventListener("pointermove", move); vwrap.classList.remove("resizing"); setVideoHeight(vwrap.getBoundingClientRect().height); };
  grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up, {once:true}); grip.addEventListener("pointercancel", up, {once:true});
});
$("#vidGrip").addEventListener("dblclick", () => setVideoHeight(240));
$("#vidGrip").addEventListener("keydown", e => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setVideoHeight(vwrap.getBoundingClientRect().height + (e.key === "ArrowUp" ? -20 : 20)); }
});
addEventListener("resize", () => { if (vwrap.classList.contains("show")) setVideoHeight(prefs.videoH || 240, false); });
for (const [label, list] of PRESETS) {
  const b = document.createElement("button"); b.textContent = label; b.dataset.stems = list.slice().sort().join();
  b.title = `Mute ${label}`;
  b.onclick = () => {
    const isOn = b.classList.contains("on");
    stems.forEach(s => { s.solo = false; s.mute = isOn ? false : list.includes(s.name); }); applyGains();
  };
  $("#presets").appendChild(b);
}
const reset = document.createElement("button"); reset.textContent = "Full mix"; reset.title = "Unmute everything";
reset.onclick = () => { stems.forEach(s => { s.mute = s.solo = false; }); applyGains(); };
$("#presets").appendChild(reset);
