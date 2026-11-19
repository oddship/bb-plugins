# BB Top

A live view of CPU and resident memory usage by BB thread. Pick an enrolled
machine, sort by CPU, memory or process count, filter threads, and expand a row
to see its processes. Open a thread directly from the row. Pause freezes the
view, and switching machines clears the previous readings.

The dashboard refreshes every two seconds while visible and keeps 60 recent
readings in browser memory. The host collector shares concurrent requests and
caches readings for two seconds. There is no persistent history or background
sampler, and no process-killing control.

## Usage

Open **BB Top** in BB navigation at `/plugins/top/monitor`.

`bb top status --machine <id-or-name>` prints a snapshot. Add `--json` for
structured output. Machine selection is required when several are connected.
The browser remembers its own machine selection.

## Measurement

Linux only, with `/proc` and `getconf`. CPU uses process CPU-time deltas and
checks process start times to reject recycled PIDs. The first sample warms up
the counters. Thread CPU uses 100% per logical core; machine CPU uses 100% for
the whole machine. A newly observed process needs another sample for CPU.

Memory is resident set size (RSS), summed over a thread's processes. Shared
pages may be counted more than once. Machine memory uses MemAvailable and
MemTotal, which can describe the underlying host rather than a container's
limits. These figures do not measure remote model inference or GPU use.

Ownership comes from each process's `BB_THREAD_ID`, then the nearest parent
with an owner. Untagged Codex runtimes are also matched through open session
writer-lock filenames and BB's recorded provider-session identities. Session
contents are not read. A process matching multiple BB threads remains
unattributed because its resources cannot be split reliably.
A workspace path is not used because several threads can share
one checkout. Unclaimed processes remain outside the thread total. Provider
launch behavior means some agent runtimes and shared services cannot
be assigned to a thread. This is a view of attributable work processes, rather
than a complete accounting of every resource BB uses. Permissions
and PID namespaces constrain visibility, and the view reports inaccessible or
exited reads. Process names are Linux comm names, which may be shortened.
Command arguments and environment values stay out of RPC and CLI results.

Collection caps the process scan at 100,000 and the thread list at 1,000.
Process details show up to 100 per thread and 5,000 overall; thread totals
include processes omitted from the detail view. Truncation is reported.

## Development

Run `npm ci --include=dev --legacy-peer-deps`, `npm run typecheck`, `npm test`,
and `bb plugin build`. Install this folder on the BB server with
`bb plugin install . --yes`, or reload updates with `bb plugin reload top`.
The manifest includes a host entry so collection runs on the chosen execution
machine, independently of the BB server. Disable with `bb plugin disable top`.

## References

Reviewed [Hotspot](https://github.com/Hazihell/bb-plugin-hotspot) for environment
and parent-process attribution and CPU sampling, and
[Ballast](https://github.com/braedonsaunders/bb-plugin-ballast) for memory
reporting and process grouping. BB Top has its own implementation and uses the
current BB scaffold and public SDK. It does not require either reference plugin.

## Collection install

```sh
bb plugin install git:https://github.com/oddship/bb-plugins.git@^0.1.2 --plugin top --tag-prefix top/
```

The truncation flag also reports omitted process details while thread totals
continue to include those processes.
