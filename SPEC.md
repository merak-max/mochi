# Mochi spec

Mochi is a personal agent that runs all day on the owner's machine. The owner texts it on iMessage, or types in a terminal. It works through code mode scripts, keeps an append-only memory, forks copies of itself for parallel slices, and hands work to agent definitions. pi-durable (`@earendil-works/pi-durable`, pinned at 1.4.0) supplies crash recovery, message queueing, compaction and the task tree.

## Thesis

The model manages its own work and its own context. It writes scripts instead of calling many tools, it copies itself with its whole context when a task splits, and it keeps what matters in memory it can search and reopen. The harness stays small: no guard layers, no caps on memory or context, and no vendor names in the core.

## Process shape

One daemon process owns everything:

- the Harness and its SQLite file `<home>/mochi.sqlite`
- every channel adapter, the board and the webhook server
- the terminal channel's socket `<home>/mochi.sock`

The daemon takes the lock file `<home>/mochi.lock` at start and exits if another live process holds it. Terminals reach it over the socket and never open storage.

| Command | What runs |
|---|---|
| `mochi` on a terminal | The TUI: the owner's lines, mochi's replies and what main is doing now. It uses the running daemon. Without one, this process becomes the daemon with every configured channel until the TUI exits. |
| `mochi --headless` | The daemon alone. This is the systemd mode. |
| `mochi chat` | Each stdin line goes to root, and its answer prints. The next line waits for the answer. Without a daemon, this process becomes one with no outside channels and no board fires. |
| `mochi -p <prompt>` | One prompt, then its reply. The same daemon rule as `chat`. |
| `mochi status` | The daemon's pid, uptime, wire, build, channels and setup report. |
| `mochi doctor` | Read-only checks of the home, config, lock, socket, wire, systemd unit and log. It exits 1 when a check fails. |
| `mochi stop` | Stops the daemon. When systemd runs it, this runs `systemctl --user stop mochi`. Otherwise it sends SIGTERM and waits. |
| `mochi auth <name>` | The OAuth login to the MCP server `[mcp.<name>]`. Tokens go to `<home>/mcp/<name>.json`. |
| `mochi service install` | Writes `~/.config/systemd/user/mochi.service`. |
| `mochi help [command]` | The commands, or one command's flags. |

`status` never becomes a daemon. Without one it prints "mochi is not running." and exits 1.

The terminal is a channel, `cli` in `src/channels/cli.ts`, like iMessage. Each line is an inbound message from the owner: it opens a chat Turn in root, and `/new`, `/stop` and `/status` work as on iMessage. The Turn's bubbles go to every attached terminal, as one thread shows on every device. A NO_REPLY answer prints nothing. A terminal line never becomes the owner's last channel, so a board fire and `send` do not go to a terminal that may be closed.

The socket speaks wire 4, one JSON frame a line. The terminal sends `hello { wire, watch }`, then `line { text }`. The daemon answers `hello` with its facts, then sends `bubble { text }` and one `done` when a line's Turn ends. With `watch`, it also sends `live { status }`, one line that says what root is doing now. Another wire, or a bad frame, gets one `error` frame, and only that connection closes.

## Conversations

- **Root.** The owner has one root conversation across every channel.
- **User threads.** Each `[[users]]` entry gets its own conversation on iMessage, keyed by handle. A user thread has seat `user` and never sees the owner's memory.
- **The line.** One ownerless conversation holds every delivery task, so neither Esc nor `/stop` on root drops an owed reply.
- **Resident agents.** Each resident definition owns one standing ownerless conversation with seat `agent`.
- **Children.** Each fork or fresh job owns one task-owned conversation: a fork is a copy of its parent at the parent's newest entry, a fresh one starts empty.

Every inbound message is `submit({ type: "input", requestId: "<channel>:<message id>", whenBusy: "steer" })`. A redelivered message submits once. A burst of texts that lands while an answer is written reaches the model as one turn, because the harness runs with `steeringMode` and `followUpMode` set to `"all"`.

## Delivery

A Turn (`mochi.turn` task) is one thing owed to the owner or a user. It runs the submission, claims the answer, and sends it. A claim is a document keyed by answer and channel, so the first claimer sends and a duplicate Turn ends `merged`. Turns chain per channel, so messages never interleave and a restart replays the same order. `send` checkpoints after each bubble, so a crash repeats at most one bubble.

