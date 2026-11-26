"""Building downloads. The page renders your mix itself (so it's exactly what you hear) and sends us a WAV;
we turn that into an MP3 / M4A or put it on the video. "Parts" zips every part (and your takes) as WAVs.

Work happens in data/<id>/exports/, which is cleared at start-up in case a download was interrupted.
"""

import io
import uuid
import zipfile
from math import gcd
from pathlib import Path

from . import takes
from .config import STEMS
from .jobs import job_dir
from .util import ffmpeg, safe_filename


def scratch(job_id: str, suffix: str) -> Path:
    folder = job_dir(job_id) / "exports"
    folder.mkdir(exist_ok=True)
    return folder / f"{uuid.uuid4().hex[:6]}{suffix}"


def encode_audio(wav: Path, out: Path, fmt: str) -> None:
    codec = ["-c:a", "libmp3lame", "-b:a", "256k"] if fmt == "mp3" else \
            ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"]
    res = ffmpeg("-i", wav, *codec, out)
    if res.returncode != 0:
        raise RuntimeError(f"Couldn't encode: {res.stderr[-200:]}")


def video_with_mix(video: Path, wav: Path, out: Path, start: float, end: float | None, speed: float) -> None:
    """Replace the video's sound with `wav`. start/end are in original-song seconds; at speed != 1 the
    picture is re-timed so it stays in sync with the slowed/sped-up audio."""
    whole = start <= 0 and end is None
    args = [] if whole else ["-ss", start, "-t", (end or 1e9) - start]
    args += ["-i", video, "-i", wav]
    if whole and speed == 1.0:
        args += ["-c:v", "copy"]  # untouched picture: fast and lossless
    else:
        if speed != 1.0:
            args += ["-vf", f"setpts=PTS/{speed}"]
        args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]  # frame-accurate cut / re-timing
    res = ffmpeg(*args, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "256k",
                 "-shortest", "-movflags", "+faststart", out)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {res.stderr[-300:]}")


def parts_zip(job: dict, parts_folder: Path, silent: set[str], rate: float, semis: int, out: Path) -> str:
    """Zip each non-empty part plus matching takes as same-length, same-sample-rate WAVs that line up from
    0:00 in any DAW. Returns the download's file name."""
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    title = safe_filename(job["title"], 80, "track")
    tags = ([f"{round(rate * 100)}% speed"] if rate != 1 else []) + ([f"key {semis:+d}"] if semis else [])
    folder = title + (f" ({', '.join(tags)})" if tags else "")

    parts = [(i, name, parts_folder / f"{name}.flac") for i, name in enumerate(STEMS)
             if name not in silent and (parts_folder / f"{name}.flac").exists()]
    sr = sf.info(str(parts[0][2])).samplerate if parts else 44100
    length = max((sf.info(str(p)).frames for _, _, p in parts), default=0)

    def wav_bytes(x):
        buf = io.BytesIO()
        sf.write(buf, x, sr, format="WAV", subtype="PCM_16")
        return buf.getvalue()

    def fit(x):  # pad / trim to the common length
        if len(x) < length:
            x = np.concatenate([x, np.zeros((length - len(x),) + x.shape[1:], dtype=x.dtype)])
        return x[:length] if length else x

    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
        for i, name, p in parts:
            z.writestr(f"{folder}/{i + 1:02d} {name}.wav", wav_bytes(fit(sf.read(p, dtype="int16")[0])))
        for t in takes.read(job["id"]):
            if t["rate"] != rate or t["semis"] != semis:
                continue
            y, take_sr = sf.read(takes.audio_path(job["id"], t["id"]), dtype="float32")
            if take_sr != sr:  # takes may be recorded at another sample rate (e.g. 48 kHz)
                g = gcd(int(sr), int(take_sr))
                y = resample_poly(y, int(sr) // g, int(take_sr) // g, axis=0).astype(np.float32)
            lead = int(round(t["start"] * sr))
            y = y[-lead:] if lead < 0 else np.concatenate([np.zeros(lead, dtype=np.float32), y])
            z.writestr(f"{folder}/take - {safe_filename(t['name'], 80, 'take')}.wav", wav_bytes(fit(y)))
    return f"{folder} - parts.zip"
