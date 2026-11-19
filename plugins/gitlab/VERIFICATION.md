# Verification

Version 0.2.1 targets BB 0.47+ and Plugin SDK 0.6.79+.

Strict TypeScript checking, all 24 tests and `bb plugin build` pass on Node.js
24 LTS. The build includes server, app and execution-host bundles.

The suite covers repository identity, glab argument and JSON-body encoding,
response normalization, cancellation, SQLite caching, failed-sync retention,
RPC and CLI validation, agent actions and public SDK boundaries. Host-routing
tests verify the selected machine, cache clearing and disconnected-machine
errors. Frontend tests cover list/detail navigation, writes, account changes,
stale status responses and preventing machine switches during pending writes.

Live authentication, synchronization and item reads were previously verified
on an existing installation. Publication review used synthetic fixtures and did
not write GitLab records or start agent threads. Deployment addresses, account
details, runtime caches and live screenshots are excluded from this repository.

See README.md for setup, operating limits and maintenance.
