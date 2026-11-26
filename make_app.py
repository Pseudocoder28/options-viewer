"""Build "Options Terminal.app": a double-click launcher for macOS.

    python3 make_app.py

Double-clicking the app starts the local server if it is not already running and opens the
terminal in your default browser. The server stops by itself 15 minutes after the last browser
tab is closed. Drag the app to the Dock for one-click access; run this script again if you move
the project folder. Standard library only.
"""
import math
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
APP = ROOT / "Options Terminal.app"

LAUNCHER = r'''#!/bin/zsh
# Options Terminal launcher, written by make_app.py. Run make_app.py again if the project folder moves.
PROJECT="__PROJECT__"
PORT=8765
URL="http://127.0.0.1:$PORT/"
LOG="$HOME/Library/Logs/OptionsTerminal.log"
# Apps opened from Finder get a bare PATH, so add the usual homes of uv.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

alert() { osascript -e "display alert \"Options Terminal\" message \"$1\"" >/dev/null 2>&1 }
running() { curl -sf -m 1 -o /dev/null "${URL}api/ping" }

if ! running; then
  command -v uv >/dev/null || { alert "The uv tool is missing. Install it from https://docs.astral.sh/uv/ and open the app again."; exit 1 }
  cd "$PROJECT" 2>/dev/null || { alert "The project folder has moved. Run make_app.py from its new place to rebuild this app."; exit 1 }
  # The server stops by itself 15 minutes after the last browser tab is closed.
  nohup uv run server.py --no-browser --port $PORT --idle-exit 900 >> "$LOG" 2>&1 &!
  for i in {1..120}; do running && break; sleep 0.25; done
  running || { alert "The server did not start. Details are in $LOG"; exit 1 }
fi
[[ -n "$OPTIONS_TERMINAL_NO_OPEN" ]] || open "$URL"
'''


def icon_png(size=1024):
    """The app icon as PNG bytes: an amber rounded square with a black rising line, like the page icon."""
    inset, radius = size * 0.1, size * 0.2
    lo, span, mid = inset, size - 2 * inset, size / 2
    pts = [(lo + span * x / 16, lo + span * y / 16) for x, y in ((3, 11), (6, 7), (9, 9), (13, 4))]
    half = span * 0.06                                    # half the thickness of the line
    box = (min(p[0] for p in pts) - half - 1, max(p[0] for p in pts) + half + 1,
           min(p[1] for p in pts) - half - 1, max(p[1] for p in pts) + half + 1)

    def to_segment(px, py, a, b):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)))
        return math.hypot(px - a[0] - t * dx, py - a[1] - t * dy)

    rows = bytearray()
    for y in range(size):
        rows.append(0)                                    # PNG filter type for the row
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            qx, qy = abs(px - mid) - (span / 2 - radius), abs(py - mid) - (span / 2 - radius)
            outside = math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - radius
            alpha = max(0.0, min(1.0, 0.5 - outside))     # one pixel of soft edge
            if not alpha:
                rows += b"\0\0\0\0"
                continue
            ink = 0.0
            if box[0] <= px <= box[1] and box[2] <= py <= box[3]:
                ink = max(0.0, min(1.0, half + 0.5 - min(to_segment(px, py, pts[i], pts[i + 1]) for i in range(3))))
            rows += bytes((round(255 * (1 - ink)), round(176 * (1 - ink)), 0, round(alpha * 255)))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def build():
    if sys.platform != "darwin":
        sys.exit("This builds a macOS app. On other systems start it with: uv run server.py")
    if APP.exists():
        shutil.rmtree(APP)
    macos, resources = APP / "Contents" / "MacOS", APP / "Contents" / "Resources"
    macos.mkdir(parents=True)
    resources.mkdir()
    (APP / "Contents" / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleName": "Options Terminal", "CFBundleDisplayName": "Options Terminal",
        "CFBundleIdentifier": "local.options-terminal.launcher", "CFBundleVersion": "1",
        "CFBundleShortVersionString": "1.0", "CFBundlePackageType": "APPL",
        "CFBundleExecutable": "launcher", "CFBundleIconFile": "icon",
    }))
    launcher = macos / "launcher"
    launcher.write_text(LAUNCHER.replace("__PROJECT__", str(ROOT)))
    launcher.chmod(0o755)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            master, iconset = Path(tmp) / "icon.png", Path(tmp) / "icon.iconset"
            master.write_bytes(icon_png())
            iconset.mkdir()
            for n in (16, 32, 128, 256, 512):
                for scale in (1, 2):
                    out = iconset / f"icon_{n}x{n}{'@2x' if scale == 2 else ''}.png"
                    subprocess.run(["sips", "-z", str(n * scale), str(n * scale), str(master), "--out", str(out)], check=True, capture_output=True)
            subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(resources / "icon.icns")], check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"Built without a custom icon ({exc}).")
    print(f"Built {APP.name} in {ROOT}\nDouble-click it to start, or drag it to the Dock.")


if __name__ == "__main__":
    build()
