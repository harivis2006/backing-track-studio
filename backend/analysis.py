"""Everything the player needs to know about a song besides the audio, saved as peaks.json:

    stems:  per part, a waveform overview + loudness (quiet parts are marked "not in this song")
    beats:  beat times, bar starts and tempo — for the ruler, loops, count-in and metronome
    key:    the overall key (shown written for your instrument)

Older songs are brought up to date automatically (see ensure_analysis / BEATS_VERSION).
"""

import json
import threading
import traceback
from pathlib import Path

from . import jobs
from .config import PEAK_COLUMNS, SILENT_DB, STEMS
from .util import atomic_write_json

BEATS_VERSION = 4  # bump to re-analyse every song's beats after improving the algorithm

_beat_model = None
_beat_lock = threading.Lock()
_song_locks: dict[str, threading.Lock] = {}


def _read_parts(jdir: Path, names, mono=False):
    import soundfile as sf

    parts = []
    for name in names:
        p = jdir / "stems" / f"{name}.flac"
        if p.exists():
            x = sf.read(p, dtype="float32")[0]
            parts.append(x.mean(axis=1) if mono else x)
    if not parts:
        return None
    n = min(len(x) for x in parts)  # parts can differ in length by a few samples
    return sum(x[:n] for x in parts)


# ---------------------------------------------------------------- waveforms
def compute_peaks(jdir: Path) -> dict:
    """Build peaks.json from scratch: waveforms + loudness per part, then beats and key."""
    import numpy as np
    import soundfile as sf

    out = {"columns": PEAK_COLUMNS, "stems": {}}
    for name in STEMS:
        p = jdir / "stems" / f"{name}.flac"
        if not p.exists():
            continue
        x, sr = sf.read(p, dtype="float32")
        loudest = np.abs(x).max(axis=1) if x.ndim == 2 else np.abs(x)
        n = len(loudest)
        out["duration"] = n / sr
        edges = np.linspace(0, n, PEAK_COLUMNS + 1).astype(int)
        peaks = np.maximum.reduceat(loudest, edges[:-1]) if n >= PEAK_COLUMNS else np.zeros(PEAK_COLUMNS)
        db = 20 * np.log10(float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) + 1e-12)
        out["stems"][name] = {"peaks": [int(v) for v in np.clip(peaks * 255, 0, 255)],
                              "db": round(db, 1), "silent": bool(db < SILENT_DB)}
    for field, analyse in (("beats", analyze_beats), ("key", analyze_key)):
        out[field] = _safely(analyse, jdir)
    atomic_write_json(jdir / "peaks.json", out)
    return out


def _safely(fn, jdir):
    try:
        return fn(jdir)
    except Exception:  # noqa: BLE001 — analysis is a nice-to-have; never fail a song over it
        traceback.print_exc()
        return None


# ---------------------------------------------------------------- beats & bars
def beat_tracker():
    """Beat This! (CPJKU, 2024): a transformer that finds beats and bar starts. Loaded once."""
    global _beat_model
    if _beat_model is None:
        import torch
        from beat_this.inference import Audio2Beats

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        _beat_model = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)
    return _beat_model


def analyze_beats(jdir: Path) -> dict:
    import numpy as np

    mix = _read_parts(jdir, STEMS)
    if mix is None:
        return {"v": BEATS_VERSION, "times": []}
    with _beat_lock:
        beats, downbeats = beat_tracker()(mix, 44100)
    cleaned = clean_beats(beats, downbeats)
    if cleaned is None:  # no steady beat (e.g. free time) — remembered, so we don't re-analyse every open
        return {"v": BEATS_VERSION, "times": []}
    times, bar_starts, per_bar = cleaned
    return {"v": BEATS_VERSION, "tempo": round(60 / float(np.median(np.diff(times))), 1),
            "times": [round(float(t), 4) for t in times], "downbeats": bar_starts, "perBar": per_bar}


