# Front end

No framework and no build step: `index.html` loads these plain scripts in order, and they share one
global scope (later files use functions and state from earlier ones; everything that runs at load time
only depends on files above it).

| File | What it does |
|---|---|
| `core.js` | Part names, small helpers (`$`, `fmt`, `esc`), toasts, `api()`, saved preferences |
| `library.js` | Track list: polling for progress, adding songs (links, files, drag & drop), delete / retry |
| `engine.js` | Audio engine: all parts in sync (Web Audio), loops, takes & metronome scheduler, video sync |
| `tempo.js` | Beat grid from the server + your ½× / 2× / bar-shift corrections; beat & bar-line helpers |
| `recording.js` | Recording yourself (AudioWorklet mic capture) and your saved takes |
| `studio.js` | Opening a song: part rows, loading audio / practice versions, video, presets, saved settings |
| `practice.js` | Speed and key controls |
| `timeline.js` | Waveforms, bar ruler, zoom & scroll, markers, loop selection, the redraw loop |
| `settings.js` | Settings dialog (mic, recording timing, metronome, count-in) |
| `keyboard.js` | Keyboard shortcuts |
| `export.js` | Export dialog: WAV / MP3 / video / parts, optional count-in |
| `tools.js` | Your instrument (auto-mute, transposition), mic meters, A/B, loop counter, notifications |
| `chords.js` | Chord lane, now → next chord, chord chart; naming & transposing chords |
| `palette.js` | Command palette (⌘K): jump to a song or run any command |
| `bento.js` | Welcome screen & website landing page: tile animations, mockup tilt, scroll progress |
| `app.js` | Key display, zoom buttons, rename / search, quit — then starts the app |

**Time:** everything the user sees is in *song time* (seconds of the original recording). Practice versions
are slowed copies, so audio buffers run in *buffer time* = song time ÷ `rate` (the loaded speed).
