# LogChef for BB

Browse LogChef teams and sources, inspect source schemas and saved queries, and
search logs from a BB page or thread panel. The plugin runs the official LogChef
CLI on a selected execution machine, using its existing login and network access.

## Setup

Use Node.js 24 LTS and npm for development:

```sh
npm ci --include=dev --legacy-peer-deps
npm run typecheck
npm test
bb plugin build
bb plugin install .
```

Install LogChef CLI on the execution machine. To use the pinned official release
from this checkout, run `python3 scripts/install-cli.py`. It verifies the release
archive against `release.json`, then writes only the executable to ignored
`bin/logchef`. Set the plugin's advanced `binaryPath` to that absolute path on
the execution machine. An existing CLI on PATH works with the default setting.
The installer supports Linux and macOS on x86_64 and ARM64. It does not alter
other executables or authentication state.

Authenticate using the CLI's `logchef auth --server <your-logchef-url>` command
on that machine if it has no existing login. Credentials remain CLI-owned;
the plugin never reads its config file or accepts tokens in RPC or CLI inputs.

Open **LogChef** in BB navigation, select an execution machine, and optionally
apply a saved CLI context. Choose a team and source, enter a LogChefQL filter,
and click **Run query**. **Schema** and **Saved queries** inspect the source.
The context field applies to that open view. The plugin's context setting
provides the default for pages, CLI and tools. Machine selection is saved for
all surfaces. **Reconnect** reloads the machine list and saved settings.

Inside a thread, add the **LogChef** panel to quote full logs into the current
draft. Quoting adds source information and labels log content as untrusted.
It never submits the draft. The navigation page can copy query results as JSON.

## Commands and agent tool

```sh
# Replace the example identifiers with IDs returned by discovery.
TEAM_ID=1
SOURCE_ID=2
bb logchef teams --json
bb logchef sources --team "$TEAM_ID" --json
bb logchef schema --team "$TEAM_ID" --source "$SOURCE_ID" --json
bb logchef collections --team "$TEAM_ID" --source "$SOURCE_ID" --json
bb logchef query 'level="error"' --team "$TEAM_ID" --source "$SOURCE_ID" --since 1h --limit 50 --json
bb logchef query '' --team "$TEAM_ID" --source "$SOURCE_ID" --from 2026-11-19T00:00:00Z --to 2026-11-19T01:00:00Z --json
```

All commands accept `--machine <id-or-name>` and `--context <name>`. Overrides
apply only to that invocation. The `logchef_read` agent tool exposes the same
operations with a validated action schema. Discovery returns `rows`; queries
return `logs`, `count`, `stats`, `generatedSql` and `truncated`.

## Bounds and lifecycle

Queries return at most 500 logs, default to 100, and use a 15-minute lookback
unless overridden. Processes have a 45-second deadline and a 768 KiB output
buffer. Responses fit within 480 KiB; oversized query results drop trailing
rows and set `truncated`. Discovery lists contain at most 1,000 entries.
Use narrower queries if a response exceeds these limits. Displayed counts are
returned rows, not a count of every match in LogChef.

The plugin exposes reads and LogChefQL searches. It does not execute saved
collections, raw SQL, follow logs continuously, or modify LogChef records.
The CLI can refresh its own tokens and lookup caches. No log results are stored
in BB plugin storage. CLI errors return a diagnostic message without forwarding
stderr, which can contain service details. Run the CLI on the selected machine
for authentication or query error details.

Changing machine, context, team or source clears prior results. Late responses
from an old selection are ignored. Plugin disposal aborts active host calls.
There are no background services or scheduled queries. A selected offline
machine produces an error without falling back to another machine.

## Maintenance

Run typechecking, the tests and `bb plugin build` before reload or release.
The tests cover command argument isolation, Unicode output bounds, machine
routing, CLI and tool contracts, selection changes and quoting into drafts.
Use the current BB SDK declarations as the API contract.

Update `release.json` only to a new immutable official CLI release, checking
each archive's published SHA-256 digest. Do not replace an existing release asset.
Disable with `bb plugin disable logchef`; this preserves the CLI login and
source checkout. Releases use independent `logchef/vX.Y.Z` tags.
