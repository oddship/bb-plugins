#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p artifacts
docker build --label app.getbb.plugin=dummie -t bb-dummie-base:local images
container_id=$(docker create --label app.getbb.plugin=dummie bb-dummie-base:local)
trap 'docker rm "$container_id" >/dev/null' EXIT
docker export "$container_id" -o artifacts/bb-base-rootfs.tar
sha256sum artifacts/bb-base-rootfs.tar > artifacts/bb-base-rootfs.tar.sha256
printf 'Candidate: artifacts/bb-base-rootfs.tar (default user ubuntu). Test boot and BB enrollment in Dummie before making it a default.\n'
