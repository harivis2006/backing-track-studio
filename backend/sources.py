"""Getting a song's audio (and video, if any) into its folder.

  * Uploads:  saved by the API as source.<ext>; if the file has a real video track we keep a
              browser-playable copy as video.mp4.
  * YouTube:  yt-dlp downloads 720p H.264 video.mp4 (audio is taken from it).
  * Spotify:  Spotify audio is DRM-protected, so we never download from Spotify. We read the song's
              title / artist / length from its public page and download the same recording from YouTube.

Plus artwork for the library (album art / video thumbnail) and decoding to a standard WAV.
"""

import html
import io
import json
import re
import subprocess
import urllib.request
from pathlib import Path

from . import jobs
from .config import MAX_MINUTES, YTDLP_BASE, YTDLP_FORMAT, log
from .jobs import Progress, job_dir
from .util import ffmpeg

_BROWSER_UA = {"User-Agent": "Mozilla/5.0"}


# ---------------------------------------------------------------- YouTube (and other yt-dlp sites)

def _auto_title(job_id: str, title: str | None) -> None:
    """Name the song after the video / Spotify track — unless you've already renamed it."""
    if title and not jobs.jobs[job_id].get("renamed"):
        jobs.update(job_id, title=title)

def download_video(job_id: str, progress: Progress) -> None:
    import yt_dlp

    jdir = job_dir(job_id)
    opts = {**YTDLP_BASE, "format": YTDLP_FORMAT, "merge_output_format": "mp4",
            "outtmpl": str(jdir / "video.%(ext)s"),
            "progress_hooks": [_download_hook(progress, "Downloading video")]}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(jobs.jobs[job_id]["url"], download=False)
        if info.get("_type") == "playlist":
            raise RuntimeError("That's a playlist link; paste a link to a single video")
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
            raise RuntimeError("That's a live stream; try again once it has finished and been processed")
        if (info.get("duration") or 0) > MAX_MINUTES * 60:
            raise RuntimeError(f"Video is longer than {MAX_MINUTES} minutes")
        _auto_title(job_id, info.get("title"))
        save_cover(jdir, info.get("thumbnail"))
        ydl.process_info(info)
    out = next(p for p in jdir.glob("video.*") if not p.name.endswith(".part"))
    if out.name != "video.mp4":
        out.rename(jdir / "video.mp4")


def _download_hook(progress: Progress, label: str, start: float = 0.0, span: float = 1.0):
    def hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            frac = d["downloaded_bytes"] / total if total else 0
            progress.set(start + span * frac, label=f"{label} {frac:.0%}" if total else label)
    return hook


# ---------------------------------------------------------------- Spotify -> YouTube
def is_spotify(url: str) -> bool:
    return url.startswith("spotify:") or any(h in url for h in ("open.spotify.com", "spotify.link", "spotify.app.link"))


def spotify_track(url: str) -> dict:
    """Title, artist, album, length and artwork from Spotify's public track page (no login needed)."""
    if url.startswith("spotify:"):  # spotify:track:<id>
        _, kind, ident = url.split(":")[:3]
        url = f"https://open.spotify.com/{kind}/{ident}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=_BROWSER_UA), timeout=20) as r:
        final_url, page = r.geturl(), r.read().decode("utf-8", "replace")  # follows spotify.link redirects

    def meta(key):
        m = re.search(rf'<meta (?:property|name)="{re.escape(key)}" content="([^"]*)"', page)
        return html.unescape(m.group(1)) if m else ""

    if "/track/" not in final_url or meta("og:type") != "music.song":
        kind = next((k for k in ("album", "playlist", "artist", "episode", "show") if f"/{k}/" in final_url), None)
        raise RuntimeError(f"That's a Spotify {kind} link; paste a link to a single song" if kind
                           else "Couldn't read that Spotify link; paste a link to a single song")
    desc = meta("og:description").split(" · ")  # "Artist · Album · Song · 1987"
    return {"title": meta("og:title"), "artist": meta("music:musician_description") or desc[0],
            "album": desc[1] if len(desc) > 2 else "", "duration": int(meta("music:duration") or 0),
            "url": final_url.split("?")[0], "image": meta("og:image")}


# Versions to avoid unless the Spotify title itself says so.
_UNWANTED = ("live", "cover", "karaoke", "instrumental", "remix", "sped up", "slowed", "reverb",
             "nightcore", "8d", "acoustic", "piano version", "lesson", "tutorial", "reaction", "backing track")
_CHANNEL_FILLER = {"the", "topic", "vevo", "official", "music", "band", "quartet", "trio", "quintet", "and"}


