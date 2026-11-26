"""The web API the page talks to. Thin layer: validate input, call the module that does the work."""

import asyncio
import os
import shutil
import threading
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import analysis, exports, jobs, practice, sources, takes
from .config import STATIC, STEMS
from .util import safe_filename

app = FastAPI(title="Backing Track Studio")


def _job(job_id: str, done: bool = False) -> dict:
    job = jobs.jobs.get(job_id)
    if not job or job.get("_cancel") or (done and job["status"] != "done"):
        raise HTTPException(404, "No such track")
    return job


def _download(path: Path, media_type: str, filename: str) -> FileResponse:
    """Send a temporary file and delete it afterwards."""
    return FileResponse(path, media_type=media_type, filename=filename,
                        background=BackgroundTask(path.unlink, missing_ok=True))


# ---------------------------------------------------------------- adding songs
class LinkIn(BaseModel):
    url: str


@app.post("/api/upload")
def upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "track").suffix.lower() or ".audio"
    job = jobs.new_job(title=Path(file.filename or "Untitled").stem, source=f"source{ext}")
    with open(jobs.job_dir(job["id"]) / job["source"], "wb") as f:
        shutil.copyfileobj(file.file, f)
    jobs.enqueue(job["id"])
    return jobs.public(job)


@app.post("/api/link")
def add_link(body: LinkIn):
    url = body.url.strip()
    if not url.startswith(("http://", "https://", "spotify:")):
        raise HTTPException(400, "Paste a full link starting with https://")
    job = jobs.new_job(title=url, url=url, source=None)
    jobs.enqueue(job["id"])
    return jobs.public(job)


# ---------------------------------------------------------------- the track list
class Rename(BaseModel):
    title: str


@app.get("/api/jobs")
def list_jobs():
    return [jobs.public(j) for j in sorted(jobs.jobs.values(), key=lambda j: -j["created"]) if not j.get("_cancel")]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return jobs.public(_job(job_id))


@app.patch("/api/jobs/{job_id}")
def rename_job(job_id: str, body: Rename):
    _job(job_id)
    title = " ".join(body.title.split())[:200]
    if not title:
        raise HTTPException(400, "The name can't be empty")
    jobs.update(job_id, title=title)
    return jobs.public(jobs.jobs[job_id])


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    """Delete a track; if it's still queued or processing, this cancels it."""
    _job(job_id)
    return {"ok": True, "cancelling": jobs.cancel_or_delete(job_id)}


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str):
    if _job(job_id)["status"] != "error":
        raise HTTPException(409, "Only failed tracks can be retried")
    jobs.update(job_id, status="queued", stage="Waiting in queue", progress=0.0, error=None)
    jobs.enqueue(job_id)
    return jobs.public(jobs.jobs[job_id])


@app.get("/api/jobs/{job_id}/thumb")
def get_thumb(job_id: str):
    """Library artwork: saved cover art, or a frame grabbed from the video (then cached)."""
    job, jdir = _job(job_id), jobs.job_dir(job_id)
    if not (jdir / "cover.jpg").exists() and (jdir / "video.mp4").exists():
        sources.cover_from_video(jdir, job.get("duration"))
    if not (jdir / "cover.jpg").exists():
        raise HTTPException(404)
    return FileResponse(jdir / "cover.jpg", media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


# ---------------------------------------------------------------- playing a song
class VersionIn(BaseModel):
    speed: float = 1.0
    semitones: int = 0


@app.get("/api/jobs/{job_id}/peaks")
def get_peaks(job_id: str):
    _job(job_id, done=True)
    return JSONResponse(analysis.ensure_analysis(job_id))


@app.get("/api/jobs/{job_id}/stems/{stem}")
def get_stem(job_id: str, stem: str, v: str = ""):
    _job(job_id)
    if stem not in STEMS:
        raise HTTPException(404)
    try:
        p = practice.parts_dir(job_id, v) / f"{stem}.flac"
    except ValueError:
        raise HTTPException(400)
    if not p.exists():
        raise HTTPException(404)
    # a part never changes once written (each practice version has its own key), so the browser may cache it
    return FileResponse(p, media_type="audio/flac", headers={"Cache-Control": "max-age=31536000, immutable"})


@app.post("/api/jobs/{job_id}/variant")
def make_practice_version(job_id: str, body: VersionIn):
    _job(job_id, done=True)
    return {"key": practice.make_version(job_id, body.speed, body.semitones)}


@app.get("/api/jobs/{job_id}/video")
def get_video(job_id: str):
    _job(job_id)
    p = jobs.job_dir(job_id) / "video.mp4"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="video/mp4")  # supports Range requests, so seeking works


