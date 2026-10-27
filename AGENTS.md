# Oddship BB plugins

Keep each plugin in `plugins/<name>/` with its own package manifest, overview,
skills, and release tags. Index plugins in `.bb/plugins.json`.

Read the affected plugin README before changing it. Run its checks and tests,
then `bb plugin build` before release or reload. Release plugins independently
with immutable `<name>/vX.Y.Z` tags and matching package versions.

Keep px0 fork revisions and SHA-256 digests pinned in `release.json`. Never
replace existing fork release assets. Keep runtime downloads and state in BB
plugin storage. Never commit session tokens, cookies, credentials, or local
runtime state. Preserve the separately maintained px0 fork.
