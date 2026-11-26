"""The AI models that split a song into parts (via the audio-separator package).

Two passes:
  1. BS-RoFormer SW: vocals, drums, bass, guitar, piano, other
  2. UVR "HP-Wind" on "other": sax / brass / woodwinds  vs  everything else

Models are loaded once and kept in memory. Progress comes from audio-separator's internal
tqdm progress bars, which we swap for one that reports to our own progress callback.
"""

import threading
from pathlib import Path

from .config import MODELS, SPLIT_MODEL, WIND_MODEL

models_ready = threading.Event()  # set once start-up loading has finished (or failed)
_separators: dict[str, object] = {}
_progress_callback = None


class _ProgressBar:
    """Stand-in for tqdm that forwards "n of total" to _progress_callback."""

    def __init__(self, iterable=None, *args, total=None, **kwargs):
        self.iterable = iterable
        self.total = total if total is not None else (len(iterable) if hasattr(iterable, "__len__") else None)
        self.n = 0

    def __iter__(self):
        for item in self.iterable:
            self._report()
            yield item
            self.n += 1
        self._report()

    def _report(self):
        # Ignore tiny loops (e.g. the wind model's 4 frequency bands): they'd make the bar jump around.
        if _progress_callback and self.total and self.total >= 8:
            _progress_callback(self.n / self.total)

    def update(self, n=1):
        self.n += n
        self._report()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def close(self): ...
    def set_description(self, *a, **k): ...
    def set_postfix(self, *a, **k): ...
    def refresh(self, *a, **k): ...


def _install_progress_bar() -> None:
    import audio_separator.separator.architectures.mdxc_separator as mdxc
    import audio_separator.separator.architectures.vr_separator as vr

    mdxc.tqdm = _ProgressBar
    vr.tqdm = _ProgressBar


def _separator(model: str, out_dir: Path):
    from audio_separator.separator import Separator

    sep = _separators.get(model)
    if sep is None:
        sep = Separator(
            model_file_dir=str(MODELS),
            output_dir=str(out_dir),
            output_format="WAV",
            normalization_threshold=1.0,  # never rescale parts: they must add back up to the original
            log_level=30,                 # warnings only
            vr_params={"batch_size": 4, "window_size": 512, "aggression": 5, "enable_tta": False,
                       "enable_post_process": False, "post_process_threshold": 0.2, "high_end_process": False},
        )
        sep.load_model(model_filename=model)
        _install_progress_bar()
        _separators[model] = sep
    sep.output_dir = str(out_dir)
    if getattr(sep, "model_instance", None) is not None:
        sep.model_instance.output_dir = str(out_dir)
    return sep


def load_models() -> None:
    _separator(SPLIT_MODEL, MODELS)
    _separator(WIND_MODEL, MODELS)


def separate(model: str, src: Path, out_dir: Path, names: dict[str, str], on_progress) -> dict[str, Path]:
    """Run one model on `src`. `names` maps the model's part names to our file names.
    Returns {our name: path of the written WAV}."""
    global _progress_callback
    sep = _separator(model, out_dir)
    _progress_callback = on_progress
    try:
        files = sep.separate(str(src), custom_output_names=names)
    finally:
        _progress_callback = None
    found = {}
    for f in files:
        p = Path(f)
        found[p.stem] = p if p.is_absolute() else out_dir / p
    missing = [n for n in names.values() if n not in found]
    if missing:
        raise RuntimeError(f"The model didn't produce: {', '.join(missing)}")
    return found


def finalize_stems(stems_dir: Path) -> None:
    """Remove any leftover DC offset and store each part as lossless FLAC (about half the size of WAV)."""
    import soundfile as sf

    for p in stems_dir.glob("*.wav"):
        x, sr = sf.read(p, dtype="float32")
        sf.write(p.with_suffix(".flac"), (x - x.mean(axis=0)).clip(-1, 1), sr, subtype="PCM_16")
        p.unlink()
