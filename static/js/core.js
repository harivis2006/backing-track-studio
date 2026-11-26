"use strict";
// Shared basics: part names, small helpers, notifications (toasts), API calls, saved preferences.

const STEM_INFO = {
  vocals:{label:"Vocals", desc:"Lead & backing voices"},
  winds: {label:"Sax / Brass", desc:"Saxophone, trumpet, trombone, flute, clarinet"},
  guitar:{label:"Guitar", desc:"Electric & acoustic guitar"},
  piano: {label:"Piano / Keys", desc:"Piano, keys"},
  other: {label:"Other", desc:"Strings, synths, pads, percussion FX…"},
  bass:  {label:"Bass", desc:"Bass guitar, upright, synth bass"},
  drums: {label:"Drums", desc:"Kit & percussion"},
};
const PRESETS = [["sax / brass",["winds"]],["vocals",["vocals"]],["guitar",["guitar"]],["piano",["piano"]],["bass",["bass"]],["drums",["drums"]]];
const SPEEDS = [0.5,0.55,0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95,1,1.05,1.1,1.15,1.2];
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|wma|mp4|m4v|mov|mkv|webm|avi)$/i;

const $ = s => document.querySelector(s);
const fmt = t => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t/60)}:${String(t%60).padStart(2,"0")}`; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function toast(msg, {type="", action, actionLabel, ms=5000} = {}) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(actionLabel)}</button>` : ""}<button aria-label="Dismiss">✕</button>`;
  const close = () => el.remove();
  const [a, x] = el.querySelectorAll("button");
  if (action) a.onclick = () => { action(); close(); };
  (action ? x : a).onclick = close;
  $("#toasts").appendChild(el);
  while ($("#toasts").children.length > 4) $("#toasts").firstChild.remove();
  if (ms) setTimeout(close, ms);
}
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : msg; } catch {}
    throw new Error(msg);
  }
  return r;
}
const store = {
  get(id) { try { return JSON.parse(localStorage.getItem("bts:" + id)) || {}; } catch { return {}; } },
  set(id, v) { try { localStorage.setItem("bts:" + id, JSON.stringify(v)); } catch {} },
};
const prefs = Object.assign({mic:"", latMode:"auto", latMs:40, clickVol:0.6, countBars:1, countIn:false, metro:false, inst:0}, store.get("prefs"));
const NOTE_NAMES = ["C","D♭","D","E♭","E","F","G♭","G","A♭","A","B♭","B"];
let songKey = null;
const savePrefs = () => store.set("prefs", prefs);
