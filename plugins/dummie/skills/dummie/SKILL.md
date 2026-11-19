---
name: dummie
description: Manage remote Dummie VMs, recipes, repository access and BB machine lifecycle.
---

Use `bb dummie inventory`, `setup`, `catalog`, `diagnostics` and `inspect KEY`.
Live inventory and machine state are authoritative. Open the manager at `/plugins/dummie/machines`.

## Remote connections

Use Settings and Remotes for named connections. Each remote has separate credentials, transport, defaults and a Connect through execution machine. API calls and SSH use that machine; key paths are interpreted there. An unavailable selected machine never falls back. New setup records pin the machine, while legacy records follow their original remote's setting. Lifecycle actions follow the resource's pinned origin, independently of the selected remote. Obtain connection details and verified fingerprints from the operator.

Tokens belong in secret BB settings. Never print saved credential profiles, tokens, private environment files or enrollment bundles. Use token-free connection RPCs for status. Add another remote to change addresses without altering existing machine ownership.

## Recipes and recovery

Use the recipe selected for the task. Review machine defaults and repository integration permissions before creating a VM. Setup scripts run as the guest user; use sudo where required. Do not put credentials in recipes.

Inspect setup logs before retrying failed or interrupted setup. Reuse existing allocations and pinned recipe snapshots for recovery. Preserve user resources unless removal was requested. Removing a VM also retires its BB machine.

## Working inside a VM

Read access guides provided by the selected recipe, including ACCESS.md files under ~/.local/share/bb-dummie, before repository work. Deployment-specific repository addresses and network routes belong in those private guides.

Verify repository Git access separately from API access. Keep TLS verification enabled. Do not copy credentials from another machine or move implementation work out of the requested VM without authorization. Keep project files in the workspace or home directory.

## Network blocks

Inspect network status and denied destinations before changing access. Grant only the observed destination and required protocol for the task. Use temporary rules and revoke only grants created for that work. A timeout with no matching denial may require routing or service investigation rather than another allowance.

## Cleanup

Remove temporary probes, verification files and task-created grants after use. Keep live VM state, saved recipes, allocation ownership and recovery history. Store deployment notes and live evidence outside the shareable plugin repository.
