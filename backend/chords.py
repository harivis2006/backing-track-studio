"""Chord changes: which chord is playing when, saved in peaks.json as "chords".

Model: BTC, "A Bi-Directional Transformer for Musical Chord Recognition" (Park et al., ISMIR 2019,
github.com/jayg996/BTC-ISMIR19, MIT licence). The large-vocabulary model knows 12 roots x 14 qualities
(triads, 6ths, 7ths, maj7, m7, dim7, m7b5, sus2, sus4...). Below is a trimmed, inference-only copy of its
network; the parameter names match the published weights, which are downloaded on first use.

We run it on the separated pitched parts (no drums), then line the chord changes up with the song's beats
so they read like a chord chart.
"""

import hashlib
import math
import threading
import urllib.request

from .config import MODELS, log

CHORDS_VERSION = 2  # bump to re-detect every song's chords after improving this
WEIGHTS = MODELS / "btc_model_large_voca.pt"
WEIGHTS_URL = ("https://github.com/jayg996/BTC-ISMIR19/raw/2682317be668032e6e4b269ded36adaa2ad57df0/"
               "test/btc_model_large_voca.pt")
WEIGHTS_SHA256 = "1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51"

QUALITIES = ["min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4"]
NO_CHORD = (168, 169)           # "X" (unknown) and "N" (no chord)
SR, HOP, BINS, PER_OCTAVE = 22050, 2048, 144, 24
STEPS, CHUNK_SECONDS = 108, 10.0  # the model reads 10-second windows of 108 frames
FRAME = CHUNK_SECONDS / STEPS
PITCHED = ("bass", "piano", "guitar", "other", "winds", "vocals")

_model = None
_lock = threading.Lock()


