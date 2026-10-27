---
name: px0-review
description: Inspect or stop px0 review tabs for BB worktrees.
---

# px0 Review

Use the thread header's “Review code with px0” button or the side-panel
“px0 Review” action. The viewer uses the exact thread environment on its host.
Select code and choose “Send to BB”, write feedback, and submit it into that
same thread. Active turns queue the feedback; the plugin never launches a
separate coding agent or changes model/account settings.

`bb px0-review status` lists active viewer processes without session secrets.
`bb px0-review stop [--thread <thread-id>]` stops a thread's viewers.
Closed tabs expire after three minutes without a heartbeat. Archiving/deleting
a thread and disabling/reloading the plugin clean up viewers and shared ports.
The viewer supports normal file edits and Git operations; it is not read-only.

Builds come from the pinned rhnvrm/px0 fork release in release.json and are
verified against its SHA-256 manifest before execution. For development only,
the “Fork binary override” setting can name an absolute binary on the workspace
host. Remote viewers require an enrolled BB Connect host and owner login.
Do not print bootstrap URLs or session cookies; they contain authentication.
