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
function setupVideo(job, show) {
  $("#videoToggle").hidden = !job.video;
  $("#videoWrap").classList.toggle("show", !!job.video && show);
  $("#videoToggle").classList.toggle("on", !!job.video && show);
  vid.classList.toggle("large", prefs.videoLarge === true);
  if (job.video) { vid.src = apiUrl(`/api/jobs/${job.id}/video`); vid.addEventListener("loadedmetadata", () => { vid.currentTime = offset; }, {once:true}); }
  else { vid.removeAttribute("src"); vid.load(); }
}
vid.addEventListener("error", () => {
  if (!current?.video || !vid.getAttribute("src")) return;
  $("#videoWrap").classList.remove("show"); $("#videoToggle").hidden = true;
  toast("This browser can't play the video for this track; the audio still works.", {type:"err"});
});
$("#videoToggle").onclick = () => {
  const shown = $("#videoWrap").classList.contains("show"), large = vid.classList.contains("large");
  const show = !shown || !large;              // hidden -> small -> large -> hidden
  prefs.videoLarge = shown && !large; savePrefs();
  vid.classList.toggle("large", prefs.videoLarge);
  $("#videoWrap").classList.toggle("show", show); $("#videoToggle").classList.toggle("on", show);
  saveState(); requestAnimationFrame(drawAll);
};
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