# ---------------------------------------------------------------- your takes
class TakeEdit(BaseModel):
    name: str | None = None
    start: float | None = None


@app.get("/api/jobs/{job_id}/takes")
def list_takes(job_id: str):
    _job(job_id)
    return takes.read(job_id)


@app.post("/api/jobs/{job_id}/takes")
async def save_take(job_id: str, request: Request, start: float, rate: float = 1.0, semis: int = 0, name: str = ""):
    """Body: a WAV of the recording."""
    _job(job_id)
    body = await request.body()
    try:
        return await asyncio.to_thread(takes.add, job_id, body, start, rate, semis, name)
    except RuntimeError:
        raise HTTPException(400, "That recording couldn't be read as audio")


@app.get("/api/jobs/{job_id}/takes/{take_id}")
def get_take(job_id: str, take_id: str):
    _job(job_id)
    try:
        p = takes.audio_path(job_id, take_id)
    except ValueError:
        raise HTTPException(404)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="audio/flac")


@app.patch("/api/jobs/{job_id}/takes/{take_id}")
def edit_take(job_id: str, take_id: str, body: TakeEdit):
    _job(job_id)
    take = takes.edit(job_id, take_id, body.name, body.start)
    if take is None:
        raise HTTPException(404)
    return take


@app.delete("/api/jobs/{job_id}/takes/{take_id}")
def delete_take(job_id: str, take_id: str):
    _job(job_id)
    if not takes.delete(job_id, take_id):
        raise HTTPException(404)
    return {"ok": True}


# ---------------------------------------------------------------- exports
@app.post("/api/jobs/{job_id}/export-audio")
async def export_audio(job_id: str, request: Request, format: str = "mp3", name: str = "backing track"):
    """Body: the WAV mix rendered by the page. Returns MP3 (256 kbps) or M4A (AAC)."""
    _job(job_id)
    if format not in ("mp3", "m4a"):
        raise HTTPException(400, "Unsupported format")
    wav, out = exports.scratch(job_id, ".wav"), exports.scratch(job_id, f".{format}")
    wav.write_bytes(await request.body())
    try:
        await asyncio.to_thread(exports.encode_audio, wav, out, format)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    finally:
        wav.unlink(missing_ok=True)
    return _download(out, "audio/mpeg" if format == "mp3" else "audio/mp4", f"{safe_filename(name)}.{format}")


@app.post("/api/jobs/{job_id}/export-video")
async def export_video(job_id: str, request: Request, start: float = 0.0, end: float | None = None,
                       speed: float = 1.0, name: str = "backing track"):
    """Body: the WAV mix rendered by the page. Returns the video with that mix as its sound."""
    _job(job_id)
    video = jobs.job_dir(job_id) / "video.mp4"
    if not video.exists():
        raise HTTPException(404)
    wav, out = exports.scratch(job_id, ".wav"), exports.scratch(job_id, ".mp4")
    wav.write_bytes(await request.body())
    try:
        await asyncio.to_thread(exports.video_with_mix, video, wav, out, start, end, speed)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    finally:
        wav.unlink(missing_ok=True)
    return _download(out, "video/mp4", f"{safe_filename(name)}.mp4")


@app.get("/api/jobs/{job_id}/parts.zip")
async def download_parts(job_id: str, v: str = "", rate: float = 1.0, semis: int = 0):
    """Every non-empty part (and matching takes) as same-length WAVs, ready to drop into a DAW."""
    job = _job(job_id, done=True)
    try:
        folder = practice.parts_dir(job_id, v)
    except ValueError:
        raise HTTPException(400)
    if not folder.exists():
        raise HTTPException(404, "That speed/key version isn't ready")
    silent = {k for k, s in analysis.ensure_analysis(job_id)["stems"].items() if s["silent"]}
    out = exports.scratch(job_id, ".zip")
    filename = await asyncio.to_thread(exports.parts_zip, job, folder, silent, rate, semis, out)
    return _download(out, "application/zip", filename)


# ---------------------------------------------------------------- the app itself
@app.post("/api/quit")
def quit_app():
    """Stop the server (Settings → Quit). A song still processing carries on next time."""
    threading.Timer(0.5, lambda: os._exit(0)).start()
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")
