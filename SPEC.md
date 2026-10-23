# Mochi spec

Mochi is a personal agent that runs all day on the owner's machine. The owner texts it on iMessage or WhatsApp, or types in a terminal. It works through code mode scripts, keeps an append-only memory, forks copies of itself for parallel slices, and hands standing work to profiles. pi-durable (`@earendil-works/pi-durable`, pinned at 1.4.0) supplies crash recovery, message queueing, compaction and the task tree.

## Thesis

The model manages its own work and its own context. It writes scripts instead of calling many tools, it copies itself with its whole context when a task splits, and it keeps what matters in memory it can search and reopen. The harness stays small: no guard layers, no caps on memory or context, and no vendor names in the core.

## Process shape

One daemon process owns everything:

- the Harness and its SQLite file `<home>/mochi.sqlite`
- the search index `<home>/index.sqlite`
- every channel adapter, the trigger and webhook server, and the A2A server
- the attach socket `<home>/mochi.sock`

The daemon takes the lock file `<home>/mochi.lock` at start and exits if another live process holds it. Terminals attach over the socket and never open storage.

| Command | What runs |
|---|---|
| `mochi` on a terminal | The TUI. It attaches to the running daemon. Without one, this process becomes the daemon with every configured channel until the TUI exits. |
| `mochi --headless` | The daemon alone. This is the systemd mode. |
| `mochi attach <id\|label>` | The TUI on another conversation. It needs a running daemon. |
| `mochi chat [--to <id\|label>]` | Each stdin line goes to root, or to the `--to` conversation, and its answer prints. Without a daemon, this process becomes one with no channels and no triggers. |
| `mochi -p <prompt> [--to <id\|label>]` | One prompt, then its reply. The same daemon rule as `chat`. |
| `mochi agents` | Every conversation: id, kind, label, parent, busy or idle, model, title. |
| `mochi status` | The daemon's pid, uptime, protocol, build, channels, setup report, usage and live tasks. |
| `mochi doctor` | Read-only checks of the home, config, lock, socket, protocol, systemd unit and log. It exits 1 when a check fails. |
| `mochi models [search]` | The configured models and the config names that pick them. |
| `mochi stop` | Stops the daemon. When systemd runs it, this runs `systemctl --user stop mochi`. Otherwise it sends SIGTERM and waits. |
| `mochi export <id\|label> [out]` | A conversation's history as JSON lines, to stdout or to a new file. |
| `mochi auth apps` | The OAuth login to the apps server. |
| `mochi service install` | Writes `~/.config/systemd/user/mochi.service`. |
| `mochi help [command]` | The commands, or one command's flags. |

`agents`, `status`, `export` and `attach` never become a daemon. Without one they print "mochi is not running." and exit 1.

A conversation's label is `main`, `line`, `profile:<name>`, `trigger:<id>`, `fork:<name>@<id>`, `agent:<name>@<id>`, `user:<user id>`, or else `conversation:<id>`. A number is always a conversation id. A label must match exactly.

`--id <key>` makes a script's submissions replay-safe for any target: line n becomes request `cli:<key>:<n>`, so a rerun after a crash prints the same answers without asking again. `--json` prints the target's view as JSON lines.

The socket speaks protocol 2. Each connection starts with `hello`. The daemon refuses another protocol with an error that says which side to restart. A line that is not a valid request gets one error frame, and only that connection closes.

## Conversations

- **Root.** The owner has one root conversation across every channel.
- **User threads.** Each `[[users]]` entry gets its own conversation on iMessage, keyed by handle. A user thread has seat `user` and never sees the owner's memory.
- **The line.** One ownerless conversation holds every delivery task, so neither Esc nor `/stop` on root drops an owed reply.
- **Trigger runs.** Each trigger owns one ownerless conversation with seat `trigger`.
- **Profiles.** Each profile owns one standing ownerless conversation with seat `agent`.
- **Forks.** Each fork is a task-owned copy of its parent at the parent's newest entry.
- **A2A contexts.** Each `(peer, contextId)` pair owns one ownerless conversation with seat `peer`.

