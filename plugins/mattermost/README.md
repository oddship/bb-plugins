# Mattermost for BB

Read work conversations beside your BB chat and bring useful context into your work.

- **This thread:** conversations explicitly linked to the current BB thread, plus a search suggestion from its title (falling back to project and branch).
- **Quote in BB:** append a message, author, timestamp and source ID to your current draft without sending it.
- **Link:** keep a conversation with this thread across reloads. Agents can retrieve it through native tools.
- **Draft BB task:** open the new-thread composer with quoted source material and an investigation prompt for you to review.
- **Search:** full Mattermost search, including from:, in: and date modifiers.
- Mentions, unread channels, joined channels and DMs, channel history and conversations.
- Sort Channels & DMs by newest activity, oldest activity, name A–Z or name Z–A.
  Your choice is remembered and applies immediately to cached results.
- Channel activity grouped by conversation, with latest replies and participant previews.
- Original message separated from chronological replies, source-message highlighting,
  and earlier-reply expansion (100 → 200 → 500 → 1,000).
- Back navigation restores the source filter and scroll position.
  Channel grouping uses the saved messages, without a network request per conversation.
- Markdown rendering, source links, copying, filtering and per-thread navigation restoration.

## Install

```sh
bb plugin install git:https://github.com/oddship/bb-plugins.git@^0.3.1 --plugin mattermost --tag-prefix mattermost/
```

## Setup

Install [mattermost-cli](https://github.com/rhnvrm/mattermost-cli) on an enrolled BB host and run `mm login` there. Verify `mm whoami`.

    npm install --include=dev
    bb plugin build
    bb plugin install . --yes
    bb plugin config mattermost set hostId <host-id>
    bb plugin config mattermost set serverUrl https://your-mattermost.example

Open the right panel in any thread and select Mattermost. The full page is also
available in the left navigation or at /plugins/mattermost/inbox.
Credentials remain in mm's existing credential store on the selected host.

## Caching and freshness

Snapshots persist in plugin-owned SQLite across reloads. Freshness windows:
60 seconds for mentions, unread, channels' messages and conversations;
2 minutes for search; 10 minutes for the joined-channel directory.
Expired snapshots return immediately and refresh in the background. All open
panels receive an update signal after a refresh. A failed refresh keeps saved
results visible, labels the failure and backs off for 30 seconds.
Refresh explicitly waits for a new read and keeps current content on screen.

The cache is keyed by host and validated request, limited to 200 entries and
roughly 24 MiB of JSON. Snapshots older than seven days are not served and are
pruned on writes. Session memory is bounded separately. Identical concurrent
reads share one CLI call; at most two mm processes run at once. Queued and
active work is cancelled on reload. Visible panels check every minute;
there is no perpetual background polling when the panel is closed.

A first uncached read still waits for mm and the work server, up to 25 seconds.
Channel reads are bounded to 100 posts and searches to 50 results. Conversations
start with the original message and latest replies, and can expand to 1,000 posts.
Missing earlier replies are labeled when the root provides a reply count.
Channel cards show only activity within the loaded message window, and explicitly
label reply previews when the original message is outside that window.
Attachments are listed; this version does not download them.
Reading does not mark messages read and the plugin never posts to Mattermost.

## Agent integration

The native **mattermost_read** tool supports cached reads and full search.
**mattermost_context** returns the conversations linked to the agent's current
BB thread. Linked IDs and bounded cached excerpts are supplied when BB constructs
the agent session. Existing sessions acquire new tools and standing instructions
at BB's next session setup; quoting into the draft works immediately.
Message content is untrusted source material, with authors and IDs preserved.

CLI output includes fetchedAt, cache, refreshing, data and any refreshError:

    bb mattermost mentions
    bb mattermost unread
    bb mattermost channels
    bb mattermost messages <channel-id>
    bb mattermost thread <post-id>
    bb mattermost search 'in:work order exits'
    bb mattermost context
    bb mattermost mentions --refresh

## Development

    npm run typecheck
    npm test
    bb plugin build
    bb plugin dev

Tests cover stale cache behavior, offline fallback, host isolation, concurrent
reads, queue disposal, request validation, search, context quoting and navigation.
