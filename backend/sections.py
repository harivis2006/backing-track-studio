"""The song's form: where each time through the tune (a "chorus") starts, so you can loop one with a click.

Works bar by bar on the beat grid. Each bar gets a harmony picture (chroma of the backing parts, relative to
the song's average) and a sound picture (MFCC of the whole mix). If the harmony repeats with a clear period —
the 32-bar AABA, the 12-bar blues, the 40-bar form under a jazz solo — the song is cut into choruses of that
length, starting where the harmony changes most (the top of the form). Otherwise it's cut wherever the music
before a bar line is most unlike the music after it, into plain numbered sections.
"""
from __future__ import annotations

from pathlib import Path

SECTIONS_VERSION = 1
MIN_BARS = 16          # shorter than this, there's no form to speak of
MIN_SECONDS = 8.0      # shortest section when cutting by change
KERNEL_SECONDS = 12.0  # how far either side of a bar line the change detector looks
PERIOD_CLEAR = 0.15    # how strongly the harmony must repeat (0 = not at all, 1 = identically) to call it a form


def _bar_grid(beats: dict | None, duration: float):
    times = (beats or {}).get("times") or []
    downs = (beats or {}).get("downbeats") or []
    starts = [times[d] for d in downs if 0 <= d < len(times)]
    if len(starts) < MIN_BARS:
        return None
    return starts + [min(duration, starts[-1] + (starts[-1] - starts[-2]))]


def _features(jdir: Path, edges, sr: int):
    """Per bar: harmony (12, centred on the song's average, unit length) and sound (13 MFCCs, standardised)."""
    import librosa
    import numpy as np

    from .analysis import _read_parts
    from .chords import harmony_mix
    from .config import STEMS

    harm, mix = harmony_mix(jdir), _read_parts(jdir, STEMS)
    if harm is None or mix is None:
        return None, None
    hop = 1024
    chroma = librosa.feature.chroma_cqt(y=harm, sr=sr, hop_length=hop, n_chroma=12)
    mfcc = librosa.feature.mfcc(y=mix, sr=sr, n_mfcc=14, hop_length=hop)[1:]
    last = min(chroma.shape[1], mfcc.shape[1]) - 1
    frames = np.maximum.accumulate(np.clip((np.asarray(edges) * sr / hop).astype(int), 0, last))

    def per_bar(f):
        return np.array([f[:, a:max(b, a + 1)].mean(axis=1) for a, b in zip(frames[:-1], frames[1:])], dtype=np.float64)

    unit = lambda x: x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)
    c = unit(per_bar(chroma))
    c = unit(c - c.mean(axis=0))
    m = per_bar(mfcc)
    m = unit((m - m.mean(axis=0)) / (m.std(axis=0) + 1e-9))
    return c, m


def _novelty(S, k):
    """How different the k bars after each bar line are from the k bars before it (0..1)."""
    import numpy as np

    n = len(S)
    g = np.exp(-0.5 * (np.linspace(-1, 1, 2 * k) / 0.6) ** 2)
    sign = np.sign(np.arange(2 * k) - k + 0.5)
    kern = np.outer(g, g) * np.outer(sign, sign)
    pad = np.pad(S, k, mode="edge")
    nov = np.array([float((pad[i:i + 2 * k, i:i + 2 * k] * kern).sum()) for i in range(n)])
    nov -= nov.min()
    return nov / (nov.max() + 1e-9)


