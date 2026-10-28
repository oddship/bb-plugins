#!/usr/bin/env python3
"""Install the pinned official Bureaucat executable without reading credentials."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import tarfile
import tempfile
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--destination', required=True, type=Path, help='Executable path inside BB plugin-owned host storage')
args = parser.parse_args()
executable_path = args.destination.expanduser().resolve()
destination = executable_path.parent
destination.mkdir(parents=True, exist_ok=True)
root = Path(__file__).resolve().parent.parent
release = json.loads((root / 'release.json').read_text())
operating_system = {'Linux': 'linux', 'Darwin': 'darwin'}.get(platform.system())
architecture = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
asset_name = f'bureaucat_{operating_system}_{architecture}.tar.gz'
expected = release['assets'].get(asset_name)
if not expected:
    raise SystemExit(f'Unsupported platform: {platform.system()} {platform.machine()}')
url = f"https://github.com/bureaucatorg/bureaucat/releases/download/{release['tag']}/{asset_name}"
with urllib.request.urlopen(url, timeout=120) as response:
    archive = response.read(128 * 1024 * 1024 + 1)
if len(archive) > 128 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != expected:
    raise SystemExit('Release archive exceeds size limit or failed SHA-256 verification')
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    entry = tar.getmember('bureaucat')
    if not entry.isfile() or entry.size > 256 * 1024 * 1024:
        raise SystemExit('Unexpected executable in release archive')
    executable = tar.extractfile(entry).read()

fd, temporary = tempfile.mkstemp(prefix='.bcat-', dir=destination)
try:
    with os.fdopen(fd, 'wb') as output:
        output.write(executable)
        os.fchmod(output.fileno(), 0o755)
    os.replace(temporary, executable_path)
finally:
    Path(temporary).unlink(missing_ok=True)
print(f"Installed {release['tag']} to {executable_path} (SHA-256 verified)")
