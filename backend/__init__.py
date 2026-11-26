"""Backing Track Studio backend.

How a song flows through the code:

    api.py        the page uploads a file or pastes a link  ->  jobs.new_job() + queue
    pipeline.py   a single worker thread takes jobs off the queue and runs:
        sources.py      get the audio (upload / YouTube / Spotify->YouTube), keep any video
        separation.py   AI split: 6 parts, then sax/brass out of "other"  (7 parts total)
        analysis.py     waveforms, beats & bars, key, chords (chords.py)  ->  peaks.json
    api.py        the page then streams the parts and asks for extras:
        practice.py     slowed-down / transposed versions
        takes.py        recordings of you playing along
        exports.py      MP3 / video / parts-zip downloads

Everything for one song lives in data/<job id>/ (see jobs.py for the layout).
"""