Every inbound message is `submit({ type: "input", requestId: "<channel>:<message id>", whenBusy: "steer" })`. A redelivered message submits once. A burst of texts that lands while an answer is written reaches the model as one turn, because the harness runs with `steeringMode` and `followUpMode` set to `"all"`.

## Delivery

A Turn (`mochi.turn` task) is one thing owed to the owner or a user. It runs the submission, claims the answer, and sends it. A claim is a document keyed by answer and channel, so the first claimer sends and a duplicate Turn ends `merged`. Turns chain per channel, so messages never interleave and a restart replays the same order. `send` checkpoints after each bubble, so a crash repeats at most one bubble.

Each adapter maps every platform error to one class. `ChannelDown` (unreachable, 429, auth) waits 5 s doubling to 5 min and gives up after an hour. `SendUnknown` (a timeout, a 5xx) retries once. `SendRejected` skips the bubble. `present()` turns a reply into bubbles: on iMessage each paragraph is a bubble, a line that is only a URL is a link bubble, and a reply has at most three bubbles. WhatsApp sends one bubble per reply. A blank reply sends nothing.

## Seats and tools

A seat is how far a conversation is trusted. It is written once, when the conversation is created.

| Seat | Who | Differs from `agent` |
|---|---|---|
| `agent` | root, forks, profiles | (every function) |
| `trigger` | trigger runs | no `note`, `react`, forks, profiles, board or `trigger_add` |
| `peer` | A2A contexts | also no `notify`, processes, A2A or triggers |
| `user` | user threads | files, the web, media, `recall`, `llm` and `classify` only; no `notify` |

The model sees three tools. `SURFACE` in `src/seats.ts` lists them:

- `codemode`: JavaScript in a QuickJS sandbox that calls the seat's library as `await tools.<name>(args)`. Each call is a nested durable task. After a restart, a script replays from a journal and continues; a call marked `unsafe` that was running at the crash returns an interrupted error. A script with no `// @options:` line gets a 10-minute timeout and 256 MB.
- `notify`: sends text verbatim to the owner, or to a trigger's recipients. Refused in root, whose reply already reaches the owner.
- `handoff`: starts a fresh context from a note.

`LIBRARY` in `src/seats.ts` lists every script function and the seats that get it. Opening mochi fails when `SURFACE`, `LIBRARY` and the definitions disagree. A profile's `tools` list narrows its conversations further through pi-durable's stored `tools` filter. A narrowed list always keeps `context_read` and `context_list`, so a profile can read its own held input.

