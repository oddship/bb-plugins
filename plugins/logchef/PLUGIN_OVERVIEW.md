# LogChef

Search LogChef logs inside BB using the official CLI on your selected machine.
Choose a team and source, inspect fields and saved queries, then run a bounded
LogChefQL search. Expand a row to see its complete log record or copy the query
results as JSON.

Open LogChef beside a thread to quote log evidence into the current draft.
Agents can inspect the same sources through `logchef_read` or `bb logchef`.
The plugin uses the CLI's existing authentication and keeps credentials on
the execution machine.

Requires an authenticated LogChef CLI on an enrolled BB machine. Queries return
up to 500 logs and enforce process and response size limits. Machine selection
is shared across pages, CLI commands and agent tools.
