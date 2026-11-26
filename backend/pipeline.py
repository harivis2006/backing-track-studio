"""Processing a song from start to finish, one at a time on a single background worker thread."""

import queue
import re
import shutil
import time
import traceback

from . import analysis, chords, jobs, separation, sources
from .config import SPLIT_MODEL, STEMS, WEIGHTS_FILE, WEIGHTS_LINK, WIND_MODEL, log
from .jobs import Cancelled, Progress, job_dir


def process(job_id: str) -> None:
    job = jobs.jobs[job_id]
    jdir = job_dir(job_id)
    stems_dir, tmp = jdir / "stems", jdir / "tmp"
    stems_dir.mkdir(exist_ok=True)
    tmp.mkdir(exist_ok=True)
    started = time.time()
    is_link = bool(job.get("url"))
    progress = Progress(job_id, WEIGHTS_LINK if is_link else WEIGHTS_FILE)
    jobs.update(job_id, status="running", error=None, eta=None)

    # 1. get the media
    if is_link and sources.is_spotify(job["url"]):
        progress.enter("fetch", "Reading Spotify link")
        if not job.get("source"):
            sources.download_spotify(job_id, progress)
        jobs.update(job_id, video=False)  # Spotify songs are audio-only
    elif is_link:
        progress.enter("fetch", "Downloading video")
        if not (jdir / "video.mp4").exists():
            sources.download_video(job_id, progress)
        jobs.update(job_id, source="video.mp4", video=True)
    elif "video" not in job:
        progress.enter("fetch", "Checking for video")
        jobs.update(job_id, video=sources.keep_video(jdir, job["source"]))
    job = jobs.jobs[job_id]

    # 2. decode to a standard WAV
    progress.enter("decode", "Decoding audio")
    mix = jdir / "mix.wav"
    jobs.update(job_id, duration=round(sources.decode_to_wav(jdir / job["source"], mix), 2))

    # 3. split into 6 parts
    if not separation.models_ready.is_set() or not separation.loaded():
        progress.enter("split", "Loading AI models (a few seconds)")
        separation.models_ready.wait()
        separation.load_models()
    progress.enter("split", "Splitting vocals, drums, bass, guitar, piano")
    six = {"Vocals": "vocals", "Drums": "drums", "Bass": "bass", "Guitar": "guitar", "Piano": "piano",
           "Other": "other_full"}
    out = separation.separate(SPLIT_MODEL, mix, tmp, six, progress.set)
    for name, path in out.items():
        if name != "other_full":
            shutil.move(str(path), stems_dir / f"{name}.wav")

    # 4. pull sax / brass / woodwinds out of "other"
    progress.enter("winds", "Isolating sax / brass / woodwinds")
    out = separation.separate(WIND_MODEL, tmp / "other_full.wav", tmp,
                              {"Woodwinds": "winds", "No Woodwinds": "other"}, progress.set)
    for name, path in out.items():
        shutil.move(str(path), stems_dir / f"{name}.wav")

    # 5. save parts as FLAC and analyse (waveforms, beats, key)
    progress.enter("finish", "Saving parts")
    shutil.rmtree(tmp, ignore_errors=True)
    separation.finalize_stems(stems_dir)
    analysis.compute_peaks(jdir)
    mix.unlink(missing_ok=True)  # the parts are all we need; the original download/upload is kept
    jobs.update(job_id, status="done", stage="Done", progress=1.0, eta=None,
                seconds=round(time.time() - started, 1), model=SPLIT_MODEL,
                stems=[s for s in STEMS if (stems_dir / f"{s}.flac").exists()])
    log.info("job %s done in %.1fs", job_id, time.time() - started)


def friendly_error(e: Exception) -> str:
    """'ERROR: [youtube] abc123: Video unavailable' -> 'Video unavailable'."""
    msg = re.sub(r"^(ERROR:\s*)?(\[[^\]]+\]\s*[\w-]+:\s*)?", "", str(e).strip())
    return (msg or e.__class__.__name__)[:300]


def load_models() -> None:
    """Load every model up front so the first song doesn't wait ~25 s for them."""
    try:
        separation.load_models()
        analysis.beat_tracker()
        log.info("models loaded")
    except Exception:  # noqa: BLE001 — a failure here resurfaces, with a message, on the first job
        traceback.print_exc()
    finally:
        separation.models_ready.set()


IDLE_UNLOAD = 600  # seconds without a song to split before the AI models are let go to free memory


def free_models() -> None:
    """Release the AI models while idle (~1.7 GB). Anything that needs one loads it again by itself."""
    import gc

    if not separation.loaded():
        return
    separation.unload(); analysis.unload_models(); chords.unload()
    gc.collect()
    try:
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:  # noqa: BLE001
        pass
    log.info("idle: AI models released to free memory")


def worker() -> None:
    load_models()
    while True:
        try:
            job_id = jobs.work_queue.get(timeout=IDLE_UNLOAD)
        except queue.Empty:
            free_models()
            continue
        try:
            if job_id in jobs.jobs and not jobs.jobs[job_id].get("_cancel"):
                process(job_id)
        except Cancelled:
            log.info("job %s cancelled", job_id)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            if job_id in jobs.jobs:
                jobs.update(job_id, status="error", stage="Failed", error=friendly_error(e), eta=None)
        finally:
            job = jobs.jobs.get(job_id)
            if job and job.get("_cancel"):  # cancelled jobs are removed entirely
                shutil.rmtree(job_dir(job_id), ignore_errors=True)
                jobs.jobs.pop(job_id, None)
            jobs.work_queue.task_done()
