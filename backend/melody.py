"""The notes the horn plays: pitch-tracks the separated sax / brass part and turns it into notes.

YIN (de Cheveigné & Kawahara, 2002), vectorised with FFTs so a 10-minute song takes a few seconds: for every
11.6 ms frame, the lag where the signal best matches a delayed copy of itself is the period. Frames that are
quiet or not clearly pitched (breath, keys, bleed from other parts) are dropped; steady runs of the same pitch
become notes. One line at a time — in a section soli it follows the loudest horn.
"""
from __future__ import annotations

from pathlib import Path

MELODY_VERSION = 1
FRAME, HOP = 2048, 256          # at 22050 Hz: 93 ms window, 11.6 ms step
FMIN, FMAX = 64.0, 1600.0       # bari low A (concert C2, 65 Hz) to above alto altissimo; lower is bass bleed
THRESH = 0.18                   # YIN: how clearly pitched a frame must be (lower = stricter)
MIN_NOTE = 0.07                 # seconds


def _track(x, sr):
    """Per frame: frequency (0 = unpitched) and loudness."""
    import numpy as np

    n = 1 + max(0, (len(x) - FRAME) // HOP)
    lo, hi = int(sr / FMAX), int(np.ceil(sr / FMIN))
    freqs, rms = np.zeros(n, np.float32), np.zeros(n, np.float32)
    idx = np.arange(FRAME)[None, :]
    for s in range(0, n, 2048):
        starts = np.arange(s, min(n, s + 2048)) * HOP
        fr = x[starts[:, None] + idx].astype(np.float64)
        fr -= fr.mean(axis=1, keepdims=True)
        W = FRAME // 2  # integration window; lags up to FRAME - W
        spec = np.fft.rfft(fr, 2 * FRAME)
        acf = np.fft.irfft(spec[:, :] * np.conj(np.fft.rfft(fr[:, :W], 2 * FRAME)), 2 * FRAME)[:, :hi + 2]
        sq = np.cumsum(np.pad(fr ** 2, ((0, 0), (1, 0))), axis=1)
        taus = np.arange(hi + 2)
        e0 = sq[:, W][:, None]
        et = sq[:, W + taus] - sq[:, taus]
        d = e0 + et - 2 * acf                                  # difference function
        d[:, 0] = 0
        cm = d[:, 1:] * np.arange(1, hi + 2) / np.maximum(np.cumsum(d[:, 1:], axis=1), 1e-12)
        cm = np.hstack([np.ones((len(cm), 1)), cm])           # cumulative mean normalised difference
        rms[s:s + len(fr)] = np.sqrt(sq[:, -1] / FRAME)
        for i in range(len(cm)):
            row = cm[i]
            below = np.nonzero(row[lo:hi] < THRESH)[0]
            if not len(below):
                continue
            t = lo + below[0]
            while t + 1 < hi and row[t + 1] < row[t]:           # walk down to the dip
                t += 1
            a, b, c = row[t - 1], row[t], row[t + 1]
            den = a - 2 * b + c
            shift = 0.5 * (a - c) / den if den > 1e-9 else 0.0
            freqs[s + i] = sr / (t + shift)
    return freqs, rms


def _notes(freqs, rms, sr):
    import numpy as np

    loud = np.percentile(rms[rms > 0], 95) if np.any(rms > 0) else 0
    voiced = (freqs > 0) & (rms > loud * 10 ** (-32 / 20))
    midi = np.where(voiced, 69 + 12 * np.log2(np.maximum(freqs, 1) / 440.0), np.nan)
    step = HOP / sr
    notes, start, run = [], None, []

    def close(end):
        if start is not None and (end - start) * step >= MIN_NOTE:
            m = float(np.median(run))
            notes.append([round(start * step + FRAME / sr / 4, 3), round(end * step + FRAME / sr / 4, 3), int(round(m))])

    for i, m in enumerate(midi):
        if np.isnan(m) or (run and abs(m - np.median(run[-8:])) > 0.6):
            close(i)
            start, run = (None, []) if np.isnan(m) else (i, [m])
        else:
            if start is None:
                start = i
            run.append(m)
    close(len(midi))
    # one-frame octave slips and repeated attacks of the same pitch a hair apart become one note
    merged = []
    for n in notes:
        if merged and n[2] == merged[-1][2] and n[0] - merged[-1][1] < 0.035:
            merged[-1][1] = n[1]
        else:
            merged.append(n)
    return merged


def analyze_melody(jdir: Path, silent: bool = False) -> dict:
    """{"v", "notes": [[start, end, midi], ...]} for the sax / brass part (empty if that part is silent)."""
    from .analysis import ANALYSIS_SR, _load_parts

    winds = None if silent else _load_parts(jdir).get("winds")
    if winds is None or len(winds) < FRAME:
        return {"v": MELODY_VERSION, "notes": []}
    freqs, rms = _track(winds, ANALYSIS_SR)
    return {"v": MELODY_VERSION, "notes": _notes(freqs, rms, ANALYSIS_SR)}
