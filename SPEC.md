# Mochi spec

Mochi is a personal agent that runs all day on the owner's machine. The owner texts it on iMessage, or types in a terminal. It works through code mode scripts, keeps an append-only memory, forks copies of itself for parallel slices, and hands standing work to profiles. pi-durable (`@earendil-works/pi-durable`, pinned at 1.4.0) supplies crash recovery, message queueing, compaction and the task tree.

## Thesis

The model manages its own work and its own context. It writes scripts instead of calling many tools, it copies itself with its whole context when a task splits, and it keeps what matters in memory it can search and reopen. The harness stays small: no guard layers, no caps on memory or context, and no vendor names in the core.

## Process shape

One daemon process owns everything:

- the Harness and its SQLite file `<home>/mochi.sqlite`
- every channel adapter, and the schedule and webhook server
- the terminal channel's socket `<home>/mochi.sock`

The daemon takes the lock file `<home>/mochi.lock` at start and exits if another live process holds it. Terminals reach it over the socket and never open storage.

| Command | What runs |
|---|---|
| `mochi` on a terminal | The TUI: the owner's lines, mochi's replies and what main is doing now. It uses the running daemon. Without one, this process becomes the daemon with every configured channel until the TUI exits. |
| `mochi --headless` | The daemon alone. This is the systemd mode. |
| `mochi chat` | Each stdin line goes to root, and its answer prints. The next line waits for the answer. Without a daemon, this process becomes one with no outside channels and no schedules. |
| `mochi -p <prompt>` | One prompt, then its reply. The same daemon rule as `chat`. |
| `mochi status` | The daemon's pid, uptime, wire, build, channels and setup report. |
| `mochi doctor` | Read-only checks of the home, config, lock, socket, wire, systemd unit and log. It exits 1 when a check fails. |
| `mochi stop` | Stops the daemon. When systemd runs it, this runs `systemctl --user stop mochi`. Otherwise it sends SIGTERM and waits. |
| `mochi auth apps` | The OAuth login to the apps server. |
| `mochi service install` | Writes `~/.config/systemd/user/mochi.service`. |
| `mochi help [command]` | The commands, or one command's flags. |

`status` never becomes a daemon. Without one it prints "mochi is not running." and exits 1.

The terminal is a channel, `cli` in `src/channels/cli.ts`, like iMessage. Each line is an inbound message from the owner: it opens a chat Turn in root, and `/new`, `/stop` and `/status` work as on iMessage. The Turn's bubbles go to every attached terminal, as one thread shows on every device. A NO_REPLY answer prints nothing. A terminal line never becomes the owner's last channel, so `notify` and `send` do not go to a terminal that may be closed.

The socket speaks wire 4, one JSON frame a line. The terminal sends `hello { wire, watch }`, then `line { text }`. The daemon answers `hello` with its facts, then sends `bubble { text }` and one `done` when a line's Turn ends. With `watch`, it also sends `live { status }`, one line that says what root is doing now. Another wire, or a bad frame, gets one `error` frame, and only that connection closes.

## Conversations

- **Root.** The owner has one root conversation across every channel.
- **User threads.** Each `[[users]]` entry gets its own conversation on iMessage, keyed by handle. A user thread has seat `user` and never sees the owner's memory.
- **The line.** One ownerless conversation holds every delivery task, so neither Esc nor `/stop` on root drops an owed reply.
- **Schedule runs.** Each cron, at or webhook schedule owns one ownerless conversation with seat `trigger`.
- **Profiles.** Each profile owns one standing ownerless conversation with seat `agent`.
- **Forks.** Each fork is a task-owned copy of its parent at the parent's newest entry.

Every inbound message is `submit({ type: "input", requestId: "<channel>:<message id>", whenBusy: "steer" })`. A redelivered message submits once. A burst of texts that lands while an answer is written reaches the model as one turn, because the harness runs with `steeringMode` and `followUpMode` set to `"all"`.

## Delivery

A Turn (`mochi.turn` task) is one thing owed to the owner or a user. It runs the submission, claims the answer, and sends it. A claim is a document keyed by answer and channel, so the first claimer sends and a duplicate Turn ends `merged`. Turns chain per channel, so messages never interleave and a restart replays the same order. `send` checkpoints after each bubble, so a crash repeats at most one bubble.

