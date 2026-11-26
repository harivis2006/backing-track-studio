"""Build the public website into site/:

    site/index.html, site/static/...   the app's page (talks to the helper on the visitor's Mac)
    site/install.sh, uninstall.sh      one-line installer / uninstaller for the helper
    site/helper.zip                    the helper itself (backend + page), downloaded by install.sh

Run:  python3 deploy/build_site.py      (the site URL comes from backend/config.py SITE_URL)
Vercel runs this automatically on every push (see vercel.json).
"""

import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site"
HELPER_FILES = ["server.py", "requirements.txt", "run.sh", "README.md", "backend", "static", "macos"]


def site_url() -> str:
    m = re.search(r'^SITE_URL = "([^"]+)"', (ROOT / "backend" / "config.py").read_text(), re.M)
    if not m:
        raise SystemExit("SITE_URL not found in backend/config.py")
    return m.group(1)


def add_to_zip(z: zipfile.ZipFile, path: Path) -> None:
    files = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
    for f in files:
        if "__pycache__" in f.parts or f.name == ".DS_Store":
            continue
        info = zipfile.ZipInfo.from_file(f, f.relative_to(ROOT).as_posix())
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, f.read_bytes())  # keeps file permissions (e.g. run.sh stays executable)


def main() -> None:
    url = site_url()
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir()
    shutil.copy(ROOT / "static" / "index.html", OUT / "index.html")
    shutil.copytree(ROOT / "static", OUT / "static", ignore=shutil.ignore_patterns("README.md"))
    for script in ("install.sh", "uninstall.sh"):
        (OUT / script).write_text((ROOT / "deploy" / script).read_text().replace("__SITE_URL__", url))
    with zipfile.ZipFile(OUT / "helper.zip", "w") as z:
        for name in HELPER_FILES:
            add_to_zip(z, ROOT / name)
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"built {OUT} for {url} ({size / 1024:.0f} KB, helper.zip {(OUT / 'helper.zip').stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
