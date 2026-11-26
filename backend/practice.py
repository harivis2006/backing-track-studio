"""Practice versions: every part slowed down / sped up and/or transposed, using Rubber Band
(via Spotify's pedalboard library). Made on demand, cached in data/<id>/variants/<key>/."""

import os
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import jobs
from .analysis import ensure_analysis
from .config import MAX_PRACTICE_VERSIONS

_locks: dict[str, threading.Lock] = {}


def version_key(speed: float, semitones: int) -> str:
    return "" if speed == 1.0 and semitones == 0 else f"s{speed:.2f}_k{semitones:+d}"


def parts_dir(job_id: str, key: str) -> Path:
    """Folder holding a song's parts: the originals, or a practice version."""
    if not key:
        return jobs.job_dir(job_id) / "stems"
    if "/" in key or ".." in key:
        raise ValueError("bad version key")
    return jobs.job_dir(job_id) / "variants" / key


def make_version(job_id: str, speed: float, semitones: int) -> str:
    """Create (or reuse) a practice version and return its key ("" = the original)."""
    import numpy as np
    import pedalboard
    import soundfile as sf

    speed = round(min(1.5, max(0.5, speed)), 2)
    semitones = int(min(12, max(-12, semitones)))
    key = version_key(speed, semitones)
    if not key:
        return ""
    out = parts_dir(job_id, key)
    with _locks.setdefault(job_id, threading.Lock()):
        if (out / "done").exists():
            os.utime(out)  # mark as recently used
            return key
        silent = {name for name, s in ensure_analysis(job_id)["stems"].items() if s["silent"]}
        tmp = out.with_name(key + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)

        def stretch(name):
            x, sr = sf.read(jobs.job_dir(job_id) / "stems" / f"{name}.flac", dtype="float32")
            y = pedalboard.time_stretch(np.ascontiguousarray(x.T), sr, stretch_factor=speed,
                                        pitch_shift_in_semitones=semitones, high_quality=True)
            sf.write(tmp / f"{name}.flac", y.T.clip(-1, 1), sr, subtype="PCM_16")

        todo = [s for s in jobs.jobs[job_id]["stems"] if s not in silent]
        with ThreadPoolExecutor(max_workers=min(8, len(todo) or 1)) as pool:  # one part per core
            list(pool.map(stretch, todo))
        (tmp / "done").touch()
        shutil.rmtree(out, ignore_errors=True)
        tmp.rename(out)
        _prune(out.parent)
    return key


def _prune(variants: Path) -> None:
    """Keep disk use bounded: only the most recently used versions survive."""
    versions = sorted((d for d in variants.iterdir() if d.is_dir() and not d.name.endswith(".tmp")),
                      key=lambda d: d.stat().st_mtime, reverse=True)
    for old in versions[MAX_PRACTICE_VERSIONS:]:
        shutil.rmtree(old, ignore_errors=True)