Each adapter maps every platform error to one class. `ChannelDown` (unreachable, 429, auth) waits 5 s doubling to 5 min and gives up after an hour. `SendUnknown` (a timeout, a 5xx) retries once. `SendRejected` skips the bubble. `present()` turns a reply into bubbles: on iMessage each paragraph is a bubble, a line that is only a URL is a link bubble, and a reply has at most three bubbles. A blank reply sends nothing.

## Seats and tools

A seat is how far a conversation is trusted. It is written once, when the conversation is created.

| Seat | Who | Differs from `agent` |
|---|---|---|
| `agent` | root, forks, profiles | (every function) |
| `trigger` | schedule runs | no `react`, forks, profiles or `schedule_add` |
| `peer` | the line | also no `notify`, processes or schedules |
| `user` | user threads | files, the web, media, `zoom`, `llm` and `classify` only; no `notify` |

The model sees three tools. `SURFACE` in `src/seats.ts` lists them:

- `codemode`: JavaScript in a QuickJS sandbox that calls the seat's library as `await tools.<name>(args)`. Each call is a nested durable task. After a restart, a script replays from a journal and continues; a call marked `unsafe` that was running at the crash returns an interrupted error. A script with no `// @options:` line gets a 10-minute timeout and 256 MB.
- `notify`: sends text verbatim to the owner, or to a schedule's recipients. Refused in root, whose reply already reaches the owner.
- `handoff`: starts a fresh context from a note.

`LIBRARY` in `src/seats.ts` lists every script function and the seats that get it. Opening mochi fails when `SURFACE`, `LIBRARY` and the definitions disagree. A profile's `tools` list narrows its conversations further through pi-durable's stored `tools` filter. A narrowed list always keeps `context_read` and `context_list`, so a profile can read its own held input.

