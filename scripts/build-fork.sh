#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "${1:?Usage: build-fork.sh /path/to/fork}" && pwd)"
plugin_dir="$(cd "$(dirname "$0")/.." && pwd)"
artifact_dir="$plugin_dir/release-artifacts"
mkdir -p "$artifact_dir"
node "$source_dir/scripts/build-web.js"
for target in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64; do
  target_os="${target%-*}"
  target_arch="${target#*-}"
  suffix=""
  if [ "$target_os" = windows ]; then suffix=.exe; fi
  (cd "$source_dir" && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build -trimpath -ldflags="-s -w" -o "$artifact_dir/px0-$target$suffix" .)
done
python3 - "$source_dir" "$plugin_dir" <<'PYTHON'
import hashlib,json,pathlib,subprocess,sys
source,plugin=map(pathlib.Path,sys.argv[1:])
artifacts=plugin/'release-artifacts'
release={'repository':'rhnvrm/px0','tag':'v'+(source/'VERSION').read_text().strip(),'commit':subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip(),'assets':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(artifacts.glob('px0-*'))}}
(plugin/'release.json').write_text(json.dumps(release,indent=2)+'\n')
(artifacts/'SHA256SUMS').write_text(''.join(f'{sha}  {name}\n' for name,sha in release['assets'].items()))
print('Verified fork release manifest:',release['tag'],release['commit'])
PYTHON
