# Marketplace walkthrough captures

These walkthroughs show the actual installed plugin frontend inside BB, driven
with the Browser Automation plugin. No mockup UI is drawn. The four service
integrations use deterministic, browser-only RPC fixtures with sample website
release work; every frame is visibly labeled **DEMO DATA · NO LIVE RECORDS**.
This avoids disclosing account names, server URLs, work messages, and tasks.
The fixture layer rejects unknown operations and never sends service writes.
It changes neither plugin configuration nor server-side records. px0 captures
use the actual local source viewer and do not submit feedback.

For the service integrations, start a local headless browser on the BB host,
open BB, and run `scripts/marketplace-demo.js` with
`bb browser-automation run <session> --script-file <absolute-script-path>
--script-host <host-id> --json`. Navigate with the real controls, collapse the
thread sidebar, and capture each step after the UI settles. Update the caption
through `#oddship-capture-step`. The browser-only layer disappears when the
page/session closes. Verify every screenshot before adding it to Git.

Each plugin's screenshots directory contains three JPEG walkthrough steps,
an animated WebP for the marketplace, and a GIF for README-compatible viewers.
The marketplace accepts PNG, JPEG, and WebP, not GIF. Catalog entries reference
only supported image formats. Images must be at least 1200 pixels wide and
under 2 MiB each. The animation is built from those same reviewed frames.

The fixture source is public sample data, not a saved service response or
credential/configuration snapshot. Keep private captures and runtime data out
of the repository. See `MIGRATION.md` for the source-completeness record.