# ---------------------------------------------------------------- the network (inference only)
def _build_model():
    import numpy as np
    import torch
    from torch import nn

    class LayerNorm(nn.Module):
        def __init__(self, n, eps=1e-6):
            super().__init__()
            self.gamma, self.beta, self.eps = nn.Parameter(torch.ones(n)), nn.Parameter(torch.zeros(n)), eps

        def forward(self, x):
            return self.gamma * (x - x.mean(-1, keepdim=True)) / (x.std(-1, keepdim=True) + self.eps) + self.beta

    class Attention(nn.Module):
        def __init__(self, size, heads, mask):
            super().__init__()
            self.heads, self.scale, self.mask = heads, (size // heads) ** -0.5, mask
            self.query_linear, self.key_linear, self.value_linear, self.output_linear = (
                nn.Linear(size, size, bias=False) for _ in range(4))

        def split(self, x):
            b, n, d = x.shape
            return x.view(b, n, self.heads, d // self.heads).permute(0, 2, 1, 3)

        def forward(self, x):
            q, k, v = self.split(self.query_linear(x)) * self.scale, self.split(self.key_linear(x)), self.split(self.value_linear(x))
            logits = q @ k.transpose(-1, -2) + self.mask[:, :, :x.shape[1], :x.shape[1]]
            ctx = torch.softmax(logits, -1) @ v
            b, h, n, d = ctx.shape
            return self.output_linear(ctx.permute(0, 2, 1, 3).reshape(b, n, h * d))

    class Conv(nn.Module):
        def __init__(self, i, o):
            super().__init__()
            self.pad, self.conv = nn.ConstantPad1d((1, 1), 0), nn.Conv1d(i, o, kernel_size=3)

        def forward(self, x):
            return self.conv(self.pad(x.permute(0, 2, 1))).permute(0, 2, 1)

    class FeedForward(nn.Module):
        def __init__(self, size):
            super().__init__()
            self.layers = nn.ModuleList([Conv(size, size), Conv(size, size)])

        def forward(self, x):
            for layer in self.layers:
                x = torch.relu(layer(x))
            return x

    class Block(nn.Module):
        def __init__(self, size, heads, mask):
            super().__init__()
            self.multi_head_attention = Attention(size, heads, mask)
            self.positionwise_convolution = FeedForward(size)
            self.layer_norm_mha, self.layer_norm_ffn = LayerNorm(size), LayerNorm(size)

        def forward(self, x):
            x = x + self.multi_head_attention(self.layer_norm_mha(x))
            return x + self.positionwise_convolution(self.layer_norm_ffn(x))

    def future_mask(n):
        return torch.from_numpy(np.triu(np.full([n, n], -np.inf), 1)).float()[None, None]

    class BiLayer(nn.Module):
        def __init__(self, size, heads, n):
            super().__init__()
            self.attn_block = Block(size, heads, future_mask(n))                     # looks back
            self.backward_attn_block = Block(size, heads, future_mask(n).transpose(2, 3))  # looks ahead
            self.linear = nn.Linear(size * 2, size)

        def forward(self, x):
            return self.linear(torch.cat([self.attn_block(x), self.backward_attn_block(x)], dim=2))

    def timing_signal(n, channels):
        scales = channels // 2
        inv = np.exp(np.arange(scales) * -(math.log(1e4) / (scales - 1)))
        t = np.arange(n)[:, None] * inv[None]
        return torch.from_numpy(np.concatenate([np.sin(t), np.cos(t)], axis=1)).float()[None]

    class Encoder(nn.Module):
        def __init__(self, features=BINS, size=128, layers=8, heads=4, n=STEPS):
            super().__init__()
            self.timing = timing_signal(n, size)
            self.embedding_proj = nn.Linear(features, size, bias=False)
            self.self_attn_layers = nn.Sequential(*[BiLayer(size, heads, n) for _ in range(layers)])
            self.layer_norm = LayerNorm(size)

        def forward(self, x):
            x = self.embedding_proj(x) + self.timing[:, :x.shape[1]]
            return self.layer_norm(self.self_attn_layers(x))

    class Output(nn.Module):
        def __init__(self, size=128, chords=170):
            super().__init__()
            self.output_projection = nn.Linear(size, chords)
            self.lstm = nn.LSTM(size, size // 2, batch_first=True, bidirectional=True)  # in the weights, unused here

        def forward(self, x):
            return self.output_projection(x)

    class BTC(nn.Module):
        def __init__(self):
            super().__init__()
            self.self_attn_layers, self.output_layer = Encoder(), Output()

        def forward(self, x):
            return self.output_layer(self.self_attn_layers(x))

    return BTC()


def _download_weights() -> None:
    if WEIGHTS.exists():
        return
    log.info("Downloading the chord model (12 MB)…")
    tmp = WEIGHTS.with_suffix(".part")
    with urllib.request.urlopen(WEIGHTS_URL, timeout=60) as r, open(tmp, "wb") as f:
        f.write(r.read())
    if hashlib.sha256(tmp.read_bytes()).hexdigest() != WEIGHTS_SHA256:
        tmp.unlink()
        raise RuntimeError("the chord model download was corrupted")
    tmp.rename(WEIGHTS)


def chord_model():
    """Load once. The file is read in safe mode: only tensors and plain numbers, never code."""
    global _model
    if _model is None:
        import numpy as np
        import torch
        from numpy._core.multiarray import scalar

        _download_weights()
        allowed = [(scalar, "numpy.core.multiarray.scalar"), np.dtype, type(np.dtype("float64"))]
        with torch.serialization.safe_globals(allowed):
            ck = torch.load(WEIGHTS, map_location="cpu", weights_only=True)
        model = _build_model()
        model.load_state_dict(ck["model"])
        _model = (model.eval(), float(ck["mean"]), float(ck["std"]))
    return _model


# ---------------------------------------------------------------- recognising chords
def frame_probabilities(mono, sr):
    """Chord probabilities for every ~0.09 s frame: (frames x 170)."""
    import librosa
    import numpy as np
    import torch
    from scipy.signal import resample_poly

    y = resample_poly(mono, SR, sr).astype(np.float32) if sr != SR else mono.astype(np.float32)
    chunk = int(SR * CHUNK_SECONDS)  # features are made per 10-second chunk, exactly as the model was trained
    cqt = [librosa.cqt(y[i:i + chunk], sr=SR, n_bins=BINS, bins_per_octave=PER_OCTAVE, hop_length=HOP)
           for i in range(0, len(y), chunk) if len(y[i:i + chunk]) > HOP]
    feats = np.log(np.abs(np.concatenate(cqt, axis=1)) + 1e-6).T
    model, mean, std = chord_model()
    n = len(feats)
    feats = np.pad((feats - mean) / std, ((0, -n % STEPS), (0, 0)))
    with _lock, torch.no_grad():
        logits = model(torch.from_numpy(feats.reshape(-1, STEPS, BINS)).float())
    return torch.log_softmax(logits, -1).reshape(-1, 170)[:n].numpy()


def label(idx: int):
    """Model class -> (root 0-11, quality), or (-1, "N") for no chord."""
    return (-1, "N") if idx in NO_CHORD else (idx // 14, QUALITIES[idx % 14])


def segments_on_beats(logp, beats):
    """One chord per beat (the frames in that beat vote), then tidy up: a lone one-beat chord between two
    beats of the same chord is usually a passing note, so it's absorbed if that chord is nearly as likely."""
    import numpy as np

    n = len(logp)
    edges = [0.0, *beats, n * FRAME]
    spans, picks, scores = [], [], []
    for a, b in zip(edges, edges[1:]):
        lo, hi = int(a / FRAME), max(int(a / FRAME) + 1, int(b / FRAME))
        if lo >= n or b - a < 0.05:
            continue
        s = logp[lo:min(hi, n)].mean(axis=0)  # average log-probability of each chord over this beat
        spans.append((a, b)); picks.append(int(np.argmax(s))); scores.append(s)
    for i in range(1, len(picks) - 1):
        nb = picks[i - 1]
        if nb == picks[i + 1] != picks[i] and scores[i][nb] > scores[i][picks[i]] - 1.0:  # within a factor of e
            picks[i] = nb
    root = lambda k: -1 if k in NO_CHORD else k // 14
    for i in range(len(picks)):  # a one-beat flicker to a close relative (Bmaj7 -> B6 -> Bmaj7) joins its neighbour
        before, after = picks[i - 1] if i else None, picks[i + 1] if i + 1 < len(picks) else None
        if picks[i] in (before, after):
            continue
        for nb in (before, after):
            if nb is not None and root(nb) == root(picks[i]) >= 0 and scores[i][nb] > scores[i][picks[i]] - 2.0:
                picks[i] = nb
                break
    return _merge(spans, picks)


def segments_free(logp):
    """No steady beat: smooth over ~0.5 s and drop flickers shorter than ~0.4 s."""
    import numpy as np
    from scipy.ndimage import uniform_filter1d

    picks = np.argmax(uniform_filter1d(logp, size=5, axis=0), axis=1).tolist()
    spans = [(i * FRAME, (i + 1) * FRAME) for i in range(len(picks))]
    segs = _merge(spans, picks)
    out = []
    for s in segs:
        if out and s["e"] - s["t"] < 0.4:
            out[-1]["e"] = s["e"]
        else:
            out.append(s)
    return _merge([(s["t"], s["e"]) for s in out], [s["i"] for s in out])


def _merge(spans, picks):
    segs = []
    for (a, b), p in zip(spans, picks):
        if segs and segs[-1]["i"] == p:
            segs[-1]["e"] = b
        else:
            segs.append({"t": a, "e": b, "i": p})
    return segs


def analyze_chords(jdir, beats: dict | None) -> dict:
    """The song's chord changes: {"v", "list": [[start, end, root, quality], ...]} (root -1 = no chord)."""
    from .analysis import _read_parts

    mix = _read_parts(jdir, PITCHED, mono=True)
    if mix is None:
        return {"v": CHORDS_VERSION, "list": []}
    logp = frame_probabilities(mix, 44100)
    times = (beats or {}).get("times") or []
    segs = segments_on_beats(logp, times) if len(times) >= 8 else segments_free(logp)
    out = []
    for s in segs:
        root, quality = label(s["i"])
        if out and out[-1][2] == root == -1:
            out[-1][1] = round(s["e"], 3)
            continue
        out.append([round(s["t"], 3), round(s["e"], 3), root, quality])
    return {"v": CHORDS_VERSION, "list": out}