| Area | Functions |
|---|---|
| Files and shell | `bash`, `read`, `edit`, `write` (the daemon user's full access; bash defaults to a 600 s timeout) |
| Memory | `note`, `recall`, `zoom`, `history` |
| Models | `llm` (the fast model unless `model` names `brain` or `strongest`, no tools), `classify` (the classifier model) |
| Context | `context_read`, `context_put`, `context_list` |
| Web | `web_search`, `web_fetch`, `web_map`, `web_find_tools`, `web_alexandria`, `browse`, `browse_fast` |
| Apps | `apps_search`, `apps_call`, `apps_skills` |
| Media | `image_gen`, `video_gen`, `speak`, `transcribe`, `gif_search`, `gif_save` |
| Forks and profiles | `fork`, `fork_start`, `agent`, `profile_list`, `profile_send`, `profile_stop`, `profile_update` |
| Triggers | `trigger_add`, `trigger_list`, `trigger_remove` |
| Board | `board_add`, `board_list`, `board_update`, `board_claim` |
| Processes | `proc_start`, `proc_status`, `proc_logs`, `proc_stop` |
| Peers | `a2a_list`, `a2a_ask`, `a2a_send`, `a2a_status` |
| Channels | `react` |

Tool names never are `memory`, `session_search` or a single-underscore `mcp_` prefix, because a provider billing classifier flags them (`FORBIDDEN_TOOL_NAME`).

## System prompt

Sections render in this order, and each must be stable between requests so the prompt cache stays warm:

1. `system`: raw facts and rules. The message tag, tools and code mode, memory tools, doors, his call, scheduling, proof, safety, and the running chat channels. An agent seat also gets the people by id and the A2A peers.
2. `identity`: voice and style. Who mochi is, the reply style, and one line per running chat channel with its bubble rule.
3. `memory`: the wake view of the conversation owner's memory log. A user thread does not have it.
4. `skills-index`: one line per bundled skill. The model opens a skill with `read`.
5. `codemode`: the inline library functions. `searchTools()` finds the deferred ones.
6. `context`: the context keys and `store()` keys the conversation holds, with their sizes. It is empty until a value exists.
7. `instructions`: root's `<home>/instructions.md`, or a profile's or trigger's instructions.

A changed section reaches the next request as a mid-conversation system message that carries only the change, so a `note` does not break the cache.

## Memory and the context window

Memory follows OptMem's merge tree (`src/memory/tree.ts`). A log is an append-only list of lines. Each complete aligned block of 2, 4, 8 and more lines gets one summary line, built once by the fast model from its two halves (or from its raw lines while the block holds 16 or fewer). `cover(total, budget)` tiles the log with at most `budget` blocks: recent lines stay whole and older ones merge. Nothing is summarized twice and nothing is lost.

There are two kinds of log:

- **Memory logs.** `note({ line })` appends one line. Root's log is `mochi.memory-log`; each profile's is `mochi.profile-memory` keyed by name. The `memory` section shows `cover(root's log, 96)`, so every conversation sees the owner's rules and facts. A profile's conversations also see `cover(its own log, 96)` after it, and their `note` calls write there. `zoom({ own: true })` opens a block of the profile's own log.
- **Turn logs.** `mochi.turn-log` holds one line per turn of a conversation: the owner's text and mochi's answer, digested by the fast model when long.

The feed (`src/memory/feed.ts`) subscribes to commits. After each commit it indexes new chat text into FTS5, folds finished turns into turn logs, and builds every block that is due, one commit per block, so a crash resumes at the next missing block. pi-durable's threshold compaction is the one context policy. Its `beforeCompact` hook returns the cover of the conversation's turn log as the summary, so compaction never waits on a model. `zoom({ block, turns? })` opens one block into its two halves, down to the raw lines.

`recall` searches memory lines and past chat with FTS5 BM25, root's chat first, and leaves out entries the caller already sees. `recall({ entry })` reads the messages around one chat hit. `history` gives a script past chat as rows to filter and hand to `llm`.

The retired `mochi.memory` note document imports into root's memory log once, at open, when the log is empty.

## Context

Long input is a value, not prompt text. `holdText` in `src/context.ts` is the one owner of inbound text. Text up to 8,192 chars (`INLINE_MAX`) reaches the model as it is. Longer text goes to `<work>/context/<sha256>.txt`, written to a temp name and then renamed. The conversation's `mochi.context` catalog maps a key to the file, its size and its line count. The model sees a header with the key, the first 1,500 chars and the last 500. The threshold is a reading budget; nothing is dropped.

- Keys are immutable and name their source: `in:<request id>` for inbound text, `put:<task id>` for a script's `context_put`. The same key with other text throws.
- The same key and text give the same file and the same header, so a replay submits identical content and its request id dedupes it.
- Held inputs: chat and cli messages, trigger check output, webhook bodies, A2A text, profile messages and replies, fork answers that merge back, proc wakes and child briefs.
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

`profile_stop({ name })` aborts the profile's running turn, its queued submissions and the child tasks under its conversation, the same walk `/stop` does for root (`abortTargets` in `turn/commands.ts`). It does not stop processes, triggers or board tasks.

## Triggers

A trigger is one durable `mochi.trigger` task in its own conversation. Its input is the definition, and its checkpoint holds the next slot, so the task record is the only copy of the schedule. Config seeds in `[[triggers]]` reconcile at start: an equal seed stays, a changed one is re-added, and a seed that is gone is aborted.

```ts
type Trigger =
  | { kind: "cron"; id; prompt; cron; tz; check?: string[]; steps?: Step[]; profile?; model?; thinking?; notify?: string[] }
  | { kind: "webhook"; id; prompt; auth; steps?: Step[]; profile?; model?; thinking?; notify?: string[] };

type Step =
  | { classify: { question; yes; no; threshold?; on?: "input" | "output" } }
  | { model: {} };
```

A run is the ordered `steps`. A classify step before the model step asks the classifier about the input (a webhook body, a check script's output, or the prompt) and stops the run when P(yes) is below `threshold` (default 0.5), so the model never starts for junk. A classifier that fails passes and logs `classify.failed`, so an outage lets alerts through instead of silencing them. A classify step with `on: "output"` judges each `notify` text instead. The model step runs the prompt under the trigger's `profile` (its instructions, model, tools and memory), else its `model`, else the fast tier. A trigger without `steps` is one model step. A stored `notifyWhen` reads as an output classify step and `admitWhen` as one before the model, and `role` reads as `profile`, so triggers stored before steps run as they did.

- A cron `check` script runs first. Empty output ends the run `quiet` with no model call.
- Each run starts from a keyed reset whose handoff is the last run's closing note, so a run never resends its history.
- A cron slot more than 15 minutes late is `missed`. A run still going after 30 minutes is aborted and recorded `timed-out`.
- Webhooks arrive at `POST /hooks/<id>` on `MOCHI_HOOKS_PORT` (default 8788). Authentication (HMAC-SHA256 or bearer) runs first, the body limit is 1 MB, and the handler returns 202 before the run.
- A trigger reaches people only through `notify`, to its `notify` ids (default the owner).

## The board

The board (`mochi.board`) holds what mochi and its profiles owe. A task has an id, a title, an optional `due`, `bots` (root or profile names, the first leads), a status (`open`, `waiting`, `done`, `dropped`), a log, and an optional claim. `board_claim` takes a lease (default 2 hours) and fails while someone else holds a live one, so two workers never take the same task. Setting a task done or dropped clears its claim.

The sweep (`mochi.board-sweep`) reads the board in code every 60 s and costs no model call unless a task is due. For a due task led by root, it forks root with the task as the brief. For a task led by a profile, it sends the brief to that profile. A woken task with no log line for 24 hours is woken again, at most 3 times per due time; the last wake asks for a notify that the task is stuck.


## Self-improvement

The `improve` trigger runs `skills/improve` nightly. It follows Harness² (recursive agent harnessing), with one change: mochi does not rerun a task to compare harnesses, because its tasks act on the world. Instead `scripts/improve-check.ts` counts failure signals per owner turn since the last run (busy sends, refused notify, side schedulers, lost children, timeouts, owner chases, duplicate replies) and writes the transcripts. The run judges each pending edit on its signal (helped, hurt, no observed effect, confounded), reverts a hurt one with git, then proposes from two dimensions (procedure and practice) with `llm` on the strongest model, composes at most 3 edits, and applies them.

It edits only `<home>/skills` (which replaces a bundled skill of the same name) and `<home>/profiles`, one git commit in `<home>` per edit. Code and config changes go to the owner as proposals. `<home>/improve/library.md` keeps every edit, its verdict and at most one transferable lesson per run, and each run reads it first. A window with fewer than 10 owner turns is quiet and grows until the next run.

## Models and config

`[providers.<name>]` is an endpoint, its protocol and the variable with its key. The protocols are `anthropic`, `responses`, `chat` and `classifier` (System One). A gateway is one provider per protocol it serves. `[models]` names `brain`, `fast`, `strongest`, `classifier` and `aliases`, each `<provider>/<id>`. Without `[models] classifier`, an `OPENROUTER_API_KEY` alone turns on the classifier protocol's default endpoint and model. `[models.overrides]` sets a model's context window, output limit and cache life. mochi carries no prices: token counts stay, and the model provider bills.

Other config keys: `timeZone`, `appsUrl` (an MCP server with `execute` and `skills`; `MOCHI_APPS_URL` overrides it), `[web]` (`keyEnv`, `url`, `browserProfile`), `[media]` (images, video, and speech through the OpenAI audio API on a named provider), `[[users]]`, `[a2a.peers]`, and `[[triggers]]`. Boot logs one `setup` line per boundary, and names config keys mochi does not read.

Keys live in `<home>/.env` under the names config gives. Channel keys: `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `IMESSAGE_OWNER`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_OWNER`. Daemon keys: `MOCHI_BIND_HOST`, `MOCHI_HOOKS_PORT`, `MOCHI_PUBLIC_URL`, `MOCHI_A2A_PEER_TOKENS`, `MOCHI_A2A_PORT`.

## A2A

Other agents reach mochi over A2A v1.0 (JSON-RPC): the agent card, `SendMessage` and `GetTask`, with one bearer token per peer and localhost by default. Each `(peer, contextId)` gets its own `peer` conversation, which has no A2A tools, so agents cannot loop. `a2a_ask`, `a2a_send` and `a2a_status` call the peers in `[a2a.peers]`.

## Module map

```text
src/
  main.ts           arguments and modes, lock, open the harness, start channels and components, setup report
  mochi.ts          openMochi: the registry, tools, extensions, root, the line, the sweep
  config.ts         config.toml and .env, parsed with TypeBox at the boundary
  home.ts           the home directory layout
  seats.ts          SURFACE, LIBRARY, seat extensions with codemode, conversation creation, forkPoint
  setup.ts          readiness per boundary and the boot report
  journal.ts        a task-scoped record of what a call created, for replay
  brain/            providers and models, the classifier, identity section, llm and classify
  memory/           tree.ts (cover, pending), memory.ts (logs, tools, sections, the window hook), feed.ts
  index/fts.ts      FTS5 over memory lines and chat text
  context.ts        held text: files, the catalog, holdText, context_* tools and the context section
  fork/fork.ts      the child task, fork, fork_start, agent and depth
  profiles/         profiles on disk, standing conversations, profile_* tools, memory owner
  triggers/         cron parser, trigger task, steps, seeds, webhooks
  board/board.ts    the board, claims, the sweep
  turn/             ingest and the Turn task, commands (/new, /stop, /status), handoff
  channels/         the channel interface, present(), iMessage, WhatsApp
  apps/, auth/      the apps server client and its OAuth login
  web/, browser/    web functions and the logged-in browser
  media/            images, video, speech, gifs, inbound attachments
  procs/            background processes and their wakes
  a2a/              A2A protocol, server and tools
  attach/           the socket protocol, server, client, TUI and line modes
  skills/           the skills-index section
  env/              the execution environment for the file and shell tools
```

## Decisions that still hold

| Decision | Why |
|---|---|
| No approvals, guard hooks or tool sandbox. | The owner trusts the model on their own machine. A prompt injection in a page or a mail can reach the daemon user's files and keys; that is the accepted cost. |
| Three model tools; everything else is a script function. | The first request stays small, and a script fans out work and filters data before the model reads it. |
| Triggers run in their own conversations and reach people only by `notify`. | Root's transcript and cache stay clean, and silence is the default for periodic checks. |
| Forks by default; fresh agents only for a slice of data. | A fork reuses the parent's prompt cache and knows the context. Measured live on Opus 5.5: each fork's first request read about 6,500 cached tokens and wrote about 225. A fresh `agent` pays its own prompt, so it is for bulk work on a cheaper model over context it is given. |
| Profiles live in the one daemon, not one service each. | One process, one store, one schedule; a profile still has its own role, model, tools and memory. |
| OptMem memory and window instead of rewrite-on-compaction. | Rewriting the whole prefix on every compaction lost detail each pass, and promises died at compaction. A tree builds each summary once and keeps every raw line reachable. |
| The board holds promises, not one-shot triggers. | Of 23 commitments root made from Oct 6 to 14, 10 had nothing behind them. |
| No caps on memory or context. | Sizes are reading budgets, not storage limits. Transport limits at HTTP boundaries and process timeouts stay. |
| No vendor names in the core. | Providers, the classifier, apps and the web are config. The web client speaks Firecrawl's v2 API and the apps client speaks Executor's protocol, each as the one adapter. |
| Verification is a live run on a copy of a store, not unit tests. | Without a daemon, `-p` and `chat` start no channels or triggers, so a copy reaches no one. |
| WhatsApp uses mochi's own Cloud API adapter; iMessage uses Photon Spectrum. | The Cloud API keeps the token on the box. Spectrum has no self-hosted Linux option. Spectrum 12.10.1 has no `catchUp`, so messages sent while the line is down are not replayed. |
