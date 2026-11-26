"use strict";
// Recording yourself over the backing track (mic capture via an AudioWorklet), and your saved takes.

let recording = false, micStream = null, recNode = null, micNode = null, recChunks = [], recFrom = 0, recWorkletReady = false;
const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(){super();this.buf=new Float32Array(4096);this.n=0;this.start=-1}
process(inp){const ch=inp[0]&&inp[0][0];if(!ch)return true;if(this.start<0)this.start=currentFrame;
for(let i=0;i<ch.length;i++){this.buf[this.n++]=ch[i];if(this.n===this.buf.length){this.port.postMessage({start:this.start,data:this.buf});this.buf=new Float32Array(4096);this.start=currentFrame+i+1;this.n=0}}return true}}
registerProcessor("cap",Cap)`;

async function getMic() {
  if (micStream && micStream.active) return micStream;
  const audio = {echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1};
  if (prefs.mic) audio.deviceId = {exact: prefs.mic};
  try { micStream = await navigator.mediaDevices.getUserMedia({audio}); }
  catch (e) {
    if (prefs.mic && e.name === "OverconstrainedError") { prefs.mic = ""; savePrefs(); return getMic(); }
    throw e;
  }
  return micStream;
}
function autoLatency() {  // round trip: sound leaving the speakers + sound arriving from the mic
  const track = micStream?.getAudioTracks()[0];
  const inLat = track?.getSettings?.().latency ?? 0.01;
  return (ctx.outputLatency || ctx.baseLatency || 0.01) + inLat;
}
const latency = () => prefs.latMode === "manual" ? prefs.latMs / 1000 : autoLatency();

async function startRecording() {
  if (!current || !live().length || recording) return;
  ensureCtx(); await ctx.resume();
  if (speed !== rate || semis !== rateSemis) { toast("Wait for the new speed/key to finish preparing, then record.", {type:"err"}); return; }
  try { await getMic(); }
  catch (e) { toast(e.name === "NotAllowedError" ? "Microphone access was blocked. Allow it in your browser's site settings, then try again." : `Couldn't open the microphone: ${e.message}`, {type:"err", ms:10000}); return; }
  if (!recWorkletReady) {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], {type:"text/javascript"})));
    recWorkletReady = true;
  }
  if (!localStorage.getItem("bts:recTip")) { toast("Tip: wear headphones so the backing track doesn't leak into your take.", {ms:9000}); localStorage.setItem("bts:recTip", 1); }
  if (loopOn()) { $("#loop").checked = false; updateLoopHint(); toast("Loop turned off while recording"); }
  const wasPlaying = playing, from = wasPlaying ? curPos() : offset;
  micNode = ctx.createMediaStreamSource(micStream);
  recNode = new AudioWorkletNode(ctx, "cap");
  const sink = ctx.createGain(); sink.gain.value = 0;   // keeps the worklet running without making sound
  micNode.connect(recNode).connect(sink).connect(ctx.destination);
  attachRecMeter();
  recChunks = [];
  recNode.port.onmessage = e => recChunks.push(e.data);
  recording = true;
  $("#rec").classList.add("on"); $("#rec").setAttribute("aria-label", "Stop recording");
  play(from, {countIn: !wasPlaying});  // count yourself in when starting from stopped
  recFrom = offset;  // play() may have moved the start to the beginning of the bar
  addRecordingRow();
}
async function stopRecording() {
  if (!recording) return;
  recording = false;
  $("#rec").classList.remove("on"); $("#rec").setAttribute("aria-label", "Record");
  const t0 = startedAt, from = recFrom, endCtx = ctx.currentTime, sr = ctx.sampleRate;
  await new Promise(r => setTimeout(r, 120));  // let the last chunk arrive
  detachRecMeter();
  try { micNode.disconnect(); recNode.disconnect(); recNode.port.onmessage = null; } catch {}
  offset = curPos(); stopAll(); playing = false; updatePlayBtn(); vid.pause();
  removeRecordingRow();
  // Keep only what was captured after the backing track started, shifted back by the round-trip latency.
  const startFrame = Math.round(t0 * sr), endFrame = Math.round(endCtx * sr), lat = latency();
  const total = Math.max(0, endFrame - startFrame);
  if (total < sr * 0.5) { toast("Take too short — nothing saved."); drawAll(); return; }
  const pcm = new Float32Array(total);
  for (const c of recChunks) {
    for (let i = 0; i < c.data.length; i++) { const f = c.start + i - startFrame; if (f >= 0 && f < total) pcm[f] = c.data[i]; }
  }
  recChunks = [];
  let peak = 0; for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  if (peak < 0.003) toast("That take is almost silent — check the microphone in ⚙︎ Settings.", {type:"err", ms:9000});
  const start = from / rate - lat;  // buffer time (at the current rate) where the take's first sample belongs
  try {
    const q = new URLSearchParams({start, rate, semis: rateSemis});
    const r = await api(`/api/jobs/${current.id}/takes?${q}`, {method:"POST", body: monoWav(pcm, sr)});
    const meta = await r.json();
    const buf = ctx.createBuffer(1, pcm.length, sr); buf.copyToChannel(pcm, 0);
    for (const t of takes) if (!t.mute) t.mute = true;  // newest take plays, older ones get muted
    addTake(meta, buf, true);
    toast(`Saved ${meta.name}. Press Space to hear it back.`, {type:"ok"});
    offset = from; drawAll(); updateTime();
  } catch (e) { toast(`Couldn't save the take: ${e.message}`, {type:"err"}); }
}
function monoWav(pcm, sr) {
  const out = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(out);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, pcm.length * 2, true);
  const d = new Int16Array(out, 44);
  for (let i = 0; i < pcm.length; i++) { const x = pcm[i]; d[i] = x >= 1 ? 32767 : x <= -1 ? -32768 : x < 0 ? x * 32768 : x * 32767; }
  return new Blob([out], {type:"audio/wav"});
}
$("#rec").onclick = () => recording ? stopRecording() : startRecording();
let recRow = null;
function addRecordingRow() {
  removeRecordingRow();
  recRow = document.createElement("div"); recRow.className = "row take recording";
  recRow.innerHTML = `<div class="ctl"><div class="sw" style="background:var(--rec)"></div><div class="nm"><b>Recording…</b><small>Press R or ● to stop</small></div></div><div class="wavewrap"></div>`;
  $("#takeRows").prepend(recRow); updateTakeHeader(true);
}
function removeRecordingRow() { recRow?.remove(); recRow = null; updateTakeHeader(); }

