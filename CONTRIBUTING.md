# Development and releases

Each directory under `plugins/` is a standalone BB plugin. Work inside the
affected directory and use its committed lockfile.

Before releasing, run `npm ci`, `npm run check`, `npm test`, and
`bb plugin build`. Inspect the files in the release commit for private data.
Keep generated bundles and dependencies out of Git; BB builds Git installs.

Update the plugin package version and lockfile together. Commit the reviewed
source, then create a plugin-specific tag such as `px0-review/v0.1.0`. Never
move a published tag. Create a new patch version for a fix.

A Community marketplace entry points to
`https://github.com/oddship/bb-plugins.git`, the plugin directory, its semantic
version range, and its `<name>/` tag prefix. Store screenshots and listing
artwork in the plugin directory and vendor them into the marketplace PR.
Copy `PLUGIN_OVERVIEW.md` into the marketplace's `overview/` directory.

A compatible release within the listing's range requires no catalog change.
Source, branding, listing text, screenshots, tag prefix, and range changes
require a marketplace PR. A maintainer must merge that PR before Community
users can discover the plugin.
