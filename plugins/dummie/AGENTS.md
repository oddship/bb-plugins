# Plugin development

Use the current BB plugin-authoring skill and installed SDK contracts. Keep source, tests, generic documentation and conventional commits in this repository.

Keep deployment configuration, company access instructions, live verification data, screenshots and recovery archives outside the repository or in ignored private folders. Never commit credentials, generated runtime state, private conversation exports or environment files. Use example domains and synthetic identities in tests. Review Git history as well as the working tree before publication.

After each improvement, remove temporary verification resources and verify the final state. Preserve live VMs, disks, saved recipe snapshots and recovery history. Do not reinstall or reload a live plugin unless the task requires it.

Prefer readable names and clear next actions. Explain whether an action creates a VM, sets up an existing VM or saves a recipe. Put transport and lifecycle internals under advanced details.