Each adapter maps every platform error to one class. `ChannelDown` (unreachable, 429, auth) waits 5 s doubling to 5 min and gives up after an hour. `SendUnknown` (a timeout, a 5xx) retries once. `SendRejected` skips the bubble. `present()` turns a reply into bubbles: on iMessage each paragraph is a bubble, a line that is only a URL is a link bubble, and a reply has at most three bubbles. A blank reply sends nothing.

## Seats and tools

A seat is how far a conversation is trusted. It is written once, when the conversation is created.

| Seat | Who | Differs from `agent` |
|---|---|---|
| `agent` | root, children, resident agents | (every function) |
| `peer` | the line | no `react`, `send`, `agent`, `agent_stop`, `message`, the board, processes or `tools_reload` |
| `user` | user threads | files, the web, media, `zoom`, `llm` and `classify` only |

The model sees two tools. `SURFACE` in `src/seats.ts` lists them:

- `codemode`: JavaScript in a QuickJS sandbox that calls the seat's library as `await tools.<name>(args)`. Each call is a nested durable task. After a restart, a script replays from a journal and continues; a call marked `unsafe` that was running at the crash returns an interrupted error. A script with no `// @options:` line gets a 10-minute timeout and 256 MB.
- `handoff`: starts a fresh context from a note.

`LIBRARY` in `src/seats.ts` lists every script function and the seats that get it. Opening mochi fails when `SURFACE`, `LIBRARY` and the definitions disagree. A definition's `tools` list narrows its conversations further through pi-durable's stored `tools` filter. A narrowed list always keeps `context_read` and `context_list`, so a definition can read its own held input.

