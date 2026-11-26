"""Small helpers shared by several modules."""

import json
import os
import subprocess
import threading
from pathlib import Path


def atomic_write_json(path: Path, data, indent: int | None = None) -> None:
    """Write via a temp file + rename, so a crash mid-write can never leave a half-written file."""
    tmp = path.with_name(f".{path.name}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data, indent=indent))
    os.replace(tmp, path)


def safe_filename(name: str, limit: int = 150, fallback: str = "backing track") -> str:
    """Strip characters that aren't allowed in file names on macOS / Windows."""
    return "".join(c for c in name if c not in '/\\:*?"<>|')[:limit].strip() or fallback


def ffmpeg(*args: str) -> subprocess.CompletedProcess:
    """Run ffmpeg quietly; callers check .returncode / .stderr."""
    return subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *map(str, args)], capture_output=True, text=True)
