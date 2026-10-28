# Bureaucat feature research

Reviewed upstream `main` at `9ac8469` (v0.16.34) on 2026-10-28. The installed
CLI remains pinned to v0.16.33; the task command flags used here are supported by
that binary as confirmed by its help output.

## What the CLI exposes

| CLI surface | Plugin support |
| --- | --- |
| Identity and project search | Identity check; paginated project list; CLI project search |
| Assigned tasks | Full-list ID/title search, state/priority filters and sorting |
| Project task filters | Text, state/type, priority, assignee, creator and dates |
| Task detail | Direct lookup, description, labels, assignees, creator and timestamps |
| Task creation | Title, description, priority, initial state, repeated assignees and labels |
| Task updates | Title, description, priority and workflow state UUID |
| Comments | Explicit comment posting; CLI has no existing-comment read command |
| CLI login/logout | Kept CLI-owned; never proxy credentials through BB RPC |
| Server/admin commands | Deliberately not exposed by this task integration |

The CLI's `tasks.go` emits scalar query parameters (`q`, `state_type`,
`assigned_to`, `created_by`, `priority`, `from_date`, `to_date`). In the reviewed
server, `TaskHandler.resolveListFilter` reads only `f` (encoded filter tree) or
`view` (saved view), then returns an empty filter. Although the handler's
Swagger description still mentions legacy translation, its implementation does
not translate those parameters. This mismatch also affects the original
plugin's search/state controls. The plugin now enforces filters over a bounded,
complete scan instead of trusting those flags.

Assigned list responses omit labels, descriptions and timestamps; label filtering
and date sorting therefore require selecting a project.

The server accepts `sort_by` and `sort_dir`, but the CLI does not forward them.
Plugin sorting therefore occurs after a complete read and before slicing pages.
No credentials are extracted to bypass the CLI.

## Other upstream features and limits

The web/API application supports richer filter trees and saved views, due/start
dates, subtasks, relationships, attachments, projects' state/member/label catalogs,
modules and cycles. The current CLI has no commands for those reads/operations.
The plugin does not claim those capabilities or invent a command interface.
Creation-time assignments and labels work; changing them on an existing task
would require an upstream CLI addition. Existing comments likewise require a CLI
read command before they can be shown through this integration.

## Source references

- [CLI task listing/detail and filter flags](https://github.com/bureaucatorg/bureaucat/blob/9ac8469/internal/cli/tasks.go)
- [Creation state/assignee/label flags](https://github.com/bureaucatorg/bureaucat/blob/9ac8469/internal/cli/task_create.go)
- [Update fields](https://github.com/bureaucatorg/bureaucat/blob/9ac8469/internal/cli/task_update.go)
- [Assigned task pagination and response fields](https://github.com/bureaucatorg/bureaucat/blob/9ac8469/internal/cli/mytasks.go)
- [Task handler, sorting and filter resolution](https://github.com/bureaucatorg/bureaucat/blob/9ac8469/internal/handlers/tasks.go)
- [API route inventory](https://github.com/bureaucatorg/bureaucat/tree/9ac8469/internal/server)
