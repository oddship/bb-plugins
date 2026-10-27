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

BB Community listings are reviewed in
[get-bb/marketplace](https://github.com/get-bb/marketplace). Publishing a release
here makes it installable directly; appearing in Community requires a merged
marketplace entry.

## Development

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
