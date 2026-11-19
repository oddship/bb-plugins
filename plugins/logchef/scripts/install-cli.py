#!/usr/bin/env python3
"""Install the pinned official LogChef CLI into this checkout's ignored bin/."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import tarfile
import tempfile
import urllib.request

root = Path(__file__).resolve().parent.parent
release = json.loads((root / 'release.json').read_text())
system = {'Linux': 'linux', 'Darwin': 'macos'}.get(platform.system())
arch = {'x86_64': 'x86_64', 'arm64': 'aarch64', 'aarch64': 'aarch64'}.get(platform.machine())
key = f'{system}-{arch}' + ('-musl' if system == 'linux' else '')
if key not in release['assets']:
    raise SystemExit('No pinned CLI for this platform. Install LogChef manually and configure binaryPath.')
asset = release['assets'][key]
with urllib.request.urlopen(asset['url'], timeout=60) as response:
    archive = response.read(64 * 1024 * 1024 + 1)
if len(archive) > 64 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != asset['sha256']:
    raise SystemExit('CLI archive size or SHA-256 verification failed.')
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
    member = next((m for m in tar.getmembers() if m.isfile() and Path(m.name).name == 'logchef'), None)
    if member is None or member.size > 128 * 1024 * 1024:
        raise SystemExit('CLI executable missing or too large.')
    binary = tar.extractfile(member).read()
folder = root / 'bin'
folder.mkdir(exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix='.logchef-', dir=folder)
try:
    with os.fdopen(fd, 'wb') as out:
        out.write(binary)
        os.fchmod(out.fileno(), 0o755)
    os.replace(temporary, folder / 'logchef')
finally:
    Path(temporary).unlink(missing_ok=True)
print(f"Installed {release['tag']} to {folder / 'logchef'}")
