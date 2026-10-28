# Source migration record

The collection contains all implementation, tests, scripts, and public product
documentation identified by the original implementation threads. Their
inventory audits included original directories, earlier staging copies, and
surviving source archives. Runtime data and private verification material are
not source and are excluded.

## Original sources

- px0 Review: the separate `bb-plugin-px0-review` checkout in the integration
  workspace. All implementation and regression tests were copied, including
  the launch-cancellation and stale-feedback fixes. The fork's release.json
  commit and checksum pins remain unchanged.
- Mattermost: its original temporary personal-workspace directory no longer
  exists. The imported Git baseline and the archived 0.4.0 patch reconstruct
  the current source exactly; the archived partial attachment/star work is
  superseded by that completed implementation.
- GitLab and Gitea: their standalone BB meta-workspace sources and earlier
  staging sources were audited. No final implementation or tests are missing.
- Bureaucat: the final standalone 0.1.0 source is fully represented in the
  completed 0.2.0 implementation, including the original test cases and
  byte-identical official CLI release pins.

The other original source directories remain available for rollback. Each
plugin's runtime settings, databases, authentication, and downloaded binaries
remain outside this repository.

## Plugin identities

GitLab and Gitea now use `oddship-gitlab` and `oddship-gitea` as package-derived
plugin IDs and CLI names. Their source directories remain `plugins/gitlab`
and `plugins/gitea`. Collection names match the unique IDs. Local settings were
copied to the new IDs; the prior IDs were disabled without removing their
settings or caches. Gitea reads and GitLab authentication were checked after
migration. GitLab's cache is rebuilt under its new ID.

px0 Review, Mattermost, and Bureaucat keep their existing plugin IDs. All five
local installations now use the collection source directories.

## px0 fork boundary

The px0 fork remains a separate repository as required by the integration
workspace. Unreleased cookie-isolation changes in its embedding source and
tests are not part of a plugin-source migration. They require a new immutable
fork release, checksums, and an explicitly reviewed update to release.json;
existing release assets are never replaced.