| Area | Functions |
|---|---|
| Files and shell | `bash`, `read`, `edit`, `write` (the daemon user's full access; bash defaults to a 600 s timeout), `find` and `grep` (fff-node: one in-process index per root, frecency ranked, gitignore aware; the root defaults to the home dir) |
| Memory | `zoom` |
| Models | `llm` (the fast model unless `model` names `brain` or `strongest`, no tools), `classify` (the classifier model) |
| Context | `context_read`, `context_put`, `context_list` |
| Web | `web_search`, `web_fetch`, `web_map`, `web_find_tools`, `web_alexandria`, `browse`, `browse_fast` |
| Apps | `apps_search`, `apps_call`, `apps_skills` |
| Media | `image_gen`, `video_gen`, `speak`, `transcribe`, `gif_search`, `gif_save` |
| Forks and profiles | `fork`, `fork_start`, `agent`, `profile_list`, `profile_send`, `profile_stop`, `profile_update` |
| Self-extension | `tools_reload` |
| Scheduling | `schedule_add`, `schedule_list`, `schedule_remove` |
| Processes | `proc_start`, `proc_status`, `proc_logs`, `proc_stop` |
| Channels | `react` |

Tool names never are `memory`, `session_search` or a single-underscore `mcp_` prefix, because a provider billing classifier flags them (`FORBIDDEN_TOOL_NAME`).

## System prompt

Sections render in this order, and each must be stable between requests so the prompt cache stays warm:

1. `system`: raw facts and rules. The message tag, tools and code mode, memory tools, doors, his call, scheduling, proof, safety, and the running chat channels. An agent seat also gets the people by id.
2. `identity`: voice and style. Who mochi is, the reply style, and one line per running chat channel with its bubble rule.
3. `memory`: how to read the view and zoom it. The view itself goes in the request, not the prompt.
4. `skills-index`: one line per bundled skill. The model opens a skill with `read`.
5. `codemode`: the inline library functions. `searchTools()` finds the deferred ones.
6. `context`: the context keys and `store()` keys the conversation holds, with their sizes. It is empty until a value exists.
7. `instructions`: root's `<home>/instructions.md`, or a profile's or schedule's instructions.

A changed section reaches the next request as a mid-conversation system message that carries only the change, so a changed section does not break the cache.

## Memory and the context window

The transcript is the memory. The view follows uniichat's memory tree (github.com/VictorTaelin/uniichat, `Memory.ts` and `prompt.txt`), inside pi-durable. pi-durable stores the messages; mochi stores only the tree over them and the view of it. `settings.compaction.enabled` is false: nothing is summarized away.

Message i is the i-th non-system message of a conversation's model context. Over the messages grows a binary tree:

- Node (0,i) is message i, tagged `user:`, `agent:`, `tool:` or `echo:`, when it fits in 512 bytes (`NODE`). A longer message gets a one-line summary.
- Node (l,i) merges nodes (l-1,2i) and (l-1,2i+1) into one line of at most 512 bytes.

`src/memory/view.ts` holds the algorithm as pure functions with uniichat's names: `roots`, `halves`, `span`, `reach`, `merge`, `fit`, `todo`, `whole`, `blocks`, `zoom` and the `LEAF` and `MERGE` task text. A view lists nodes that cover the chat, oldest first. Each new message appends its node. When the view passes `HIGH` bytes (128,000; `MOCHI_VIEW_HIGH` sets it for a test), one batch merges the most-due adjacent siblings whose parent is built, down to half. A pair is due by `(T + 1) / 2^l - i`, its age from its last message in halves. So the view changes only at its end between batches, and the prompt cache stays warm.

The `mochi.view` document family holds one tree per standing conversation, keyed by conversation id: `start` (message 0's timestamp), `count`, `nodes` by slot, the chat's `view`, and the compactions' `seen` view (a quarter of `HIGH`). A reset or a manual compaction starts a new context, and the compactor starts a new tree for it. Forks and fresh agents have no tree. A trigger run has none, because each run starts from a reset.

The compactor (`src/memory/compactor.ts`) is one loop in the daemon. After each commit that adds entries, it brings each standing conversation's tree to its messages and builds due nodes oldest first, one commit per node, so a crash resumes at the next missing node. It stops at a tool result that pi-durable synthesized for a call still running. Each call goes to the fast model with uniichat's compaction prompt verbatim (`src/memory/prompt.ts`), the `seen` view up to the node, and the `LEAF` or `MERGE` task with the node's input. A line over 512 bytes is asked again with its size and where the limit cuts it, five tries at most, and the shortest is kept. A failed pass waits 5 s, doubling to 5 min, and logs `view.failed` each time. After 30 minutes of failure it notifies the owner once, through a run Turn on the owner's last channel, and again only after it has worked in between. There is no fallback summary: a node not built shows as `(not summarized yet: zoom it)`.

The `notes` extension, which every seat selects, holds the `memory` section and a `beforeRequest` hook on `GenerationTask`. The hook reads the tree and replaces the request's messages with:

1. the system messages as pi-durable gave them;
2. one user message with the view before the tail, as `id+n|text` lines inside `<chat>` tags, four lines a text block (`BLOCK`);
3. the tail, whole: from the last user message, cut to its last `HIGH` bytes as uniichat's `whole` does, moved back to the first message of the view line that holds it and off any tool result.

The hook only reads. A conversation with no tree sends its context as it is.

The `memory` section is uniichat's "# The view" with its turn rules on memory. `zoom({ id, n })` opens line id+n into its two halves, `zoom({ id, n: 1 })` gives message id whole, and `zoom({ name })` gives a child agent's own chat. Zoom is the only way to read the tree; there is no search.

Lasting facts live outside the chat, as markdown in `<home>/memory/`. The `system` section names the folder. The agent reads it with `tools.find` and `tools.grep` and writes a line there when the owner states a rule or a fact it will need again. A reset starts a new view, and these files are what carries over.

## Context

Long input is a value, not prompt text. `holdText` in `src/context.ts` is the one owner of inbound text. Text up to 8,192 chars (`INLINE_MAX`) reaches the model as it is. Longer text goes to `<work>/context/<sha256>.txt`, written to a temp name and then renamed. The conversation's `mochi.context` catalog maps a key to the file, its size and its line count. The model sees a header with the key, the first 1,500 chars and the last 500. The threshold is a reading budget; nothing is dropped.

- Keys are immutable and name their source: `in:<request id>` for inbound text, `put:<task id>` for a script's `context_put`. The same key with other text throws.
- The same key and text give the same file and the same header, so a replay submits identical content and its request id dedupes it.
- Held inputs: chat and cli messages, schedule check output, webhook bodies, profile messages and replies, fork answers that merge back, proc wakes and child briefs.
- `context_read({ key, offset?, length? })` returns one page (64K chars by default) and the offset of the next. `context_put({ text })` keeps a script's value and returns its key and file path. `context_list` lists the catalog.
- The catalog forks `asOf`, like the codemode store. Compaction does not touch it, and the `context` section lists its keys after compaction.

## Forks

Two kinds of child exist. Each is a `mochi.agent` task that owns one conversation.

`fork({ briefs: [{ name, brief }] })` forks the calling conversation at its newest entry once per brief, six at a time (`FORK_BATCH`), and resolves to the answers in brief order. A fork keeps its parent's agent, history, codemode store and context catalog, so its first request reads the parent's prompt cache. `fork_start` is the background form: it returns the names at once, and each answer merges back into the caller as a new message.

`agent({ jobs: [{ name, brief, context?, model? }] })` starts fresh children, six at a time, and resolves to `[{ name, answer }]` in job order. A fresh child has the caller's agent (seat, tools, instructions, profile) and no history. `model` is `brain`, `fast` or `strongest`; an unknown or unconfigured model throws before any child exists. `context` names the caller's context keys to copy into the child. Use `agent` for a sub-task over one slice of data that needs tools, `fork` when the child needs this conversation, and `llm` for one completion without tools. The board wakes root's due tasks through the same fresh creator.

Depth is durable. Root and standing conversations are depth 0. Each child records its caller's depth plus one in its task input, read before the creating commit's first write. A `fork` or `agent` call from depth 3 (`MAX_DEPTH`) throws "Children are 3 deep here. Do this slice yourself."

Each brief names its own scratch directory, `<work>/forks/<name>`, and tells the child to do code work in a git worktree of its own.

## Profiles

A profile is a standing teammate inside the daemon: `<home>/profiles/<name>/instructions.md`, with front matter for `description`, `model`, `thinking` and an optional `tools` list. The bundled `agents/worker.md` is a profile too; a home profile with the same name replaces it. Profile files are read on each use, so an edit reaches the next message without a restart.

`profile_send({ name, message, background? })` submits to the profile's standing conversation (`mochi.profile` records it) and resolves to the answer, or returns at once with `background`. Each send writes the profile's model, instructions and tool list into its conversation, and records the conversation's owner in `mochi.profile-of`, so its memory section and its `note` calls use the profile's own memory log. `profile_update` writes a profile file.

A busy profile queues a message (`whenBusy: "followUp"`) and `profile_send` returns at once with a result that starts with `NOT STARTED`. Queued messages merge into the profile's next turn, so they settle with one answer; `mochi.reply` keys each delivery by asker and answer (`mochi.reply-delivered`) and sends that answer back once.

`profile_stop({ name })` aborts the profile's running turn, its queued submissions and the child tasks under its conversation, the same walk `/stop` does for root (`abortTargets` in `turn/commands.ts`). It does not stop processes or schedules.

## Scheduling

One durable task kind, `mochi.schedule`, does all later work. Its input is the definition, and its checkpoint holds the next slot, so the task record is the only copy of the schedule.

```ts
type Schedule = { id; when: When; prompt; check?: string[]; steps?: Step[]; profile?; model?; thinking?; notify?: string[] };

type When =
  | { cron; tz }                      // each slot
  | { at }                            // once, ISO time with an offset
  | { webhook: { auth } }             // each POST /hooks/<id>
  | { process: { name; pid; watch? } }; // when a background process exits

type Step =
  | { classify: { question; yes; no; threshold?; on?: "input" | "output" } }
  | { model: {} };
```

`schedule_add`, `schedule_list` and `schedule_remove` are the library. The same id replaces. Config seeds in `[[triggers]]` (the key keeps its old name, so configs load unchanged; `kind` is `cron`, `at` or `webhook` with its fields flat) reconcile at start: an equal seed stays, a changed one is re-added, and a seed that is gone is aborted.

- **cron** and **webhook** runs: each runs in the schedule's own ownerless conversation with seat `trigger`, from a keyed reset whose handoff is the last run's closing note, so a run never resends its history.
- **at**: the same run, once. It is the promise list: every promise and follow-up is an `at` schedule whose prompt is the whole task for a cold reader. A late `at` still fires; it then ends.
- **process**: `proc_start` adds `proc-<name>` in the calling conversation. The task polls the process each second. When it exits, the prompt and the log tail enter that conversation (root through a chat Turn on the owner's last channel), and the schedule ends. A `watch` regex also fires once on the first matching line. `proc_stop` and `schedule_remove` stop the process.

A run is the ordered `steps`. A classify step before the model step asks the classifier about the input (a webhook body, a check script's output, or the prompt) and stops the run when P(yes) is below `threshold` (default 0.5), so the model never starts for junk. A classifier that fails throws and logs `classify.failed`: the run fails, and the failure shows. A classify step with `on: "output"` judges each `notify` text instead. The model step runs the prompt under the schedule's `profile` (its instructions, model, tools and memory), else its `model`, else the fast tier. A schedule without `steps` is one model step.

- A `check` script runs first at each cron or at slot. Empty output ends the run `quiet` with no model call.
- A cron slot more than 15 minutes late is `missed`. A run still going after 30 minutes is aborted and recorded `timed-out`.
- Webhooks arrive at `POST /hooks/<id>` on `MOCHI_HOOKS_PORT` (default 8788). Authentication (HMAC-SHA256 or bearer) runs first, the body limit is 1 MB, and the handler returns 202 before the run.
- A run reaches people only through `notify`, to its `notify` ids (default the owner).

At daemon start, `schedule/migrate.ts` carries the three schedulers of before into `mochi.schedule`, once: each live `mochi.trigger` becomes a schedule in its own conversation, each live `mochi.proc` a process schedule, and each open or waiting board task with a due an `at` schedule `board-<id>` whose prompt holds its title, owners and log. The old tasks are aborted and the board document is retired. A board task with no due, or one the old sweep already woke for its due, has no time left to fire and is dropped with a `schedule.board_dropped` log line. Claims, leases and re-wakes are gone: a schedule fires once per slot, in one conversation.

## Own tools

Each `<home>/tools/<name>.ts` default-exports one tool made with pi-durable's `defineTool`. A bare import in such a file resolves from mochi's own `node_modules`. The daemon loads every file at start, and `tools_reload` (agent seat) loads them again: a changed file is imported again with its mtime in the URL, a removed file drops its tool, and a file that fails to load, or takes a built-in name, keeps no tool. The result lists each file with the tool name now live, or its error. Home tools join the `seat-agent` extension as deferred script functions, so the prompt does not change; a reload shows from the next script, through `searchTools()`.

## Self-improvement

The `improve` schedule runs `skills/improve` nightly. It follows Harness² (recursive agent harnessing), with one change: mochi does not rerun a task to compare harnesses, because its tasks act on the world. Instead `scripts/improve-check.ts` counts failure signals per owner turn since the last run (busy sends, refused notify, side schedulers, lost children, timeouts, owner chases, duplicate replies) and writes the transcripts. The run judges each pending edit on its signal (helped, hurt, no observed effect, confounded), reverts a hurt one with git, then proposes from two dimensions (procedure and practice) with `llm` on the strongest model, composes at most 3 edits, and applies them.

It edits only `<home>/skills` (which replaces a bundled skill of the same name) and `<home>/profiles`, one git commit in `<home>` per edit. Code and config changes go to the owner as proposals. `<home>/improve/library.md` keeps every edit, its verdict and at most one transferable lesson per run, and each run reads it first. A window with fewer than 10 owner turns is quiet and grows until the next run.

## Models and config

`[providers.<name>]` is an endpoint, its protocol and the variable with its key. `api` is a pi-ai api id, and mochi loads that api's client from pi-ai itself (`@earendil-works/pi-ai/api/<api>.lazy`), so every chat and decision api pi-ai ships works with no list in mochi. Every provider names its `url` and `keyEnv`; nothing defaults. A gateway is one provider per protocol it serves. `[models]` must name `brain` and `fast`, and may name `strongest`, `classifier` and `aliases`, each `<provider>/<id>`. Without `[models] classifier`, `classify` fails. `[models.overrides]` sets a model's context window, output limit and cache life. mochi carries no prices: token counts stay, and the model provider bills.

Other config keys: `timeZone`, `appsUrl` (an MCP server with `execute` and `skills`; `MOCHI_APPS_URL` overrides it), `[web]` (`keyEnv`, `url`, `browserProfile`), `[media]` (images, video, and speech through the OpenAI audio API on a named provider), `[[users]]` and `[[triggers]]`. Boot logs one `setup` line per boundary, and names config keys mochi does not read.

Keys live in `<home>/.env` under the names config gives. Channel keys: `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `IMESSAGE_OWNER`. Daemon keys: `MOCHI_BIND_HOST`, `MOCHI_HOOKS_PORT`, `MOCHI_PUBLIC_URL`.

## Module map

```text
src/
  main.ts           arguments and modes, lock, open the harness, start channels and components, setup report
  mochi.ts          openMochi: the registry, tools, extensions, root, the line, the migration
  config.ts         config.toml and .env, parsed with TypeBox at the boundary
  home.ts           the home directory layout
  seats.ts          SURFACE, LIBRARY, seat extensions with codemode, conversation creation, forkPoint
  setup.ts          readiness per boundary and the boot report
  journal.ts        a task-scoped record of what a call created, for replay
  brain/            providers and models, the classifier, identity section, llm and classify
  memory/           view.ts (the tree and view, pure), memory.ts (the doc, the request hook, zoom), compactor.ts, prompt.ts
  context.ts        held text: files, the catalog, holdText, context_* tools and the context section
  fork/fork.ts      the child task, fork, fork_start, agent and depth
  profiles/         profiles on disk, standing conversations, profile_* tools, memory owner
  schedule/         cron parser, the schedule task, steps, seeds, webhooks, the one-time migration
  turn/             ingest and the Turn task, commands (/new, /stop, /status), handoff
  channels/         the channel interface, present(), iMessage, the terminal channel and its socket
  tools/            the owner's own tools in <home>/tools and tools_reload
  apps/, auth/      the apps server client and its OAuth login
  web/, browser/    web functions and the logged-in browser
  media/            images, video, speech, gifs, inbound attachments
  procs/            background processes; their wakes are process schedules
  attach/           the terminal side: the socket client, TUI, line modes, stop and doctor
  skills/           the skills-index section
  env/              the execution environment for the file and shell tools
```

## Decisions that still hold

| Decision | Why |
|---|---|
| No approvals, guard hooks or tool sandbox. | The owner trusts the model on their own machine. A prompt injection in a page or a mail can reach the daemon user's files and keys; that is the accepted cost. |
| Three model tools; everything else is a script function. | The first request stays small, and a script fans out work and filters data before the model reads it. |
| Schedule runs live in their own conversations and reach people only by `notify`. | Root's transcript and cache stay clean, and silence is the default for periodic checks. |
| Forks by default; fresh agents only for a slice of data. | A fork reuses the parent's prompt cache and knows the context. Measured live on Opus 5.5: each fork's first request read about 6,500 cached tokens and wrote about 225. A fresh `agent` pays its own prompt, so it is for bulk work on a cheaper model over context it is given. |
| Profiles live in the one daemon, not one service each. | One process, one store, one schedule; a profile still has its own role, model, tools and memory. |
| uniichat's view instead of compaction. | Rewriting the whole prefix on every compaction lost detail each pass, and promises died at compaction. The tree builds each line once, every message stays reachable by `zoom`, and the view changes only at its end. |
| One scheduler: a promise is an `at` schedule. | Of 23 commitments root made from Oct 6 to 14, 10 had nothing behind them. Three schedulers (triggers, the board sweep, proc wakes) meant three places to look and three sets of rules; one task kind with a `when` is one list. |
| No caps on memory or context. | Sizes are reading budgets, not storage limits. Transport limits at HTTP boundaries and process timeouts stay. |
| No vendor names in the core. | Providers, the classifier, apps and the web are config. The web client speaks Firecrawl's v2 API and the apps client speaks Executor's protocol, each as the one adapter. |
| Verification is a live run on a copy of a store, not unit tests. | Without a daemon, `-p` and `chat` start no channels or schedules, so a copy reaches no one. |
