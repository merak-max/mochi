# Memory repository

Mochi's rewindable pi-durable MemoryDoc owns its typed notes. A separate local Git repository publishes every saved edit as an individual commit. Reads, prompts, recall, and historical recall use the durable notes, including when Git publication is blocked.

The default production path is `<dataDir>/memory`. Library callers can omit `MochiOptions.memory` to leave Git publication off. Mochi creates a standalone SHA-1 repository with an attached `main` branch. It runs no remote commands, pushes, hooks, signing, or Git filters.

## Files and retrieval

`MEMORY.md` contains the always-needed user and rule entries and an `## Index`. Other kinds have a `[[kind/slug]]` link to `kind/slug.md`. Each note body is one bullet with bracketed source and added metadata. Newlines, quotes, and backslashes use JSON string escaping without the surrounding quotes, so multiline bodies remain lossless. Added metadata uses the note's persisted update date, not a file timestamp.

The existing `owner` and `notes-index` prompt sections retain their keys and budgets. `recall` searches current durable notes and returns their full bodies. Links represent those same typed notes. Mochi does not advertise or retrieve arbitrary external files, SQL, scripts, or binary content.

## Publication and recovery

A note edit and its exact publication snapshot commit together in SQLite. Publication snapshots are removed after acceptance. Operation receipts remain available for replay of old tool tasks. Safe tool replay uses a persisted operation receipt. Replaying an earlier operation returns its earlier result without replacing a later note.

A native background task in a separate ownerless conversation publishes the ordered queue. Root stop commands cannot abort it. Before Git effects, it persists the expected branch, parent commit, exact file bytes, Git objects, and deterministic target commit. Git effects happen outside the SQLite transaction. Ref publication uses compare-and-swap. After restart, a pending operation accepts only its proven parent or target state. It repairs owned files only when their bytes equal the parent or target bytes and the index equals a proven tree. A crash cannot collapse multiple queued edits into one commit.

An OS-managed advisory lock coordinates Mochi publishers in the same repository and releases on process exit. This Linux adapter requires util-linux `flock`. The adapter refuses symlinks, detached or foreign branches, foreign HEADs, dirty files, foreign index trees, and unsafe Git attributes or configuration. No reset, clean, stash, or broad staging command exists.

These checks do not protect against arbitrary simultaneous human shell writes between a check and a filesystem operation. Stop Mochi before editing the repository. Cooperating Git writers must honor `.git/mochi-publisher.lock`. Human edits block publication; they are not imported. Restoring the exact published state lets queued publication resume. Standalone human repository import is not supported. Mochi never deletes unrelated repository content.

`note` reports durable saving separately from local Git publication. A blocked publisher retains the queue and a reason in `mochi.memory-repo.blocked`; later note responses include that reason. It retries after one minute. Reads remain available.

Passive timestamped `mochi.memory-change` entries anchor historical recall after unattended writes. They contribute no model input and start no root model turn.

## Reflect

Before the settle task compacts root, it forks root and asks the fork to save what is worth keeping with `note`. The fork sees the whole context the compaction summary is about to drop, and its first request reads root's prompt cache. Its writes go through `note` like any other: the secret scan, owner-note protection, and the cap on always-in-prompt notes all apply, and each note's source is the fork's own entry. It is on by default; `memory.reflect = false` in `config.toml` turns it off. Terminal-only mode has no settle task and so no reflect.

Reflect replaced the nightly Dreaming review. A store that ran Dreaming has its task settled and its `mochi.dream` document retired at the next boot. A `[memory.dreaming]` table in `config.toml` is read and ignored.
