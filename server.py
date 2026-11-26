"""Backing Track Studio — start the local server.

    .venv/bin/python server.py        then open http://localhost:8765

Settings (environment variables): BTS_PORT (default 8765), BTS_HOST (default 127.0.0.1),
BTS_DATA (where songs are stored; default ./data). See backend/__init__.py for how the code fits together.
"""

import threading

import uvicorn

from backend import analysis, jobs, pipeline, separation
from backend.api import app
from backend.config import HOST, PORT

if __name__ == "__main__":
    jobs.load_existing()
    threading.Thread(target=pipeline.worker, name="worker", daemon=True).start()
    threading.Thread(target=analysis.backfill_all, args=(separation.models_ready,), name="backfill", daemon=True).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