| Area | Functions |
|---|---|
| Files and shell | `bash`, `read`, `edit`, `write` (the daemon user's full access; bash defaults to a 600 s timeout), `find` and `grep` (fff-node: one in-process index per root, frecency ranked, gitignore aware; the root defaults to the home dir) |
| Memory | `zoom` |
| Models | `llm` (the fast model unless `model` names another from `[models]`, no tools), `classify` (the classifier model) |
| Context | `context_read`, `context_put`, `context_list` |
| Web | `web_search`, `web_fetch`, `web_map`, `web_find_tools`, `web_alexandria`, `browse`, `browse_fast` |
| Media | `image_gen`, `video_gen`, `speak`, `transcribe`, `gif_search`, `gif_save` |
| Agents | `agent`, `agent_stop` |
| Self-extension | `tools_reload` |
| The board | `board_add`, `board_list`, `board_done` |
| Processes | `proc_start`, `proc_status`, `proc_logs`, `proc_stop` |
| Channels | `react` |

Each MCP server's tools are script functions too, `<name>_<tool>` (`tools.executor_execute`), with the server's own descriptions. They are deferred, so the prompt does not grow: scripts find them with `searchTools()`. Each server is a codemode namespace, so `describeNamespace("<name>")` returns the server's own MCP instructions. They are not in `LIBRARY`; the agent and peer seats get them, and a user's thread does not. The client declares no elicitation capability: a server that needs an approval returns it as a result, and the model answers it with that server's own tool. A server reconnects every 60 s while it is down, and its tools change when it lists new ones. A server name whose `<name>_` prefix a built-in tool already uses stops boot.

Tool names never are `memory`, `session_search` or a single-underscore `mcp_` prefix, because a provider billing classifier flags them (`FORBIDDEN_TOOL_NAME`).

## System prompt

Sections render in this order, and each must be stable between requests so the prompt cache stays warm:

1. `system`: raw facts and rules. The message tag, tools and code mode, memory tools, doors, his call, scheduling, speaking, proof, safety, and the running chat channels. An agent seat also gets the people by id.
2. `identity`: voice and style. Who mochi is, the reply style, and one line per running chat channel with its bubble rule.
3. `memory`: how to read the view and zoom it. The view itself goes in the request, not the prompt.
4. `skills-index`: one line per bundled skill. The model opens a skill with `read`.
5. `codemode`: the inline library functions. `searchTools()` finds the deferred ones.
6. `context`: the context keys and `store()` keys the conversation holds, with their sizes. It is empty until a value exists.
7. `instructions`: for root, the owner's `<home>/agents/root.md` (required; `root.example.md` is the starting copy) followed by `<home>/instructions.md`; otherwise a definition's instructions. Root is the one definition a job cannot name.

A changed section reaches the next request as a mid-conversation system message that carries only the change, so a changed section does not break the cache.

## Memory and the context window

The transcript is the memory. The view follows uniichat's memory tree (github.com/VictorTaelin/uniichat, `Memory.ts` and `prompt.txt`), inside pi-durable. pi-durable stores the messages; mochi stores only the tree over them and the view of it. `settings.compaction.enabled` is false: nothing is summarized away.

Message i is the i-th non-system message of a conversation's model context. Over the messages grows a binary tree:

- Node (0,i) is message i, tagged `user:`, `agent:`, `tool:` or `echo:`, when it fits in 512 bytes (`NODE`). A longer message gets a one-line summary.
- Node (l,i) merges nodes (l-1,2i) and (l-1,2i+1) into one line of at most 512 bytes.

`src/memory/view.ts` holds the algorithm as pure functions with uniichat's names: `roots`, `halves`, `span`, `reach`, `merge`, `fit`, `todo`, `whole`, `blocks`, `zoom` and the `LEAF` and `MERGE` task text. A view lists nodes that cover the chat, oldest first. Each new message appends its node. When the view passes `HIGH` bytes (128,000; `MOCHI_VIEW_HIGH` sets it for a test), one batch merges the most-due adjacent siblings whose parent is built, down to half. A pair is due by `(T + 1) / 2^l - i`, its age from its last message in halves. So the view changes only at its end between batches, and the prompt cache stays warm.

The `mochi.view` document family holds one tree per standing conversation, keyed by conversation id: `start` (message 0's timestamp), `count`, `nodes` by slot, the chat's `view`, and the compactions' `seen` view (a quarter of `HIGH`). A reset or a manual compaction starts a new context, and the compactor starts a new tree for it. Forks and fresh agents have no tree.

The compactor (`src/memory/compactor.ts`) is one loop in the daemon. After each commit that adds entries, it brings each standing conversation's tree to its messages and builds due nodes oldest first, one commit per node, so a crash resumes at the next missing node. It stops at a tool result that pi-durable synthesized for a call still running. Each call goes to the memory model with uniichat's compaction prompt verbatim (`src/memory/prompt.ts`), the `seen` view up to the node, and the `LEAF` or `MERGE` task with the node's input. A line over 512 bytes is asked again with its size and where the limit cuts it, five tries at most, and the shortest is kept. A failed pass waits 5 s, doubling to 5 min, and logs `view.failed` each time. After 30 minutes of failure it notifies the owner once, through a run Turn on the owner's last channel, and again only after it has worked in between. There is no fallback summary: a node not built shows as `(not summarized yet: zoom it)`.

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
- Held inputs: chat and cli messages, board fire messages, resident jobs, child answers that merge back, proc wakes and child briefs.
- `context_read({ key, offset?, length? })` returns one page (64K chars by default) and the offset of the next. `context_put({ text })` keeps a script's value and returns its key and file path. `context_list` lists the catalog.
- The catalog forks `asOf`, like the codemode store. Compaction does not touch it, and the `context` section lists its keys after compaction.

## Agents

An agent definition is a named worker. It is a Markdown file, `<home>/agents/<name>.md` or the bundled `agents/<name>.md`, with front matter for `description`, `model`, `thinking`, an optional `tools` list and an optional `resident: true`. The body is its instructions. A home file with a bundled name replaces the bundled one. The name is the file name; a `name` field that differs throws. Files are read on each use, so an edit reaches the next job without a restart. The `agents` prompt section lists every definition, its description and a `(resident)` mark.

`agent({ jobs: [{ name, brief, fork?, definition?, context?, model? }], background? })` is the one way to start a child. It starts the jobs six at a time (`FORK_BATCH`) and resolves to `[{ name, answer }]` in job order. Each job is one `mochi.agent` task:

- **Fork** (`fork: true`). The task owns a fork of the caller at its newest entry. It keeps the caller's agent, history, codemode store and context catalog, so its first request reads the caller's prompt cache. A fork takes no `definition`.
- **Fresh.** The task owns a new conversation with no history. Without `definition` it has the caller's agent (seat, tools, instructions, owner). With a non-resident `definition` it runs as that definition: its model, thinking, tools and instructions.
- **Resident.** The `definition` is resident. The task owns no conversation. It submits the brief, tagged `[from <caller>]`, to the definition's standing conversation with `whenBusy: "followUp"`, and waits for that answer. `mochi.profile` keeps the conversation id by name, so a profile's history carries over.

`model` is a name from `[models]`, and overrides a fresh child's model; a resident runs on its own model, so `model` on a resident job throws. An unknown definition or an unconfigured model throws before any child exists. `context` names the caller's context keys to copy into the child, or into the resident's conversation. Use `fork` when the child needs this conversation, a fresh job for one slice of data, a definition when the work is its role, and `llm` for one completion without tools.

With `background: true` the call returns the names at once, and each answer merges back into the caller as a `[name]` note on its next turn. A foreground job to a busy resident does not wait, because that resident may be waiting on this caller. It returns an answer that starts with `NOT STARTED`, and its real answer comes back as a `[name]` note. Queued jobs merge into the resident's next turn and settle with one answer; `mochi.reply-delivered`, keyed by caller and answer, sends that answer back once.

A conversation's owner, in `mochi.profile-of`, is the definition it runs as. Its memory file is `<home>/memory/<owner>.md`, and a resident job's tag names it. A fork inherits its parent's owner.

`agent_stop({ name })` stops a resident: it aborts the resident's running turn, its queued submissions and the child tasks under its conversation, the same walk `/stop` does for root (`abortTargets` in `turn/commands.ts`). It does not stop processes or board items. A non-resident job is a child of its caller, so the caller's stop reaches it.

Depth is recorded. Root and standing conversations are depth 0. Each child records its caller's depth plus one in its task input, read before the creating commit's first write. There is no cap.

Each fork or fresh brief names its own scratch directory, `<work>/forks/<name>`, and tells the child to do code work in a git worktree of its own.

## The board

The board holds everything owed. One session document, `mochi.board-items`, keeps each item until `board_done` removes it.

```ts
type Item = { id; text; owner: "root" | string; when?: When; check?: string[]; gate?: Gate };

type When =
  | { at }                    // once, ISO time with an offset
  | { cron; tz }              // each slot
  | { webhook: { auth } };    // each POST /hooks/<id>

type Gate = { question; yes; no; threshold };
```

`board_add`, `board_list` and `board_done` are the library. The same id replaces. `owner` is `root` or a definition name. An item with no `when` is listed and never fires. A `gate` is only for a definition owner; on root it throws.

- **at** and **cron**: a `mochi.clock` task sleeps until each slot and starts one `mochi.fire` task per slot. When slots passed while the daemon was down, it fires once for the latest and says how many it skipped. A late `at` still fires at once. After its one fire the clock ends, and the item stays on the board until `board_done`.
- **webhook**: `board_add` makes the secret and returns the URL and the secret. `auth` is `bearer` or `hmac` (HMAC-SHA256 in `X-Hub-Signature-256`).

A fire runs `check` first, if the item has one, with the webhook body on stdin. Empty stdout ends the fire `quiet` with no model call. A check that fails puts its error in the message. Then the fire messages the owner with the item's text, the check output or the webhook body:

- **root**: a chat Turn on the owner's last channel. Root's final text is the reply, and `NO_REPLY` is silence.
- **a definition**: the message goes to its conversation: a resident's standing one, else a fresh one. Its final text goes to the owner verbatim as a run Turn, after the gate. `NO_REPLY` sends nothing. A gate below `threshold`, or a classifier error, sends nothing and logs it.

Webhooks arrive at `POST /hooks/<id>` on `[webhooks] host` and `port`. Authentication runs first, the body limit is 1 MB, and the handler answers 202 before the fire. A redelivery with the same delivery id starts nothing. Without `[webhooks]` in config, `board_add` refuses webhook items.

`proc_start` starts a `mochi.proc-watch` task in the calling conversation. When the process exits, the log tail enters that conversation (root through a chat Turn on the owner's last channel). A `watch` regex also wakes it once on the first matching line. `proc_stop` stops the process.

## Own tools

Each `<home>/tools/<name>.ts` default-exports one tool made with pi-durable's `defineTool`. A bare import in such a file resolves from mochi's own `node_modules`. The daemon loads every file at start, and `tools_reload` (agent seat) loads them again: a changed file is imported again with its mtime in the URL, a removed file drops its tool, and a file that fails to load, or takes a built-in name, keeps no tool. The result lists each file with the tool name now live, or its error. Home tools join the `seat-agent` extension as deferred script functions, so the prompt does not change; a reload shows from the next script, through `searchTools()`.

## Self-improvement

The `improve` board item runs `skills/improve` nightly. It follows Harness² (recursive agent harnessing), with one change: mochi does not rerun a task to compare harnesses, because its tasks act on the world. Instead `scripts/improve-check.ts` counts failure signals per owner turn since the last run (busy sends, side schedulers, lost children, timeouts, owner chases, duplicate replies) and writes the transcripts. The run judges each pending edit on its signal (helped, hurt, no observed effect, confounded), reverts a hurt one with git, then proposes from two dimensions (procedure and practice) with `llm` on the brain model, composes at most 3 edits, and applies them.

It edits only `<home>/skills` (which replaces a bundled skill of the same name) and `<home>/agents`, one git commit in `<home>` per edit. Code and config changes go to the owner as proposals. `<home>/improve/library.md` keeps every edit, its verdict and at most one transferable lesson per run, and each run reads it first. A window with fewer than 10 owner turns is quiet and grows until the next run.

## Models and config

`[providers.<name>]` is an endpoint, its protocol and the variable with its key. `api` is a pi-ai api id, and mochi loads that api's client from pi-ai itself (`@earendil-works/pi-ai/api/<api>.lazy`), so every chat and decision api pi-ai ships works with no list in mochi. Every provider names its `url` and `keyEnv`; nothing defaults. A gateway is one provider per protocol it serves. `[models]` must name `brain`, `fast` and `memory`, each `<provider>/<id>`. `classifier` names the decision model; without it, `classify` and gates fail. Every other key is a name of the owner's own. `[models.overrides]` sets a model's context window, output limit and cache life, and a model pi-ai's catalog does not know must have its context window and output limit there. mochi carries no prices: token counts stay, and the model provider bills.

Other config keys: `timeZone`, `[mcp.<name>]` (`url`, and `auth = "oauth"` or `auth = "bearer"` with `tokenEnv`), `[web]` (`keyEnv`, `url`, `browserProfile`), `[media]` (images, video, and speech through the OpenAI audio API on a named provider), `[[users]]` and `[webhooks]` (`host`, `port`, `url`, all required; absent, no webhook items). Boot logs one `setup` line per boundary, and names config keys mochi does not read.

Keys live in `<home>/.env` under the names config gives. Channel keys: `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `IMESSAGE_OWNER`. 

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
  fork/fork.ts      the child task and the agent tool: fork, fresh and resident jobs, depth
  agents/           definitions on disk, resident conversations, the owner of a conversation, agent_stop
  board/            cron parser, the board, its clock and fire tasks, webhooks, the one-time migration
  turn/             ingest and the Turn task, commands (/new, /stop, /status), handoff
  channels/         the channel interface, present(), iMessage, the terminal channel and its socket
  tools/            the owner's own tools in <home>/tools and tools_reload
  mcp/              MCP servers as script functions, and the OAuth login
  web/, browser/    web functions and the logged-in browser
  media/            images, video, speech, gifs, inbound attachments
  procs/            background processes and the watch that wakes their conversation
  attach/           the terminal side: the socket client, TUI, line modes, stop and doctor
  skills/           the skills-index section
  env/              the execution environment for the file and shell tools
```

## Decisions that still hold

| Decision | Why |
|---|---|
| No approvals, guard hooks or tool sandbox. | The owner trusts the model on their own machine. A prompt injection in a page or a mail can reach the daemon user's files and keys; that is the accepted cost. |
| Two model tools; everything else is a script function. | The first request stays small, and a script fans out work and filters data before the model reads it. |
| The final text is the reply; there is no `notify`. | One path reaches the owner. A definition's answer goes to the owner verbatim after its gate, and `NO_REPLY` makes silence the default for periodic checks. |
| Forks by default; fresh agents only for a slice of data. | A fork reuses the parent's prompt cache and knows the context. Measured live on Opus 5.5: each fork's first request read about 6,500 cached tokens and wrote about 225. A fresh `agent` pays its own prompt, so it is for bulk work on a cheaper model over context it is given. |
| One child noun: the agent definition. | Profiles and one-shot agents were two ways to define a worker. A definition is one file, and `resident` is the only difference. Resident agents live in the one daemon, with their own role, model, tools and memory. |
| uniichat's view instead of compaction. | Rewriting the whole prefix on every compaction lost detail each pass, and promises died at compaction. The tree builds each line once, every message stays reachable by `zoom`, and the view changes only at its end. |
| One board: a promise is an item with an `at`. | Of 23 commitments root made from Oct 6 to 14, 10 had nothing behind them. Schedules, triggers and a board meant several places to look and several sets of rules; one board of items, each with an owner and an optional `when`, is one list. |
| No caps on memory or context. | Sizes are reading budgets, not storage limits. Transport limits at HTTP boundaries and process timeouts stay. |
| No vendor names in the core. | Providers, the classifier, MCP servers and the web are config. The web client speaks Firecrawl's v2 API as its one adapter; MCP servers are plain MCP. |
| Verification is a live run on a copy of a store, not unit tests. | Without a daemon, `-p` and `chat` start no channels or board fires, so a copy reaches no one. |
