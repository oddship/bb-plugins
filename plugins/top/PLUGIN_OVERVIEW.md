BB Top shows which threads are using CPU and memory on an enrolled Linux machine.

Choose a machine, sort or filter the thread list, and expand a row for process
names, PIDs and resource usage. Pause freezes the readings. Open a thread from
its process details to return to the work behind it.

The dashboard refreshes every two seconds while visible. `bb top status
--machine <id-or-name>` reads the same data from a terminal; add `--json` for
structured output. The first sample initializes CPU counters.

Thread ownership follows process thread identifiers and parent processes.
Codex agents without a thread identifier match their open session writer-lock
filenames to BB's recorded session identities.
Some agent runtimes and shared services cannot be assigned. Resident memory
can count shared pages more than once. Permissions and container namespaces
limit what the collector can see. Machine totals may reflect the underlying OS.

There are no process controls, background sampler, stored history, credentials
or external monitoring service.
