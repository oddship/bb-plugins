---
name: top
description: Read CPU and resident memory usage grouped by BB thread on a selected Linux machine.
---

# BB Top

Use `bb top status --machine <id-or-name>` for a resource snapshot, or add
`--json` for structured output. Use `bb machine list` to find machine names.
When only one machine is connected, `--machine` can be omitted.

CPU is a delta between samples, where 100% means one logical core. The first
reading initializes counters; sample again after two seconds. Machine CPU is
normalized over all logical cores. Memory is summed resident memory (RSS),
which may count shared pages more than once. Thread ownership uses
`BB_THREAD_ID` from the process environment and nearest parent ancestry.
Untagged Codex runtimes also match open session writer-lock filenames to BB's
recorded provider-session identities. Processes matching multiple BB threads
remain unattributed. Session contents are not read.
Processes without that evidence are left unattributed. Shared workspaces are
not enough to identify a thread.
Some agent runtimes and shared services do not carry a thread identifier and
remain unattributed. Do not present the thread total as all resources used by BB.

Open BB Top in navigation for the live dashboard. Pick a machine, sort or filter
threads, and unfold a thread for process names, PIDs, CPU and memory. Pause freezes
the view. Polling stops while the page is hidden. The selected machine is remembered
in the browser. The page keeps the latest 60 readings in memory only.

Supports Linux with `/proc` and `getconf`. Visibility depends on the daemon user,
permissions and PID namespace. Container machine totals may reflect the host OS;
they are not container memory limits. Inaccessible or exited reads are counted.
Collection is on demand, cached for two seconds, with no background service,
stored history, process controls, account, or external service. Process arguments
and environment values are not returned by any surface.
