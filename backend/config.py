"""Paths, settings and constants used across the backend."""

import logging
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
MODELS = ROOT / "models"                                    # downloaded AI model weights
DATA = Path(os.environ.get("BTS_DATA", ROOT / "data"))       # one folder per song
HOST = os.environ.get("BTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("BTS_PORT", 8765))
VERSION = "1.1.0"

# The hosted website that may use this helper (plus the helper's own page). Any other website is refused,
# so a random page you visit can't control the helper. Add more with BTS_ALLOWED_ORIGINS="https://a,https://b".
SITE_URL = "https://backing-track-studio.vercel.app"
ALLOWED_ORIGINS = {SITE_URL, f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"} | {
    o.strip().rstrip("/") for o in os.environ.get("BTS_ALLOWED_ORIGINS", "").split(",") if o.strip()}
# Only answer requests addressed to this machine by name (blocks "DNS rebinding" tricks).
ALLOWED_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}", "localhost", "127.0.0.1"}

DATA.mkdir(parents=True, exist_ok=True)
MODELS.mkdir(exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("bts")

# The parts a song is split into, in the order the player shows them.
STEMS = ["vocals", "winds", "guitar", "piano", "other", "bass", "drums"]

# AI models (downloaded on first use by audio-separator into MODELS).
SPLIT_MODEL = "BS-Roformer-SW.ckpt"   # 6 parts: vocals, drums, bass, guitar, piano, other
WIND_MODEL = "17_HP-Wind_Inst-UVR.pth"  # pulls sax / brass / woodwinds out of "other"

# Splitting runs at ~1.3x real time, and the browser holds ~21 MB per part per minute.
MAX_MINUTES = 15
SILENT_DB = -60        # a part quieter than this overall counts as "not in this song"
PEAK_COLUMNS = 2000    # resolution of the waveform overview sent to the page

# YouTube: 720p H.264 + AAC plays in every browser and keeps files a sensible size.
YTDLP_FORMAT = "bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/bv*[height<=720]+ba/b"
YTDLP_BASE = {"quiet": True, "no_warnings": True, "noplaylist": True,
              "js_runtimes": {"node": {}}}  # YouTube extraction needs a JavaScript runtime

# Share of the progress bar each processing stage gets (the main split dominates;
# the sax/brass model takes ~10% as long).
WEIGHTS_LINK = {"fetch": 0.10, "decode": 0.02, "split": 0.77, "winds": 0.09, "finish": 0.02}
WEIGHTS_FILE = {"fetch": 0.01, "decode": 0.02, "split": 0.86, "winds": 0.09, "finish": 0.02}

# Practice versions: how many speed/key versions to keep per song (they take disk space).
MAX_PRACTICE_VERSIONS = 3