def _period(sc):
    """The length of the repeating form in bars, and how clearly it repeats — or (None, 0)."""
    import numpy as np

    n = len(sc)
    best, strength = None, 0.0
    for p in range(8, n // 2 + 1):
        lags = [k * p for k in (1, 2, 3) if k * p < n - 4]
        v = float(np.mean([np.diag(sc, lag).mean() for lag in lags]))
        if v > strength * 1.08 or (best and p % best and v > strength):  # a multiple of the best has to beat it clearly
            best, strength = p, v
    return (best, strength) if best and strength >= PERIOD_CLEAR else (None, 0.0)


def _by_form(n, period, nov):
    """Cut into choruses of `period` bars, starting at the offset where the music changes most."""
    import numpy as np

    phase = max(range(period), key=lambda o: float(np.mean(nov[o::period])))
    cuts = list(range(phase, n, period))
    if cuts[0] < 2:          # a bar or so of pickup belongs to the first chorus
        cuts[0] = 0
    else:
        cuts.insert(0, 0)
    if n - cuts[-1] < 4 and len(cuts) > 1:  # a scrap at the end belongs to the last chorus
        cuts.pop()
    cuts.append(n)
    segs = list(zip(cuts[:-1], cuts[1:]))
    names, num = [], 0
    for i, (a, b) in enumerate(segs):
        full = b - a >= period * 0.75
        if not full and i == 0:
            names.append("Intro")
        elif not full and i == len(segs) - 1:
            names.append("Ending")
        else:
            num += 1
            names.append(f"Chorus {num}")
    return segs, names


def _by_change(n, nov, min_len, max_count):
    """Cut wherever the music changes most, preferring the song's 4-bar phrase grid."""
    import numpy as np

    peaks = [i for i in range(1, n - 1) if nov[i] >= nov[i - 1] and nov[i] >= nov[i + 1] and nov[i] > 0.3]
    grid = int(np.bincount([i % 4 for i in peaks] or [0], minlength=4).argmax())
    score = nov + np.array([0.12 if i % 4 == grid else 0.0 for i in range(n)])
    score[:min_len] = 0
    score[n - min_len + 1:] = 0
    floor = float(np.mean(nov) + 0.35 * np.std(nov)) + 0.06
    picked = []
    for i in np.argsort(-score):
        if score[i] < floor or len(picked) >= max_count:
            break
        if all(abs(int(i) - p) >= min_len for p in picked):
            picked.append(int(i))
    cuts = [0] + sorted(picked) + [n]
    segs = list(zip(cuts[:-1], cuts[1:]))
    return segs, [f"Section {i + 1}" for i in range(len(segs))]


def analyze_sections(jdir: Path, beats: dict | None, duration: float) -> dict:
    """{"v", "form": bars per chorus or None, "list": [[start, end, name], ...]} — empty if there's no beat grid."""
    import numpy as np

    from .analysis import ANALYSIS_SR

    empty = {"v": SECTIONS_VERSION, "form": None, "list": []}
    edges = _bar_grid(beats, duration)
    if not edges:
        return empty
    c, m = _features(jdir, edges, ANALYSIS_SR)
    if c is None:
        return empty
    pair = lambda x: np.hstack([x, np.vstack([x[1:], x[-1:]])]) / np.sqrt(2)  # each bar with the next: "the same two bars"
    sc = pair(c) @ pair(c).T
    n = len(sc)
    bar = (edges[-1] - edges[0]) / n
    k = int(np.clip(round(KERNEL_SECONDS / bar), 4, 16))
    period, _ = _period(sc)
    if period:
        segs, names = _by_form(n, period, _novelty(sc, k))
    else:
        both = 0.6 * sc + 0.4 * (m @ m.T)
        min_len = max(4, int(round(MIN_SECONDS / bar / 2)) * 2)
        segs, names = _by_change(n, _novelty(both, k), min_len, max(1, int(duration / 25)))
    out = [[round(edges[a], 3), round(edges[b], 3), name] for (a, b), name in zip(segs, names)]
    if out and out[0][0] > 4 and out[0][2] != "Intro":  # a count-in or intro before the first bar the beat tracker found
        out.insert(0, [0.0, out[0][0], "Intro"])
    if out:
        out[0][0] = 0.0  # the sections cover the whole song
    if out and duration - out[-1][1] > 4 and out[-1][2] != "Ending":
        out.append([out[-1][1], round(duration, 3), "Ending"])
    if out:
        out[-1][1] = round(max(duration, out[-1][1]), 3)
    return {"v": SECTIONS_VERSION, "form": period, "list": out}
