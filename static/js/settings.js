"use strict";
// The Settings dialog: microphone, recording timing, metronome, count-in.

async function fillMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
    $("#micSel").innerHTML = `<option value="">Default microphone</option>` +
      devs.filter(d => d.deviceId && d.deviceId !== "default").map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || "Microphone")}</option>`).join("");
    $("#micSel").value = prefs.mic;
  } catch {}
}
$("#settingsBtn").onclick = async () => {
  await fillMics();
  $("#instSel").value = prefs.instrument || "none"; $("#latMode").value = prefs.latMode; $("#latMs").value = prefs.latMs; $("#clickVol").value = prefs.clickVol; $("#countBars").value = prefs.countBars;
  $("#latManualRow").style.display = prefs.latMode === "manual" ? "" : "none";
  $("#latInfo").textContent = ctx ? `Automatic estimate: ${Math.round(autoLatency() * 1000)} ms` : "";
  $("#settings").showModal();
};
$("#micSel").onchange = e => { prefs.mic = e.target.value; savePrefs(); micStream?.getTracks().forEach(t => t.stop()); micStream = null; };
$("#latMode").onchange = e => { prefs.latMode = e.target.value; savePrefs(); $("#latManualRow").style.display = prefs.latMode === "manual" ? "" : "none"; };
$("#latMs").onchange = e => { prefs.latMs = clamp(+e.target.value || 0, 0, 500); savePrefs(); };
$("#clickVol").oninput = e => { prefs.clickVol = +e.target.value; savePrefs(); if (clickBus) clickBus.gain.value = prefs.clickVol; };
$("#countBars").onchange = e => { prefs.countBars = +e.target.value; savePrefs(); };
