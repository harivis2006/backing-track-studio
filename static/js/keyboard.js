"use strict";
// Keyboard shortcuts (press ? in the app for the list).

document.addEventListener("keydown", e => {
  if (document.querySelector("dialog[open]")) { if (e.key === "?") document.querySelector("dialog[open]").close(); return; }
  const tag = e.target.tagName;
  if (tag === "INPUT" && !["range", "checkbox"].includes(e.target.type) || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "?") { $("#help").showModal(); e.preventDefault(); return; }
  if (!current || !stems.length) return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); toggle(); }
  else if (k === "ArrowLeft" || k === "ArrowRight") {
    if (tag === "INPUT" && e.target.type === "range") return;
    e.preventDefault();
    const dir = k === "ArrowLeft" ? -1 : 1;
    if (beats) seek(barLine(curPos(), dir * (e.shiftKey ? 4 : 1)));
    else seek(curPos() + dir * (e.shiftKey ? 15 : 5));
  }
  else if (k === "Home" || k === "0") { e.preventDefault(); seek(loopOn() ? loopA : 0); }
  else if (/^Digit[1-7]$/.test(e.code)) {
    const s = stems[+e.code.slice(5) - 1]; if (!s || s.empty) return;
    e.preventDefault(); if (e.shiftKey) s.solo = !s.solo; else s.mute = !s.mute; applyGains();
  }
  else if (k === "r" || k === "R") { e.preventDefault(); $("#rec").click(); }
  else if (k === "l" || k === "L") { if (loopA !== null) { $("#loop").checked = !$("#loop").checked; $("#loop").onchange(); } }
  else if ((k === "c" || k === "C") && beats) $("#countInBtn").click();
  else if ((k === "k" || k === "K") && beats) $("#metroBtn").click();
  else if (k === "[") stepSpeed(-1);
  else if (k === "]") stepSpeed(1);
  else if (k === "-" || k === "_") stepKey(-1);
  else if (k === "=" || k === "+") stepKey(1);
  else if ((k === "v" || k === "V") && current.video && !$("#videoToggle").hidden) $("#videoToggle").click();
  else if ((k === "f" || k === "F") && current.video && !$("#videoToggle").hidden) toggleFullscreen();
  else if (k === "m" || k === "M") addMarker();
  else if (k === "a" || k === "A") setAB(!abSaved);
  else if (k === "e" || k === "E") { e.preventDefault(); openExport(); }
  else if (k === "," || k === "<") jumpMarker(-1);
  else if (k === "." || k === ">") jumpMarker(1);
  else if (k === "Z" && e.shiftKey) setView(0, duration);
  else if (k === "z") { if (loopA !== null) { const pad = (loopB - loopA) * 0.15; setView(loopA - pad, loopB + pad); } else zoomBy(0.5, curPos()); }
});
