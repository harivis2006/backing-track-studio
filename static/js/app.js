"use strict";
// Key display, zoom buttons, renaming and searching tracks, quitting — then start the app.

function updateKeyName() {
  const el = $("#keyName");
  if (!songKey) { el.textContent = ""; return; }
  const maj = (songKey.major + rateSemis + 120) % 12, min = (maj + 9) % 12;
  const pair = songKey.prefer === "minor" ? `${NOTE_NAMES[min]} minor / ${NOTE_NAMES[maj]} major` : `${NOTE_NAMES[maj]} major / ${NOTE_NAMES[min]} minor`;
  const inst = +prefs.inst;
  if (!inst) { el.innerHTML = `Key: <b>${pair}</b>`; return; }
  const wmaj = (maj + inst) % 12, wmin = (wmaj + 9) % 12;
  const wpair = songKey.prefer === "minor" ? `${NOTE_NAMES[wmin]} minor` : `${NOTE_NAMES[wmaj]} major`;
  el.innerHTML = `Key: ${pair} · <b>for you: ${wpair}</b>`;
}
$("#zoomIn").onclick = () => zoomBy(0.5, playing ? curPos() : (loopA ?? curPos()));
$("#zoomOut").onclick = () => zoomBy(2);
$("#zoomFit").onclick = () => setView(0, duration);
$("#addMarker").onclick = () => addMarker();

$("#title").ondblclick = async () => {
  if (!current) return;
  const t = prompt("Rename this track", current.title); if (!t || t.trim() === current.title) return;
  try {
    const j = await (await api(`/api/jobs/${current.id}`, {method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({title:t})})).json();
    current.title = j.title; $("#title").textContent = j.title; document.title = j.title + " · Backing Track Studio"; refresh();
  } catch (e) { toast(e.message, {type:"err"}); }
};
$("#title").title = "Double-click to rename";
$("#libSearch").oninput = () => renderLib();
$("#instSel").onchange = e => {
  const it = INSTRUMENTS.find(i => i.id === e.target.value) || INSTRUMENTS[0];
  prefs.instrument = it.id; prefs.inst = it.transpose; savePrefs(); updateKeyName();
  if (it.mute.length && current) toast(`New songs will open with ${it.mute.map(n => STEM_INFO[n].label).join(", ")} muted. Use the “${PRESETS.find(p => p[1][0] === it.mute[0])?.[0] || "Remove"}” button to do it on this song.`, {ms: 8000});
};
window.addEventListener("beforeunload", () => { saveState(); micStream?.getTracks().forEach(t => t.stop()); });
syncToggles();
refresh();
