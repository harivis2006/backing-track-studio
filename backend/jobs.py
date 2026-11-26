"""The track list: one "job" per song, its on-disk folder, the processing queue, and progress.

Folder layout for one song (data/<id>/):
    meta.json            title, status, progress, which parts exist, ...  (this module)
    source.* / video.mp4 the original upload / download                   (sources.py)
    cover.jpg            artwork for the library                           (sources.py)
    stems/<part>.flac    the separated parts                               (separation.py)
    peaks.json           waveforms, beats, key                             (analysis.py)
    variants/<key>/      slowed-down / transposed copies of the parts      (practice.py)
    takes/               your recordings                                   (takes.py)
    exports/             temporary files while building a download         (exports.py)

Keys starting with "_" in a job dict are in-memory only (never saved or sent to the page).
"""

import json
import queue
import shutil
import time
import uuid
from pathlib import Path

from .config import DATA
from .util import atomic_write_json

jobs: dict[str, dict] = {}
work_queue: "queue.Queue[str]" = queue.Queue()


class Cancelled(Exception):
    """Raised inside the pipeline when the user cancels a job."""


def job_dir(job_id: str) -> Path:
    return DATA / job_id


def public(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def save(job: dict) -> None:
    if job_dir(job["id"]).exists():  # the folder is gone if the job was just deleted
        atomic_write_json(job_dir(job["id"]) / "meta.json", public(job), indent=2)


def update(job_id: str, **fields) -> None:
    jobs[job_id].update(fields)
    save(jobs[job_id])


def new_job(**fields) -> dict:
    job_id = uuid.uuid4().hex[:10]
    job_dir(job_id).mkdir()
    job = {"id": job_id, "status": "queued", "stage": "Waiting in queue", "progress": 0.0,
           "created": time.time(), "stems": [], **fields}
    jobs[job_id] = job
    save(job)
    return job


def enqueue(job_id: str) -> None:
    if job_id in jobs:
        jobs[job_id]["queued_at"] = time.time()  # retried songs go to the back of the queue
    work_queue.put(job_id)


def cancel_or_delete(job_id: str) -> bool:
    """Delete a finished track, or ask the worker to stop a queued/running one. Returns True if cancelling."""
    job = jobs[job_id]
    if job["status"] in ("queued", "running"):
        job["_cancel"] = True  # the worker notices at its next progress tick and removes the job
        return True
    shutil.rmtree(job_dir(job_id), ignore_errors=True)
    jobs.pop(job_id, None)
    return False


def check_cancel(job_id: str) -> None:
    if jobs.get(job_id, {}).get("_cancel"):
        raise Cancelled()


def load_existing() -> None:
    """Load all songs from disk at start-up; anything interrupted mid-processing is queued again."""
    for meta in sorted(DATA.glob("*/meta.json"), key=lambda p: p.stat().st_mtime):
        try:
            job = json.loads(meta.read_text())
        except json.JSONDecodeError:
            continue
        if job["status"] in ("queued", "running"):
            job.update(status="queued", stage="Waiting in queue", progress=0.0, eta=None)
            enqueue(job["id"])
        jobs[job["id"]] = job
    for d in DATA.iterdir():  # leftovers from an interrupted export or practice-version render
        if d.is_dir():
            shutil.rmtree(d / "exports", ignore_errors=True)
            for tmp in (d / "variants").glob("*.tmp") if (d / "variants").exists() else []:
                shutil.rmtree(tmp, ignore_errors=True)


class Progress:
    """Turns "stage X is 40% done" into one overall 0-1 progress value plus a time-remaining estimate.

    Stages and their share of the bar come from config.WEIGHTS_*. The estimate only uses the two
    AI-model stages, because they take nearly all the time.
    """

    def __init__(self, job_id: str, weights: dict):
        self.job_id, self.weights = job_id, weights
        self.order = list(weights)
        self.stage = self.order[0]
        self.last_write = 0.0
        self.compute_start = None
        self.compute_base = 0.0
        self.entered: list[tuple[str, float]] = []  # (stage, when) — for the timing line in the log

    def _base(self, stage: str) -> float:
        return sum(self.weights[s] for s in self.order[: self.order.index(stage)])

    def enter(self, stage: str, label: str) -> None:
        check_cancel(self.job_id)
        self.stage = stage
        if not self.entered or self.entered[-1][0] != stage:
            self.entered.append((stage, time.time()))
        if stage in ("split", "winds") and self.compute_start is None:
            self.compute_start = time.time()
            self.compute_base = self._base(stage)
        self.set(0.0, label=label, force=True)

    def times(self) -> dict[str, float]:
        """Seconds spent in each stage so far."""
        marks = self.entered + [("", time.time())]
        return {s: b - a for (s, a), (_, b) in zip(marks, marks[1:])}

    def set(self, fraction: float, label: str | None = None, force: bool = False) -> None:
        check_cancel(self.job_id)
        now = time.time()
        if not force and now - self.last_write < 0.5:  # don't rewrite meta.json more than twice a second
            return
        self.last_write = now
        overall = self._base(self.stage) + self.weights[self.stage] * max(0.0, min(1.0, fraction))
        fields = {"progress": round(overall, 4)}
        if label:
            fields["stage"] = label
        if self.compute_start is not None:
            done = overall - self.compute_base
            if done > 0.02:
                compute_total = self.weights["split"] + self.weights["winds"]
                remaining = max(0.0, self.compute_base + compute_total - overall)
                fields["eta"] = round((now - self.compute_start) * remaining / done + 2)
        update(self.job_id, **fields)
