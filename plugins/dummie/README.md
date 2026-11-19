# Dummie for BB

Manage remote Dummie VMs, reusable setup recipes and BB enrollment. Plugin ID: `dummie`.

## Connect a remote

Open Dummie in BB, then Settings and Remotes. Add the remote's HTTPS control origin, personal access token, SSH proxy address and verified SSH fingerprint. Save machine defaults using that remote's host, kernel and image catalog. Multiple named remotes are supported.

Choose **Connect through** for each remote. Work remotes can use a laptop with
private network access while public remotes use another enrolled machine. The
selected machine performs control API requests and SSH connections; SSH key
paths and agents are resolved there. OpenSSH (`ssh` and `ssh-keyscan`) is required
on an enrolled execution machine. BB verifies the configured proxy fingerprint
before authentication. An unavailable selected machine produces an error without
falling back. Choosing **BB server** retains direct server execution.

New setup records pin the execution machine along with their SSH transport.
Changing a remote affects future setups; existing pinned machines keep their
route. Older records without a pinned machine use their original remote's
current execution setting. The setting does not move an enrolled VM or its
checkouts between BB machines.

Credentials belong in secret BB settings. Obtain connection details and fingerprints from your Dummie operator. This repository does not include a deployment configuration.

## Create a workspace

Choose a setup recipe in New Thread or the Dummie manager. The included BB recipe installs enrollment prerequisites; custom recipes can add tools, scripts, machine defaults and repository integrations. Review repository permissions before attaching an integration. Credentials remain with Dummie.

Recipes are versioned. Creating a VM pins its recipe and connection so recovery can reuse the allocation. Changing a saved recipe affects future launches. Existing VM enrollment is also supported after identity and prerequisite checks.

Use the manager to inspect setup logs, retry interrupted setup, start or stop VMs and remove them. Removal also retires the associated BB machine. Review the confirmation before deleting a VM and its disk.

## Network and repository access

Inspect denied destinations before requesting temporary access. Add narrow, time-limited rules for the observed destination and remove them when the task is finished. A connection timeout without a matching denial can indicate routing or service trouble.

Repository integrations depend on the remote deployment. Verify Git access separately from API access. Keep TLS verification enabled. Read any access guide installed by the selected recipe before repository work.

## Local configuration

Keep deployment recipes, infrastructure notes, access guides, verification output and screenshots outside this repository or under the ignored `.private/` directory. Never commit credentials or live runtime state. `.runtime/`, `verification/`, build output and environment files are ignored.

## Development

Install dependencies with `npm ci`. Run `npm test`, `npm run check` and `npm run build`. The build uses the BB CLI and installed Plugin SDK. Do not reinstall or reload a live plugin solely to verify documentation changes.

The source includes unit and SDK harness tests for VM ownership, allocation recovery, recipes, repository integration attachment, network access and enrollment. Keep test fixtures synthetic and use example domains.

## Collection install

```sh
bb plugin install git:https://github.com/oddship/bb-plugins.git@^0.7.0 --plugin dummie --tag-prefix dummie/
```

The public source contains no deployment recipes or private connection state.
Configure connections in BB after installation.
