# Dummie

Create and manage Dummie virtual machines from BB. Connect a remote control
service, select a setup recipe, and create a workspace or enroll an existing VM.
Inspect setup progress, recover interrupted enrollment and manage VM lifecycle.

Each remote can use its own execution machine for API and SSH access. Connection
credentials stay in secret BB settings. The configured SSH fingerprint is checked
before authentication, and existing setups retain their pinned connection.

Requires access to a Dummie deployment and its operator-provided connection
details. VM creation and deletion change remote resources; review the selected
remote, recipe and confirmation before proceeding.