def clean_beats(beats, downbeats):
    """Turn the tracker's raw output into a grid good enough for a metronome.

    1. Keep one consistent beat level: drop stray extra beats, fill in missed ones. Trackers sometimes
       drop to half speed for a section (e.g. a half-time drum feel); we hold the song's main pulse.
    2. Smooth away the tracker's 20 ms frame jitter while still following real tempo drift.
    3. Make bar starts regular (every `per_bar` beats), only accepting a shift the next bars confirm.

    Returns (beat times, bar-start beat indices, beats per bar), or None if there's no usable beat.
    """
    import numpy as np

    b = np.asarray(beats, dtype=float)
    if len(b) < 8:
        return None
    gaps = np.diff(b)
    song_gap = float(np.median(gaps))

    def expected_gap(t):
        i = int(np.searchsorted(b, t))
        nearby = gaps[max(0, i - 8): i + 8]
        g = float(np.median(nearby)) if len(nearby) else song_gap
        ratio = g / song_gap
        if 1.6 <= ratio <= 2.5:      # tracker went to half speed here
            g /= 2
        elif 0.38 <= ratio <= 0.62:  # ...or double speed
            g *= 2
        return g

    # 1. one beat level
    kept = [b[0]]
    for t in b[1:]:
        g, d = expected_gap(t), t - kept[-1]
        if d < 0.6 * g:  # extra beat squeezed in: keep whichever lands closer to where a beat should be
            if len(kept) >= 2 and abs(t - (kept[-2] + g)) < abs(kept[-1] - (kept[-2] + g)):
                kept[-1] = t
            continue
        k = int(round(d / g))
        if k >= 2 and abs(d / k - g) < 0.25 * g:  # missed beats: fill them in evenly
            kept.extend(kept[-1] + d / k * j for j in range(1, k))
        kept.append(t)
    b = np.array(kept)

    # 2. smooth: each beat = straight-line fit through its 7 neighbours (beat number vs time)
    n, smooth = len(b), b.copy()
    for i in range(n):
        lo, hi = max(0, i - 3), min(n, i + 4)
        if hi - lo >= 4:
            slope, intercept = np.polyfit(np.arange(lo, hi), b[lo:hi], 1)
            smooth[i] = slope * i + intercept
    for i in range(1, n):  # keep strictly increasing
        smooth[i] = max(smooth[i], smooth[i - 1] + 1e-3)

    # 3. regular bars
    beat_len = float(np.median(np.diff(smooth)))
    starts = sorted({int(np.argmin(np.abs(smooth - d))) for d in downbeats
                     if np.min(np.abs(smooth - d)) < 0.35 * beat_len})
    per_bar = 4
    if len(starts) >= 4:
        lengths, counts = np.unique(np.diff(starts), return_counts=True)
        common = int(lengths[np.argmax(counts)])
        if common in (2, 3, 4, 6):
            per_bar = common
    regular = []
    for k, s in enumerate(starts):
        if not regular or (s - regular[-1]) % per_bar == 0:
            regular.append(s)
            continue
        following = starts[k + 1:k + 3]  # accept an out-of-pattern bar start only if the next two agree
        if len(following) == 2 and all((x - s) % per_bar == 0 for x in following) and s - regular[-1] >= 2:
            regular.append(s)
    bar_starts = []
    for a, nxt in zip(regular, regular[1:] + [None]):
        bar_starts.append(a)
        if nxt is not None:  # fill in skipped bar starts (an odd remainder becomes a short bar)
            bar_starts.extend(range(a + per_bar, nxt - 1, per_bar))
    if bar_starts:
        bar_starts.extend(range(bar_starts[-1] + per_bar, n, per_bar))
    else:
        bar_starts = list(range(0, n, per_bar))
    return smooth, bar_starts, per_bar


# ---------------------------------------------------------------- key
def analyze_key(jdir: Path) -> dict | None:
    """Overall key via Krumhansl-Schmuckler profiles on the pitched parts. A major key and its relative
    minor share the same notes, so we return the major tonic plus which of the two fitted better."""
    import librosa
    import numpy as np
    from scipy.signal import resample_poly

    mix = _read_parts(jdir, ("bass", "piano", "guitar", "other", "winds", "vocals"), mono=True)
    if mix is None:
        return None
    y = resample_poly(mix, 1, 4).astype(np.float32)
    chroma = librosa.feature.chroma_cqt(y=y, sr=11025, hop_length=1024, bins_per_octave=36).sum(axis=1)
    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    fits = [(float(np.corrcoef(np.roll(profile, r), chroma)[0, 1]), r, mode)
            for profile, mode in ((major, "major"), (minor, "minor")) for r in range(12)]
    score, tonic, mode = max(fits)
    return {"major": tonic if mode == "major" else (tonic + 3) % 12, "prefer": mode, "confidence": round(score, 2)}


# ---------------------------------------------------------------- keeping it up to date
def ensure_analysis(job_id: str) -> dict:
    """Return peaks.json, (re)computing anything missing or made by an older version of the analysis."""
    jdir = jobs.job_dir(job_id)
    with _song_locks.setdefault(job_id, threading.Lock()):
        path = jdir / "peaks.json"
        data = json.loads(path.read_text()) if path.exists() else compute_peaks(jdir)
        stale = [(field, fn) for field, fn in (("beats", analyze_beats), ("key", analyze_key))
                 if field not in data or (field == "beats" and (data.get("beats") or {}).get("v") != BEATS_VERSION)]
        if stale:
            for field, fn in stale:
                data[field] = _safely(fn, jdir)
            atomic_write_json(path, data)
        job = jobs.jobs.get(job_id)
        if job and not job.get("duration") and data.get("duration"):
            jobs.update(job_id, duration=round(data["duration"], 2))
        return data


def backfill_all(wait_for: threading.Event) -> None:
    """At start-up (once the models are loaded), update older songs in the background so they open instantly."""
    wait_for.wait()
    for job_id, job in list(jobs.jobs.items()):
        if job.get("status") == "done" and job_id in jobs.jobs:
            try:
                ensure_analysis(job_id)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
