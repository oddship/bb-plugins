# Oddship BB plugins

BB plugins maintained by [Oddship](https://github.com/oddship).
Each plugin has its own directory, package manifest, and release tags.

## px0 Review

[px0 Review](plugins/px0-review) opens the active worktree in a BB side panel.
Browse files and diffs, edit files, and send selected-code feedback to the
existing thread.

Install the released plugin:

```sh
bb plugin install git:https://github.com/oddship/bb-plugins.git@^0.1.0 --plugin px0-review --tag-prefix px0-review/
```

## Mattermost

[Mattermost](plugins/mattermost) brings cached conversations into BB. Search
messages, link conversations to threads, quote messages into a draft, and
prepare agent tasks. Preview attachments and keep personal starred and pinned
conversations. Requires the `mm` CLI, an authenticated Mattermost
account, and a configured BB host.

```sh
bb plugin install git:https://github.com/oddship/bb-plugins.git@^0.4.0 --plugin mattermost --tag-prefix mattermost/
```

## GitLab CLI

[GitLab](plugins/gitlab) browses GitLab issues and merge requests using an
existing authenticated `glab` CLI on the BB server.

## Gitea CLI

[Gitea](plugins/gitea) browses repositories, issues, and pull requests using
an existing authenticated `tea` CLI on a BB host. Its plugin ID and CLI
are `oddship-gitea`.

## Bureaucat

[Bureaucat](plugins/bureaucat) browses, sorts, and filters tasks through the
`bcat` CLI. Inspect task details, edit task fields, post comments, and prepare
agent drafts. Configure your Bureaucat service URL and authenticate the CLI
on the selected BB host. Version 0.2.0 is validated and installed locally.

BB Community listings are reviewed in
[get-bb/marketplace](https://github.com/get-bb/marketplace). Publishing a release
here makes it installable directly; appearing in Community requires a merged
marketplace entry.

## Development

Use Node.js 24 LTS (see `.node-version`) and npm.

```sh
cd plugins/px0-review
npm ci
npm run check
npm test
bb plugin build
```

The existing local path installation can continue using its original checkout.
This repository does not move the px0 fork or runtime data. The pinned fork
release and SHA-256 digests stay in the plugin's `release.json`.

## Adding a plugin

Create `plugins/<name>/` with its own `package.json`, README, overview, and
skills. Add the directory to `.bb/plugins.json`. Validate it and publish an
immutable `<name>/vX.Y.Z` tag. Each marketplace entry uses this repository,
`subdir: plugins/<name>`, and `tagPrefix: <name>/` with a compatible version
range. See [CONTRIBUTING.md](CONTRIBUTING.md) for the release process.

## Source completeness and walkthroughs

[MIGRATION.md](MIGRATION.md) records the original-thread completeness audits,
identity changes, and preserved fork boundary. Every plugin README includes a
three-step animated walkthrough. Marketplace copies use animated WebP and JPEG
stills; README copies also include GIF. Service demos use sample data in the
real installed frontend and block external writes. See the
[capture notes](scripts/MARKETPLACE_CAPTURES.md).
