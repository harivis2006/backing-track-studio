"""Recordings of you playing along ("takes"), stored in data/<id>/takes/.

takes.json lists them; each take's `start` is where it begins in the parts' timeline at the speed it was
recorded at (`rate`, `semis`), so a take only plays back against that same practice version.
"""

import io
import json
import time
import uuid
from pathlib import Path

from .jobs import job_dir
from .util import atomic_write_json


def _folder(job_id: str) -> Path:
    return job_dir(job_id) / "takes"


def audio_path(job_id: str, take_id: str) -> Path:
    if not take_id.isalnum():
        raise ValueError("bad take id")
    return _folder(job_id) / f"{take_id}.flac"


def read(job_id: str) -> list[dict]:
    p = _folder(job_id) / "takes.json"
    return json.loads(p.read_text()) if p.exists() else []


def _write(job_id: str, takes: list[dict]) -> None:
    _folder(job_id).mkdir(exist_ok=True)
    atomic_write_json(_folder(job_id) / "takes.json", takes, indent=2)


def add(job_id: str, wav_bytes: bytes, start: float, rate: float, semis: int, name: str = "") -> dict:
    import soundfile as sf

    x, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")  # raises if it isn't audio
    takes = read(job_id)
    take = {"id": uuid.uuid4().hex[:8], "name": name or f"Take {len(takes) + 1}", "created": time.time(),
            "start": round(start, 4), "duration": round(len(x) / sr, 3), "rate": rate, "semis": semis}
    _folder(job_id).mkdir(exist_ok=True)
    sf.write(audio_path(job_id, take["id"]), x, sr, subtype="PCM_16")
    _write(job_id, takes + [take])
    return take


def edit(job_id: str, take_id: str, name: str | None = None, start: float | None = None) -> dict | None:
    takes = read(job_id)
    take = next((t for t in takes if t["id"] == take_id), None)
    if take is None:
        return None
    if name is not None:
        take["name"] = name.strip()[:80] or take["name"]
    if start is not None:  # nudging the timing
        take["start"] = round(start, 4)
    _write(job_id, takes)
    return take


def delete(job_id: str, take_id: str) -> bool:
    takes = read(job_id)
    if not any(t["id"] == take_id for t in takes):
        return False
    _write(job_id, [t for t in takes if t["id"] != take_id])
    audio_path(job_id, take_id).unlink(missing_ok=True)
    return True
