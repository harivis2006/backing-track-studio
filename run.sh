#!/bin/sh
# Start Backing Track Studio (or just open it if it's already running).
cd "$(dirname "$0")"
URL="http://localhost:${BTS_PORT:-8765}"
if curl -s -o /dev/null "$URL/api/jobs"; then
  echo "Backing Track Studio is already running at $URL"
  open "$URL"
  exit 0
fi
(for i in $(seq 1 30); do curl -s -o /dev/null "$URL/api/jobs" && open "$URL" && break; sleep 0.5; done) &
exec .venv/bin/python server.py
