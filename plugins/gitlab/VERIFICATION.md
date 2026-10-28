# Verification

The GitLab plugin is version 0.1.0 and targets BB 0.47+ with Plugin SDK 0.6.79+.
Its source was migrated into the collection without changing the implementation.
The original standalone checkout remains intact for rollback.

## Checks

Run from this plugin directory:

- `npm ci`
- `npm run check`
- `npm test`
- `bb plugin build`

The automated suite covers repository identity and nested paths, glab argument
and JSON body encoding, response normalization, executable/cancellation errors,
SQLite cache behavior, failed-sync retention, validated RPC/CLI input, agent
thread creation, composer mentions, service disposal, public SDK use, and React
list/detail, comment, issue creation, and agent navigation behavior.

## Live verification scope

The original installation was tested against an authenticated GitLab instance:
CLI authentication, cache sync, issue and merge-request reads, and real BB browser
rendering of lists and details, Markdown descriptions, branches and pipeline
status. Live verification did not change GitLab records or start agent threads;
write operations and agent spawning were tested through mocked transport and BB's
official SDK harness.

Local reports, repository names, account details, credentials and screenshots
are deliberately excluded from this collection. Runtime configuration and caches
remain in BB plugin storage; glab retains ownership of its authentication.

Choose a matching BB project in plugin settings before using agent actions on
repositories without an attached project. See README.md for other operating
constraints and cache bounds.

## Collection migration checks — 2026-10-28

A fresh `npm ci`, strict typecheck, all 19 tests, and `bb plugin build` passed
from this collection directory. The local path registration was changed to this
copy; the plugin is running, existing settings were preserved exactly, and its
live authentication check passed. The original standalone source remains intact.

The collection toolchain now uses Vitest 4.1.12 on Node.js 24 LTS. Strict
typechecking, all 19 tests, and the production build pass after the identity
change. A fresh full `npm audit` reports zero advisories, including development
dependencies. The earlier Vitest/mocker/Tinypool advisories were removed by this
validated toolchain update.
