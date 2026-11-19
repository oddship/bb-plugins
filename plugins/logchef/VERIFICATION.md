# Verification

Checked against BB 0.47.1, Plugin SDK 0.6.79 and official LogChef CLI 0.4.0.

- Strict TypeScript checking passes.
- All 19 tests pass under Node.js 24.13.0. The SDK backend and frontend
  harnesses cover machine and context routing, disconnected machines, bounded
  query arguments and output, schema failures, stale responses and quoting
  into drafts without submission.
- `bb plugin build` produces valid server, app and host bundles. Building with
  only production dependencies also passes.
- Live reads through the installed plugin passed for team and source discovery,
  source schemas, saved queries and bounded log searches.
- The desktop browser trial passed team and source selection, a filtered search,
  full-log expansion, schema inspection and the saved-query view. Returned logs
  matched the selected filter and respected the requested row limit.
- The installer verifies the official release archive's SHA-256 digest and
  installs its executable. The installed binary reports `logchef 0.4.0`.

The live checks used an existing CLI login and read-only searches. Draft quoting
is covered by the SDK frontend harness; the trial did not edit a live user draft.
Temporary raw query results and owned browser sessions were removed after the
checks. Runtime configuration, credentials, service names and log contents are
excluded from this repository.

See README.md for setup, operating limits and maintenance.