// --- takes (recorded parts)
function takePeaks(buf) {
  const d = buf.getChannelData(0), n = 2000, per = Math.max(1, Math.floor(d.length / n)), pk = new Uint8Array(n);
  for (let x = 0; x < n; x++) { let m = 0; for (let i = x * per, e = Math.min(d.length, i + per); i < e; i += 2) { const v = Math.abs(d[i]); if (v > m) m = v; } pk[x] = Math.min(255, m * 255); }
  return pk;
}
function addTake(meta, buf, fresh = false) {
  const st = store.get(current.id).takes?.[meta.id] || {};
  const row = document.createElement("div"); row.className = "row take";
  row.innerHTML = `<div class="ctl"><div class="sw" style="background:var(--take)"></div>
      <div class="nm"><b title="Double-click to rename"></b><small></small></div>
      <div class="tk"><button data-n="-1" title="Move earlier 10 ms (Shift: 1 ms)">◀</button><button data-n="1" title="Move later 10 ms (Shift: 1 ms)">▶</button><button data-del title="Delete take">✕</button></div>
      <button class="ms m" aria-pressed="false" title="Mute">M</button><button class="ms s" aria-pressed="false" title="Solo">S</button>
      <input type="range" min="0" max="1.5" step="0.01" value="1" aria-label="Take volume"></div>
    <div class="wavewrap"><canvas class="wave"></canvas></div>`;
  $("#takeRows").appendChild(row);
  const t = {isTake:true, id:meta.id, name:meta.name, start:meta.start, rate:meta.rate, semis:meta.semis, buf, row,
             mute: fresh ? false : !!st.mute, solo: !!st.solo, vol: st.vol ?? 1, color: css("--take"), peaks: takePeaks(buf),
             canvas: row.querySelector("canvas"), mBtn: row.querySelector(".m"), sBtn: row.querySelector(".s"), volEl: row.querySelector("input")};
  t.gain = ctx.createGain(); t.gain.gain.value = 0; t.gain.connect(master);
  t.volEl.value = t.vol;
  t.mBtn.onclick = () => { t.mute = !t.mute; applyGains(); };
  t.sBtn.onclick = () => { t.solo = !t.solo; applyGains(); };
  t.volEl.oninput = () => { t.vol = +t.volEl.value; applyGains(); };
  t.volEl.ondblclick = () => { t.vol = 1; t.volEl.value = 1; applyGains(); };
  row.querySelector(".nm b").ondblclick = async () => {
    const name = prompt("Name this take", t.name); if (!name) return;
    try { const r = await api(`/api/jobs/${current.id}/takes/${t.id}`, {method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name})}); t.name = (await r.json()).name; updateTakeRows(); }
    catch (e) { toast(e.message, {type:"err"}); }
  };
  row.querySelectorAll("[data-n]").forEach(b => b.onclick = e => nudgeTake(t, +b.dataset.n * (e.shiftKey ? 0.001 : 0.01)));
  row.querySelector("[data-del]").onclick = async () => {
    if (!confirm(`Delete “${t.name}”?`)) return;
    try { await api(`/api/jobs/${current.id}/takes/${t.id}`, {method:"DELETE"}); } catch (e) { return toast(e.message, {type:"err"}); }
    t.gain.disconnect(); row.remove(); takes = takes.filter(x => x !== t); updateTakeHeader(); applyGains();
    if (playing) play(curPos(), {countIn:false});
  };
  attachWaveMouse(t.canvas);
  takes.push(t); updateTakeRows(); updateTakeHeader(); applyGains();
  return t;
}
let nudgeTimer = null;
function nudgeTake(t, d) {
  t.start += d; updateTakeRows(); drawAll();
  if (playing) play(curPos(), {countIn:false});
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => api(`/api/jobs/${current.id}/takes/${t.id}`, {method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({start:t.start})}).catch(e => toast(e.message, {type:"err"})), 500);
}
function updateTakeRows() {
  for (const t of takes) {
    const ok = t.rate === rate && t.semis === rateSemis;
    t.row.classList.toggle("na", !ok);
    t.row.querySelector(".nm b").textContent = t.name;
    const where = `${fmt(t.start * t.rate)}–${fmt((t.start + t.buf.duration) * t.rate)}`;
    const at = [t.rate !== 1 ? `${Math.round(t.rate*100)}%` : "", t.semis ? `key ${t.semis>0?"+":""}${t.semis}` : ""].filter(Boolean).join(", ");
    t.row.querySelector(".nm small").textContent = ok ? `${where}${at ? " · " + at : ""}` : `Recorded at ${at || "normal speed & key"} — switch to hear it`;
  }
}
function updateTakeHeader(rec = false) {
  let h = $("#takeRows .takehead");
  const show = takes.length || rec || recRow;
  if (!show) { h?.remove(); return; }
  if (!h) { h = document.createElement("div"); h.className = "takehead"; $("#takeRows").prepend(h); }
  h.innerHTML = `Your takes <span class="hint" style="text-transform:none;letter-spacing:0">· ${takes.length} saved · ◀ ▶ fix timing</span>`;
  if (recRow) h.after(recRow);
}
async function loadTakes(token) {
  let list = [];
  try { list = await (await api(`/api/jobs/${current.id}/takes`)).json(); } catch { return; }
  for (const meta of list) {
    try {
      const buf = await ctx.decodeAudioData(await (await api(`/api/jobs/${current.id}/takes/${meta.id}`)).arrayBuffer());
      if (token !== loadToken) return;
      addTake(meta, buf);
    } catch {}
  }
}