def find_on_youtube(track: dict) -> dict:
    """Pick the YouTube upload most likely to be the same recording as a Spotify track.

    Scoring: length must be within 15 s; the artist's own channel / YouTube's "Artist - Topic" audio and a
    matching title score up; live/cover/remix/... versions score down; earlier search results win ties.
    """
    import yt_dlp

    words = lambda s: re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).split()
    want_title = words(track["title"])
    artist = set(words(track["artist"])) - _CHANNEL_FILLER
    spotify_words = set(words(track["title"] + " " + track["album"]))
    query = f"ytsearch10:{track['artist']} {track['title']} audio"
    with yt_dlp.YoutubeDL({**YTDLP_BASE, "extract_flat": "in_playlist"}) as ydl:
        results = [e for e in (ydl.extract_info(query, download=False).get("entries") or []) if e]

    best, best_score = None, float("-inf")
    for rank, e in enumerate(results):
        if not e.get("duration"):
            continue
        off_by = abs(e["duration"] - track["duration"]) if track["duration"] else 0
        if off_by > 15:  # a different edit, or not the song at all
            continue
        title = " ".join(words(e.get("title")))
        channel = " ".join(words(e.get("channel") or e.get("uploader")))
        score = -2 * off_by + (10 - rank)
        if all(w in title.split() for w in want_title):
            score += 20
        ch = set(channel.split()) - _CHANNEL_FILLER
        # e.g. channel "Dave Brubeck" for artist "The Dave Brubeck Quartet" counts as the artist
        if channel.endswith("topic") or (ch and artist and (ch <= artist or artist <= ch)):
            score += 30
        for bad in _UNWANTED:
            if f" {bad} " in f" {title} " and not set(bad.split()) <= spotify_words:
                score -= 40
        if score > best_score:
            best, best_score = e, score
    if best is None:
        raise RuntimeError(f"Couldn't find \"{track['artist']} - {track['title']}\" on YouTube at the right length")
    return {"url": best.get("url") or f"https://www.youtube.com/watch?v={best['id']}",
            "title": best.get("title"), "channel": best.get("channel") or best.get("uploader")}


def download_spotify(job_id: str, progress: Progress) -> None:
    import yt_dlp

    jdir = job_dir(job_id)
    progress.set(0.02, label="Reading Spotify link", force=True)
    track = spotify_track(jobs.jobs[job_id]["url"])
    jobs.update(job_id, spotify=track)
    _auto_title(job_id, f"{track['artist']} - {track['title']}")
    save_cover(jdir, track.get("image"))
    progress.set(0.1, label="Finding the song on YouTube", force=True)
    match = find_on_youtube(track)
    jobs.update(job_id, matched=match)
    opts = {**YTDLP_BASE, "format": "ba[ext=m4a]/ba", "outtmpl": str(jdir / "source.%(ext)s"),
            "progress_hooks": [_download_hook(progress, "Downloading audio", start=0.2, span=0.8)]}
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([match["url"]])
    jobs.update(job_id, source=next(p for p in jdir.glob("source.*") if not p.name.endswith(".part")).name)


# ---------------------------------------------------------------- uploads, artwork, decoding
def keep_video(jdir: Path, source: str) -> bool:
    """If an uploaded file has a real video track, save a browser-playable copy as video.mp4."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v",
         "-show_entries", "stream=codec_name:stream_disposition=attached_pic", "-of", "json", str(jdir / source)],
        capture_output=True, text=True)
    streams = [s for s in json.loads(probe.stdout or "{}").get("streams", [])
               if not s.get("disposition", {}).get("attached_pic")]  # album art inside an mp3 isn't a video
    if not streams:
        return False
    video = ["-c:v", "copy"] if streams[0].get("codec_name") == "h264" else \
            ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-vf", "scale=-2:'min(720,ih)'"]
    res = ffmpeg("-i", jdir / source, "-map", "0:v:0", "-map", "0:a:0?", *video,
                 "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", jdir / "video.mp4")
    if res.returncode != 0:  # an odd video track shouldn't sink the whole job: carry on audio-only
        log.warning("couldn't keep video for %s: %s", jdir.name, res.stderr[-300:])
        (jdir / "video.mp4").unlink(missing_ok=True)
        return False
    return True


def save_cover(jdir: Path, url: str | None) -> None:
    """Best-effort artwork for the library. Never fails a job."""
    if not url or not url.startswith("https://"):
        return
    try:
        from PIL import Image

        with urllib.request.urlopen(urllib.request.Request(url, headers=_BROWSER_UA), timeout=15) as r:
            img = Image.open(io.BytesIO(r.read(8_000_000))).convert("RGB")
        img.thumbnail((320, 320))
        img.save(jdir / "cover.jpg", quality=85)
    except Exception:  # noqa: BLE001
        log.info("no cover art for %s", jdir.name)


def cover_from_video(jdir: Path, duration: float | None) -> None:
    """Grab a frame ~20% into the video as library artwork."""
    at = min((duration or 30) * 0.2, 60)
    ffmpeg("-ss", at, "-i", jdir / "video.mp4", "-frames:v", "1", "-vf", "scale=320:-2", jdir / "cover.jpg")


def decode_to_wav(src: Path, dst: Path) -> float:
    """Decode any audio/video file to 44.1 kHz stereo 16-bit WAV. Returns its length in seconds.

    The 10 Hz high-pass removes any DC offset: audio-separator adds the input's average level back onto
    *every* part, so an offset in the source would otherwise be multiplied by the number of parts.
    """
    import soundfile as sf

    res = ffmpeg("-i", src, "-map", "0:a:0", "-af", "highpass=f=10", "-ac", "2", "-ar", "44100",
                 "-c:a", "pcm_s16le", dst)
    if res.returncode != 0:
        log.warning("decode failed: %s", res.stderr[-500:])
        raise RuntimeError("Couldn't read any audio from this file. Is it a song or a video with sound?")
    seconds = sf.info(str(dst)).duration
    if seconds < 1:
        raise RuntimeError("This file has less than a second of audio")
    if seconds > MAX_MINUTES * 60:
        raise RuntimeError(f"This is {seconds / 60:.0f} minutes long; the limit is {MAX_MINUTES} minutes "
                           "(longer songs take too much memory to play back in the browser)")
    return seconds
