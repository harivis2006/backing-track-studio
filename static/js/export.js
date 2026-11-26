"use strict";
// Export: renders exactly what you hear (offline, faster than real time) to WAV, MP3, video or parts.

async function renderMix({section = loopOn(), countIn = false, withTakes = true} = {}) {
  const a = section ? loopA : 0, b = section ? loopB : duration;
  const sr = live()[0].buf.sampleRate, ba = a / rate, bb = b / rate;
  // Optional count-in: clicks on the song's own beat grid, leading into the first bar line of the export.
  let lead = 0, clicks = [];
  if (countIn && beats) {
    const i0 = Math.max(0, beats.times.findIndex(t => t >= a - 0.02));
    let d = i0; while (d < beats.times.length && !beats.isDown[d]) d++;
    if (d >= beats.times.length) d = i0;
    const g = localBeat(d), n = countBeats(), per = n / prefs.countBars;
    for (let j = 0; j < n; j++) clicks.push({song: beats.times[d] - (n - j) * g, accent: j % per === 0});
    lead = Math.max(0, (a - clicks[0].song) / rate) + 0.05;  // room before the song starts
  }
  const off = new OfflineAudioContext(2, Math.max(1, Math.ceil((lead + bb - ba) * sr)), sr);
  const m = off.createGain(); m.gain.value = +$("#master").value; m.connect(off.destination);
  for (const s of live()) {
    if (!audible(s) || s.vol === 0) continue;
    const src = off.createBufferSource(), g = off.createGain();
    src.buffer = s.buf; g.gain.value = s.vol; src.connect(g).connect(m); src.start(lead, ba, bb - ba);
  }
  for (const t of withTakes ? playableTakes() : []) {
    if (!audible(t) || t.vol === 0) continue;
    const x0 = Math.max(t.start, ba), x1 = Math.min(t.start + t.buf.duration, bb);
    if (x1 <= x0) continue;
    const src = off.createBufferSource(), g = off.createGain();
    src.buffer = t.buf; g.gain.value = t.vol; src.connect(g).connect(m); src.start(lead + x0 - ba, x0 - t.start, x1 - x0);
  }
  for (const c of clicks) {  // clicks are copied into this offline context's sample rate
    const src = off.createBufferSource(), g = off.createGain();
    src.buffer = clickBufs[c.accent ? 1 : 0]; g.gain.value = 0.8; src.connect(g).connect(off.destination);
    src.start(Math.max(0, lead + (c.song - a) / rate));
  }
  const out = await off.startRendering();
  let peak = 0;
  for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
  if (peak > 1) {
    const k = 0.98 / peak;
    for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
    toast(`Lowered the export volume by ${(20*Math.log10(peak/0.98)).toFixed(1)} dB so it doesn't distort.`);
  }
  const removed = stems.filter(s => !s.empty && !audible(s)).map(s => (STEM_INFO[s.name]?.label || s.name).split(" ")[0].toLowerCase());
  const withTake = withTakes && playableTakes().some(t => audible(t) && t.vol > 0);
  const practice = [rate !== 1 ? `${Math.round(rate*100)}% speed` : "", rateSemis ? `key ${rateSemis>0?"+":""}${rateSemis}` : ""].filter(Boolean).join(", ");
  const name = (`${current.title} - ${removed.length ? "no " + removed.join(", no ") : "full mix"}${withTake ? " + my take" : ""}`
              + (practice ? ` (${practice})` : "") + (section ? ` [${fmt(a)}-${fmt(b)}]` : "")).replace(/[\/\\:*?"<>|]/g, ".");
  return {wav: toWav(out), name: name + (clicks.length ? " (count-in)" : ""), section, a, b};
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), {href:url, download:filename}).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function busy(btn, label, fn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn(); } catch (e) { toast("Export failed: " + e.message, {type:"err"}); }
  finally { btn.disabled = false; btn.textContent = old; }
}
let exportFmt = localStorage.getItem("bts:exportFmt") || "mp3";
function openExport() {
  if (!current || !live().length) return;
  if (exportFmt === "mp4" && !current.video) exportFmt = "mp3";
  $("#fmtChoices [data-f=mp4]").disabled = !current.video;
  $("#exLoop").checked = loopOn(); $("#exLoopL").classList.toggle("dis", loopA === null); $("#exLoop").disabled = loopA === null;
  $("#exTakesL").style.display = playableTakes().length ? "" : "none";
  syncExportUI(); $("#exportDlg").showModal();
}
function syncExportUI() {
  document.querySelectorAll("#fmtChoices .choice").forEach(b => b.setAttribute("aria-checked", b.dataset.f === exportFmt));
  const noCount = !beats || exportFmt === "mp4" || exportFmt === "parts";
  $("#exCount").disabled = noCount; $("#exCountL").classList.toggle("dis", noCount);
  $("#exTakes").disabled = exportFmt === "parts"; $("#exTakesL").classList.toggle("dis", exportFmt === "parts");
  $("#exLoop").disabled = loopA === null || exportFmt === "parts"; $("#exLoopL").classList.toggle("dis", loopA === null || exportFmt === "parts");
  const removed = stems.filter(s => !s.empty && !audible(s)).map(s => STEM_INFO[s.name].label);
  const practice = [rate !== 1 ? `${Math.round(rate*100)}% speed` : "", rateSemis ? `key ${rateSemis>0?"+":""}${rateSemis}` : ""].filter(Boolean).join(", ");
  $("#exportSummary").textContent = exportFmt === "parts"
    ? `Every part as its own WAV file${practice ? ` (${practice})` : ""}, all the same length so they line up in a DAW.`
    : `What you hear now: ${removed.length ? "without " + removed.join(", ") : "the full mix"}${practice ? `, ${practice}` : ""}.`;
}
$("#fmtChoices").onclick = e => { const b = e.target.closest(".choice"); if (!b || b.disabled) return; exportFmt = b.dataset.f; localStorage.setItem("bts:exportFmt", exportFmt); syncExportUI(); };
$("#exportBtn").onclick = openExport;
$("#exportGo").onclick = () => {
  $("#exportDlg").close();
  if (exportFmt === "parts") {
    const q = new URLSearchParams({v: loadedVariant || "", rate, semis: rateSemis});
    toast("Preparing the parts… your download starts in a few seconds.", {ms: 6000});
    Object.assign(document.createElement("a"), {href: `/api/jobs/${current.id}/parts.zip?${q}`, download: ""}).click();
    return;
  }
  const opts = {section: $("#exLoop").checked && loopA !== null, countIn: $("#exCount").checked && !$("#exCount").disabled, withTakes: $("#exTakes").checked};
  busy($("#exportBtn"), exportFmt === "mp4" ? "Making video…" : "Rendering…", async () => {
    const r = await renderMix(opts);
    if (exportFmt === "wav") { download(r.wav, r.name + ".wav"); }
    else if (exportFmt === "mp3") {
      const res = await api(`/api/jobs/${current.id}/export-audio?${new URLSearchParams({format: "mp3", name: r.name})}`, {method:"POST", body:r.wav});
      download(await res.blob(), r.name + ".mp3");
    } else {
      const q = new URLSearchParams({name: r.name, speed: rate, ...(r.section ? {start: r.a, end: r.b} : {})});
      const res = await api(`/api/jobs/${current.id}/export-video?${q}`, {method:"POST", body:r.wav});
      download(await res.blob(), r.name + ".mp4");
    }
    toast(`Downloaded “${r.name}.${exportFmt}”`, {type:"ok"});
  });
};
function toWav(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const out = new ArrayBuffer(44 + len * ch * 2), view = new DataView(out);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + len * ch * 2, true); w(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, ch, true); view.setUint32(24, sr, true); view.setUint32(28, sr * ch * 2, true);
  view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true); w(36, "data"); view.setUint32(40, len * ch * 2, true);
  const pcm = new Int16Array(out, 44), chans = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  for (let i = 0, o = 0; i < len; i++) for (let c = 0; c < ch; c++, o++) {
    const v = chans[c][i]; pcm[o] = v >= 1 ? 32767 : v <= -1 ? -32768 : v < 0 ? v * 32768 : v * 32767;
  }
  return new Blob([out], {type:"audio/wav"});
}
