# Backing Track Studio

Turn any song into a backing track you can play along with. Drop in a song or video, or paste a YouTube or
Spotify link, and it's split into **vocals, sax / brass, guitar, piano, bass, drums** and everything else.
Mute your part, slow it down or change key, loop the hard bit, record yourself over it, and export.

Everything runs locally on your Mac — the AI models run on Apple Silicon's GPU.

## Features

- **Split into 7 parts** with mute / solo / volume per part; one-click "remove sax / vocals / …"
- **YouTube links** (keeps the video, plays in sync) and **Spotify links** (finds the same recording on YouTube)
- **Practice tools:** speed 50–120% without changing pitch, key ±12 semitones, loops that snap to the beat,
  section markers, count-in, metronome, A/B against the original, zoomable waveforms
- **Chord changes:** detected for every song, shown under the timeline (now → next in the header) and as a
  chord chart (H), written for your instrument and following key changes
- **Your instrument:** new songs open with your part muted; keys are shown written for E♭ / B♭ / F instruments
- **Record yourself** over the track (with latency correction, mic level meter, multiple takes)
- **Export** MP3 / WAV / video, optionally with a count-in, or every part as separate WAVs for a DAW

## Using the website

The page is hosted at **https://backingtrackstudio.xyz**; the AI work happens on your own Mac via a
small **helper** (this repo's server) that the website talks to at `http://127.0.0.1:8765`.
The first visit shows a one-line installer:

```bash
curl -fsSL https://backingtrackstudio.xyz/install.sh | bash
```

It installs the helper into `~/Library/Application Support/Backing Track Studio`, starts it at login, and adds
**Backing Track Studio Helper** to Applications. Remove it with `…/uninstall.sh | bash` (add `-s -- --all` to also
delete your songs). The helper only accepts requests from the website and from its own page.

The site redeploys automatically on every push to `main` (Vercel runs `deploy/build_site.py`).

## Running it from source

Requirements: macOS on Apple Silicon (an Intel Mac or Linux works, just slower), Python 3.12, `ffmpeg`, Node.js.

```bash
brew install python@3.12 ffmpeg node
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
./run.sh                      # starts the server and opens http://localhost:8765
```

Or double-click **macos/Backing Track Studio.app** (stop it from ⚙︎ Settings → Quit app).
The AI models (~1 GB) download automatically the first time.

Settings via environment variables: `BTS_PORT` (default 8765), `BTS_HOST` (default 127.0.0.1),
`BTS_DATA` (where songs are stored, default `./data`).

## How it works

```
page (static/)  ──upload / link──▶  api.py ──▶ queue ──▶ pipeline.py (one song at a time)
                                                   1. sources.py     get audio (upload / YouTube / Spotify→YouTube)
                                                   2. separation.py  BS-RoFormer SW → 6 parts; UVR HP-Wind → sax/brass
                                                   3. analysis.py    waveforms, beats & bars (Beat This!), key, chords (chords.py, BTC)
page ◀── parts (FLAC), peaks.json ◀── api.py ◀── practice.py (speed/key versions), takes.py, exports.py
```

| Path | |
|---|---|
| `server.py` | Entry point |
| `backend/` | The server — start with `backend/__init__.py` for a map of the modules |
| `static/index.html`, `static/css/app.css` | The page |
| `static/js/` | The front end, one file per feature — see `static/js/README.md` |
| `macos/` | Double-click launcher app |
| `deploy/` | Website build script, installer / uninstaller |
| `vercel.json` | Hosting settings: Vercel builds the static site from `deploy/build_site.py` on every push |
| `data/` | Your songs (one folder each; not in git) |
| `models/` | Downloaded AI model weights (not in git) |

## Credits & licences

- Separation: [audio-separator](https://github.com/nomadkaraoke/python-audio-separator) (MIT) running
  **BS-RoFormer SW** by jarredou (weights licensed **CC BY-NC-SA 4.0 — non-commercial**) and the
  **UVR HP-Wind** model from [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui)
- Beats & bars: [Beat This!](https://github.com/CPJKU/beat_this) (CPJKU, MIT)
- Chords: [BTC](https://github.com/jayg996/BTC-ISMIR19) — Bi-directional Transformer for Chord recognition (Park et al., MIT)
- Speed / key: Rubber Band via Spotify's [pedalboard](https://github.com/spotify/pedalboard) (GPLv3)
- Downloads: [yt-dlp](https://github.com/yt-dlp/yt-dlp)

Downloading from YouTube is against YouTube's terms of service; use this for personal practice only.
