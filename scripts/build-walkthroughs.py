#!/usr/bin/env python3
"""Build animations from reviewed real-UI capture frames (requires ImageMagick)."""
from pathlib import Path
import json
import subprocess

root = Path(__file__).resolve().parents[1]
report = []
for name in ["px0-review", "mattermost", "gitlab", "gitea", "bureaucat"]:
    directory = root / "plugins" / name / "screenshots"
    frames = [str(directory / f"step-{n}.jpg") for n in range(1, 4)]
    subprocess.run(["magick", "-delay", "220", *frames, "-loop", "0",
                    "-quality", "82", str(directory / "walkthrough.webp")], check=True)
    subprocess.run(["magick", "-delay", "220", *frames, "-loop", "0",
                    "-colors", "128", "-layers", "Optimize",
                    str(directory / "walkthrough.gif")], check=True)
    for path in [directory / f"step-{n}.jpg" for n in range(1, 4)] + [directory / "walkthrough.webp", directory / "walkthrough.gif"]:
        dimensions = subprocess.check_output(["magick", "identify", "-format", "%w %h", str(path) + "[0]"], text=True)
        width, height = map(int, dimensions.split())
        assert width >= 1200 and path.stat().st_size <= 2 * 1024 * 1024, path
        report.append({"plugin": name, "path": str(path.relative_to(root)),
                       "width": width, "height": height, "bytes": path.stat().st_size})
print(json.dumps(report, indent=2))
