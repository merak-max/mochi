# Mochi spec, v0

Mochi is a personal agent that runs all day on this EC2 box. The owner messages it on WhatsApp, iMessage or Telegram, or from a terminal. It answers with Claude Opus 5.5, uses the owner's Executor apps as tools, keeps typed notes in a pi-durable document, searches past chats, runs shell commands and file edits in its work directory, and starts subagents. Crash recovery and message queueing come from `@earendil-works/pi-durable`.

Voice calls, the browser takeover link, and named persistent bots are out of scope for v0 and listed under [Later](#later).

## Settled decisions

These were decided with the owner. Do not reopen them in code review.

| Area | Decision |
|---|---|
| Runtime | Node 24, TypeScript run directly with type stripping. Pinned exact `@earendil-works/*` 1.2.0 from npm. |
| Brain | `anthropic/claude-opus-5-5` through Bifrost at `https://gateway.example.com/anthropic` with `x-bf-vk: $BIFROST_VIRTUAL_KEY`. Mochi holds no Anthropic credential and does no Claude Code impersonation. |
| Fast model | `azure/gpt-6-luna` through Bifrost's OpenAI route, for subagents and summaries. |
| Classifier | TypeSafe Jev (`typesafe/jev-1.13`) through OpenRouter directly with `OPENROUTER_API_KEY`, for yes/no and pick-one decisions before an Opus step. Not through Bifrost. |
| Tools | Executor MCP (`https://executor.example.com/mcp`) supplies the owner's app tools and the logged-in Firecrawl browser. pi-durable's `CodingTools` supply bash, read, edit and write, inside mochi's environment boundary (`src/env/`). Mochi builds notes, history search, and the library that pi-durable's `codemode` calls, which covers web search/fetch/map on its own Firecrawl key, the fast model, the classifier, the owner's apps, subagents and triggers. |
| Approvals | None. |
| Memory | Typed notes in one rewindable pi-durable document, `mochi.memory`, plus one SQLite FTS5 index over notes and past chats. No memory framework. No auto-generated skills. |
| Browser | Plain web reading: mochi's own `web_*` tools inside `codemode` on `FIRECRAWL_API_KEY`, ported from `~/.pi/agent/extensions/firecrawl-web`. Logged-in browsing: Firecrawl through Executor; scrape with a persistent `profile` first, then interact. |
| pstack | Bundled and trimmed to an assistant set in `skills/` and `agents/`. Mochi loads skills as on-demand instructions and runs `agents/*.md` as subagent types. |
| Harness | Opus 5.5 is a strong model, so the harness stays minimal: no guard, validator or second-guess layers around the model. pi-durable features are used where they delete mochi code or add a capability. |
| Tool names | Never `memory`, `session_search`, or a single-underscore `mcp_` prefix. Anthropic's billing classifier flags them. |

## Process shape

One daemon process owns everything:

- the Harness and its SQLite file `data/mochi.sqlite`
- the search index `data/index.sqlite`
- every channel adapter
- the scheduler
- the attach socket `data/mochi.sock`

Only one process may own the storage. The daemon takes a lock file `data/mochi.lock` at start and exits if another live process holds it.

Terminals attach to the daemon over the socket and never open storage. The socket carries one JSON object per line. The daemon streams the shown conversation's `watch()` frames and the `watchTaskGraph()` frames, each a value followed by Chord ops per commit, and answers requests by id (`src/attach/protocol.ts`).

| Command | What runs |
|---|---|
| `mochi` on a terminal | The TUI. It attaches to the running daemon. Without one, this process becomes the daemon, with every configured channel, until the TUI exits. Logs then go to `data/mochi.log`. |
| `mochi --headless`, or `mochi` with stdin not a terminal | The daemon alone. This is the systemd mode. |
| `mochi chat` (`npm run chat`) | Each stdin line goes to root, one at a time, and its answer prints as `mochi> ...`. It attaches to the daemon, or becomes a daemon with only the terminal channel and no triggers. |
| `mochi -p <prompt>` | Print mode: one prompt, then its reply. |
| `--id <key>` with `chat` or `-p` | Line n becomes message `<key>:<n>`, requestId `cli:<key>:<n>`. Rerunning the same script after a crash finds the same submissions and prints their answers without asking again. The eval harness uses this. |
| `--json` with `chat` or `-p` | The root view as JSON lines instead of replies: the value, then one ops batch per commit (pi-durable example 19). |

A terminal submits to root through `ingest` as channel `cli`, with requestId `cli:<id>`, so steering and `notify` work as for any channel. Nothing is delivered for `cli`: no Turn is opened. The TUI renders the transcript, and `chat` and `-p` print the answer of their own submission, so a reply never reaches an unrelated later client. `notify` to `cli` (no chat channel running) writes only its `app.notify` record into root, which the TUI shows. The socket file is mode 0600; when `<dataDir>/mochi.sock` exceeds the Unix path limit, it lives in the temp directory under a hash of the data directory.

The TUI follows pi's experimental durable TUI. It renders the shown conversation's view with pi's message components. `/agents` switches to another conversation, `/model` and Ctrl+L pick a model, Shift+Tab cycles thinking, `/compact [instructions]` compacts, Esc aborts the shown conversation's current work, `/stop` aborts everything it owns including background agents (Esc reaches only foreground ones), and Alt+Enter queues a follow-up. The activity panel (`/tasks` toggles it) lists the live task tree, what each task waits on, and spend per model from `harness.usage()`. pi-coding-agent does not export its editor keymap, status indicator, theme controller or tool renderers, so mochi keeps its own key table and a plain status line, and uses the default theme and the generic tool card.

## Conversation layout

- The owner has **one root conversation** across every channel. `harness.root()` is that conversation.
- Every inbound message becomes `root.submit({ type: "input", content, requestId, whenBusy: "steer" })`. The harness runs with `steeringMode` and `followUpMode` `"all"`, so a burst of texts that lands while an answer is written reaches the model as one turn.
- **Settle.** One background `mochi.settle` task of the line looks every 30 s at root and each user thread. A thread whose last request was at least 30,000 prompt tokens, idle and quiet for 4 minutes (inside the brain model's short cache life), is compacted once per quiet spell. The next message after a break then rewrites only the fast-model summary to the cache instead of the whole context.
- `requestId` is `<channel>:<channel message id>`. A redelivered message is submitted once.
- The content is prefixed with a one-line channel tag: `[whatsapp 2026-10-05 14:02 IST id=wamid.HBg...]`. The model sees where each message came from and the id it can react to.
- Each adapter is built for the owner's address from its variables and drops every other sender before `ingest` sees a message. The one exception is iMessage users (see below).
- **Users.** `data/config.json` can list `users: [{ id, handle, name?, persona? }]`. `id` is `user2`, `user3` and so on, unique; the owner is always `user1`. Only the iMessage adapter reads it. A message from a user handle carries `person` (the normalized handle). `ingest` sends it to the user's own conversation, which `ensureUser` creates on the first message and records in the `mochi.user` doc family. The user conversation has seat `user`, root's model, and instructions built from the user entry. A user message does not change `mochi.last-inbound`, so `notify` and `react` stay with the owner. `/new`, `/stop` and `/status` from a user act on the user's conversation. A user's replies use their own channel chain (`imessage:<handle>`), so they never wait behind the owner's replies. Reflect forks only root, so a user conversation never writes owner notes.
- Every owner message from a chat channel goes through `ingest` (`src/turn/turn.ts`). In one commit it checks `tx.submissionByRequest(root, requestId)` (set: a redelivery, nothing happens), opens a **Turn**, and records `mochi.last-inbound` and the channel's `mochi.inbound-cursor`; then it submits. Attachments are saved under `work/inbox/<messageId>/` and named in the input by path.
- A Turn (`mochi.turn` task) is one thing owed to the owner: `run` (submit the same input under the same requestId, wait for the answer), `claim`, `send`, and for a `notify`, `record`. Every Turn is a background task of the **line**, an ownerless conversation recorded in `mochi.line`, so neither Esc nor `/stop` on root reaches it. `/stop` withdraws a reply still being generated (the Turn ends silent); a reply mid-send and every notify finish.
- The claim commit takes `mochi.claim` `<answer entry>:<channel>` (the first claimer sends; a duplicate Turn ends `merged`) and appends the Turn to `mochi.channel-tail` for its channel; the Turn waits for the previous tail before its first bubble, so messages never interleave on a channel and a restart replays the same order.
- `send` checkpoints after each bubble, so a crash repeats at most the one bubble whose send and checkpoint it fell between. Typing runs while the answer is generated, stops after `typingMaxMs`, and its errors are ignored. Bubbles after the first wait `pace(bubble)`.
- Steers merge into the running answer. Each steered channel gets the answer once.
- **Other agents (A2A).** Hermes and other mochis reach mochi over A2A v1.0, JSON-RPC binding (`src/a2a/`). Each `(peer, contextId)` pair gets its own ownerless `peer` conversation, recorded in the `mochi.a2a-context` doc family. It stays out of root and the channels, and it has no A2A tools, so agents cannot loop. A message submits as `a2a:<peer>:<messageId>`, so a redelivery returns the same task. `mochi.a2a-task` maps each task id to its submission. GetTask reads the state from that submission, and only the peer that created the task may read it. SendMessage blocks until the answer or `MOCHI_A2A_REPLY_TIMEOUT_SECONDS`. With `returnImmediately` or `blocking: false`, it returns `TASK_STATE_WORKING` at once.

## Module map

```text
src/
  main.ts              arguments and modes, lock, open Harness, start channels, components and the attach socket, shutdown
  config.ts            reads env and data/config.json, parsed with TypeBox at the boundary
  setup.ts             Setup<T> readiness per boundary and the boot report lines
  env/
    work-env.ts        the ExecutionEnv: the default bash timeout and temp files in data/work/.tmp
  http.ts              request body reading with the 413 cap, constant-time compare, HMAC-SHA256 signature check
  pause.ts             abortable wait shared by the background loops
  attach/
    protocol.ts        attach requests, results and frames, JSON-lines framing
    server.ts          daemon side: watches, requests, and the `cli` channel
    client.ts          terminal side: the view and task graph applied from ops
    tui.ts             the TUI
    lines.ts           chat, print and JSON modes
  mochi.ts             openMochi: Harness.open, registry, environments, root and the line
  seats.ts             SURFACE (model tools), LIBRARY (script tools), BUDGET, the seat-<seat> extensions with codemode, createSeatConversation, the root seat
  journal.ts           Journal and journaled: a task-scoped record of what a call created
  apps/
    apps.ts            Executor MCP connection and the apps_search, apps_call, apps_skills functions
  brain/
    models.ts          createModels with the Bifrost providers and the OpenRouter classifier; agents/models.json ids to Bifrost refs
    classifier.ts      Jev classify and fail-open gates
    identity.ts        identity and channels sections (extension "identity")
    think.ts           llm and classify functions
  memory/
    memory.ts          mochi.memory document, note and recall (extension "memory"), owner and notes-index sections (extension "notes")
    feed.ts            the chat index's feed: catch-up from each conversation's entry cursor, then subscribeCommits
  notes/
    schema.ts          Note type, kinds, cap
    secrets.ts         credential scan for note writes
  skills/
    skills.ts          skills-index section, re-read when a SKILL.md changes (extension "skills")
  agents/
    catalog.ts         agents/*.md types and agents/models.json tiers and aliases
    subagent.ts        mochi.agent task (extension "agents") and the agent, agent_start, agent_send, agent_stop, agent_status functions
  web/
    client.ts          Firecrawl v2 client
    content.ts         Defuddle cleaning, focused extraction on the fast model
    web.ts             web_search, web_fetch, web_map functions
  index/
    fts.ts             SQLite FTS5 over notes and conversation entries
  channels/
    types.ts           Channel, ChannelProfile, Inbound, Bubble, Reaction, DeliveryError classes, channelSetup
    present.ts         reply text to bubbles, pure
    telegram.ts        grammY, long polling, TELEGRAM_PROFILE
    whatsapp.ts        WhatsApp Cloud API webhook and send, media upload, WHATSAPP_PROFILE
    imessage.ts        Photon spectrum-ts, IMESSAGE_PROFILE, catch-up and the probe-only judge
  turn/
    turn.ts            ingest, the Turn task, claims and channel chain, react (extension "channels"), delivery (extension "delivery")
  upgrade.ts           boot steps converting older live data (outbox to Turns, root seat, triggers to tasks, draining the old agent kinds, aborting a rollover checkpoint turn)
  triggers/            cron, once and webhook triggers, with classifier gates (see Jobs and webhooks)
  a2a/
    protocol.ts        A2A v1.0 wire shapes: agent card, parts to text, tasks, reading a peer's result
    server.ts          the agent card, SendMessage and GetTask for peers in MOCHI_A2A_PEER_TOKENS, one worker conversation per context
    tools.ts           a2a_list, a2a_ask, a2a_send, a2a_status against the peers in data/config.json
eval/                  live scenario eval, see Eval
docs/                  research brief, voice spec, identity prompt, eval results
```

The bundled `CodingTools` extension (bash, read, edit, write) comes from `@earendil-works/pi-durable/tools`. Every conversation runs it in `workEnv(workDir, cwd)` (`src/env/work-env.ts`) at its agent `cwd`, `data/work` by default, one environment per directory. There is no sandbox: the tools run as the daemon's user, see every path it can, inherit its whole environment, and have the network. A bash call without its own `timeout` stops after 600 seconds. Temp and spill files go to `data/work/.tmp`.

## Core types

```ts
// channels/types.ts
export type ChatChannelId = "imessage" | "telegram" | "whatsapp";
export type ChannelId = ChatChannelId | "cli";   // cli is a view: terminals render the transcript, nothing is delivered

export interface ChannelProfile {                // the one source for present(), typing, tapbacks and the channels line
  readonly id: ChatChannelId;
  readonly style: string;
  readonly maxBubbles: number;                   // 3: the rest merges into the last bubble
  readonly maxBubbleChars: number;               // a longer paragraph splits at a sentence end
  readonly paragraphsAreBubbles: boolean;        // iMessage only
  readonly reactions: readonly Reaction[];
  readonly typingMaxMs: number;
}

export const REACTIONS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
export type Reaction = (typeof REACTIONS)[number];

export type Inbound =                       // the owner or a configured user: the adapter dropped everyone else
  | { kind: "message"; channel: ChatChannelId; messageId: string; text: string; at: Date; attachments: readonly Attachment[]; sequence?: number; person?: string; replyTo?: ReplyTarget }  // person: a user's handle
  | { kind: "tapback"; channel: ChatChannelId; messageId: string; on: string; emoji: string; onText: string; fromAgent: boolean; person?: string; at: Date };  // messageId: the reaction event's id

export interface ReplyTarget { messageId: string; text: string; fromAgent: boolean }  // text "" when the platform did not send it

export type Bubble =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string }                // a URL alone; iMessage shows a link card
  | { kind: "file"; name: string; mimeType: string; bytes: Uint8Array };

export class DeliveryError extends Error {}
export class ChannelDown extends DeliveryError {}   // never left: retry
export class SendUnknown extends DeliveryError {}   // may have left (a timeout): retry once
export class SendRejected extends DeliveryError {}  // refused for good (an attachment type): skip

export interface Channel {
  readonly profile: ChannelProfile;
  run(sink: (inbound: Inbound) => Promise<void>, signal: AbortSignal, cursor?: () => Promise<number | null>): Promise<void>;  // until signal aborts; cursor reads mochi.inbound-cursor
  send(bubble: Bubble, person?: string, options?: { replyTo?: string }): Promise<void>;  // throws only DeliveryError subclasses; person absent: the owner; only iMessage reads replyTo
  typing(on: boolean, person?: string): Promise<void>;
  react?(messageId: string, reaction: Reaction | "none"): Promise<void>;
}
```

`present(text, profile)` (`channels/present.ts`) is pure. Blank text, meaning only whitespace and U+200B, U+FEFF and U+2060, gives no bubbles, so silence sends nothing; U+200D and U+200C are content and survive. On iMessage each blank-line paragraph is a bubble, a line that is only a URL is a link bubble, text under 12 characters merges into its neighbour, and a reply has at most three bubbles. Telegram and WhatsApp send one bubble per reply. Each adapter maps every platform error to one `DeliveryError` class: an unreachable service, 429 and auth failures are `ChannelDown`; a timeout or a 5xx is `SendUnknown`; any other refusal is `SendRejected`. The Turn sleeps to a stored retry time on `ChannelDown` (5 s doubling to 5 min; a channel absent from this process counts as down) and gives up after an hour of back-off with one `turn.undelivered` log line; it retries a `SendUnknown` once, accepting a possible duplicate; it skips a `SendRejected` bubble; any other throw faults the Turn and is logged with the answer.

On iMessage, a threaded reply carries `replyTo`. The model input gets one line after the tag: `[replying to your message id=<id>] <text>` when mochi sent the target, else `their message`. The text is a short quote, clipped to 80 characters, so the model can find the target without a second copy of it. When the target text is not available, the line says `(text not available; use recall)`. The first text bubble of the answer is then a threaded reply to the inbound message. iMessage emits tapbacks for reactions from the owner or a user. A tapback is a passive write to the reactor's conversation: `[context, no reply needed: user2 reacted 👍 to your message id=<id>: "<text>"]`. The adapter sends a read receipt for each message it accepts.

```ts
// notes/schema.ts
export type NoteKind = "user" | "rule" | "fact" | "person" | "project" | "preference";

export type Note = {
  slug: string;                                   // kebab-case
  kind: NoteKind;
  subject: string;
  writtenBy: "owner" | "mochi";
  source?: { conversation: number; entry: number };  // the assistant entry whose tool call wrote it, from the tool task's input
  updated: string;                                // ISO date
  body: string;
};

// memory/memory.ts: one document on the root conversation, written by every conversation. Version 2;
// version 1 also held `imported`, the hashes of imported data/notes files, which migrate drops.
// history "rewindable": snapshotAsOf(root, entry) reads memory as it stood when that root entry committed.
export type Memory = { notes: Record<string, Note> };
```

The pre-2026-10-05 `data/notes/<slug>.md` files are no longer read. A store that imported them keeps their notes in `mochi.memory`, with `writtenBy: "owner"`, and mochi cannot edit or forget those.

## Tools the model sees

Each conversation has a seat, written by `createSeatConversation` (the only caller of `createConversation`), by a fork (which keeps its parent's), or, for root, by the `root-seat` boot step. A seat is a trust level. `agent` is root and every copy of it (agents and forks): they get the same tools and prompt sections, so a fork's first request repeats its parent's prompt byte for byte and reads its cache, and any agent can start or fork agents. `trigger` is a trigger run, which reads outside data such as webhook bodies and mail, so it has no `note`, `react`, agent, fork, `trigger_add` or profile tools. `peer` is an A2A context or the line, with the apps, web and files but no `notify`, processes or A2A. `user` is a user's iMessage thread, another human. A conversation without a seat gets the `user` selection. The `one-agent-seat` boot step moves conversations from the retired seats: `owner` and any task-owned conversation to `agent`, an ownerless `run` to `trigger`, an ownerless `worker` to `peer`. `node eval/surface.ts` prints each seat's list.

The model sees at most three tools. `SURFACE` in `src/seats.ts` lists them:

| Tool | Seats | Behavior |
|---|---|---|
| `codemode` | all | pi-durable's durable code mode (`@earendil-works/pi-durable/codemode`). The model writes JavaScript that calls the seat's library as `await tools.<name>(args)` in a QuickJS sandbox. Each call is a nested `pi.tool` task of the codemode call. After a restart, the script replays from a journal of the results it got and continues; finished calls do not run again. A nested call running at the crash follows its own `replay`: `safe` reruns, `unsafe` returns an interrupted error. A script with no `// @options:` line gets a 10-minute `timeout_ms`. 256 MB. `store`/`load` persist per conversation in `pi.codemode.store`. The `codemode` prompt section declares the inline library tools; `searchTools()` finds the deferred ones. |
| `notify` | agent, trigger | Send a message to the owner or the trigger's recipients. Ends the run with `control.terminate`, which works only on a model-issued call, so it stays outside code mode. Refused in root, whose reply already reaches the owner. |
| `handoff` | agent, user | Start a fresh context from a note. Uses `control.handoff`, which works only on a model-issued call. Refused in a task-owned agent, whose answer goes back to its caller. |

Both are model-only (`callers: ["model"]`), so the `codemode` section does not list them.

The library, `LIBRARY` in `src/seats.ts`: every other tool, registered with `callers: ["tools"]` so only scripts call it. Opening mochi fails when `SURFACE` or `LIBRARY` disagrees with the definitions. `user` has no `note`, `react`, agent, trigger or app tools, and its selection leaves out the `notes` extension, so the owner's notes are not in a user's prompt.

| Tool | Replay | Behavior |
|---|---|---|
| `note` | safe | Create or replace one note in `mochi.memory`, with the codemode call's assistant entry as its source; an empty `body` forgets it. Refuses a credential (secret scan), an edit or removal of an `owner` note, and a write that would push the always-in-prompt notes (`user`, `rule`) past 4,000 characters total. |
| `history` | safe | All seats but `user`, deferred. Past chat as rows `{ at, kind, entry, conversation, text }`, oldest first, up to 2,000 per call, for a script to filter, chunk and map over `llm`; only what the script prints reaches the model. `everywhere` adds trigger and agent runs. |
| `recall` | safe | With `query`: FTS5 BM25 search over past chat text and notes, optional `after`, `before`, `limit` (default 10, at most 30). Chat hits are snippets with entry ids and timestamps; note hits carry the whole note. Subagent and scheduler conversations rank below the root. With `entry`: the five entries before and after it. With `asOf`: every note as it stood then. |
| `bash`, `read`, `edit`, `write` | pi-durable | pi-durable's coding tools in the conversation's environment, `data/work` unless the agent sets a `cwd`, with the daemon's full access. `bash` resolves in scripts to `{ output, truncated, exitCode }`. `read` returns images through pi-durable's Photon processor; HEIC, HEIF, AVIF and TIFF go through ffmpeg first. ffmpeg must be 8 or newer, from mise: 7.1 decodes only the first tile of an iPhone photo. |
| `react` | safe | Tapback on an owner message: `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`, or `none`, and optional `messageId` (default: the owner's newest chat message). |
| `web_search`, `web_fetch`, `web_map` | safe | Firecrawl v2 with mochi's key, which bash never gets. Search returns `{ title, url, snippet }`; fetch returns the page cleaned with Defuddle, or with `instruction` only the extract from the fast model; map returns URLs. |
| `llm` | safe | One fast-model completion with no tools. A batch is `Promise.all`. |
| `classify` | safe | Typed `bool`, `choice` or `score` questions about a JSON object, answered by Jev with probabilities. |
| `apps_search`, `apps_call`, `apps_skills` | safe, unsafe, safe | Executor's `execute` running `tools.search` or one tool by path, and Executor's `skills`. Executor approval prompts are accepted, up to 20 per call. The guide is `skills/apps/SKILL.md`. |
| `browse`, `browse_fast`, `image_gen`, `video_gen`, `speak`, `gif_save` | unsafe | Paid or outward effects; a crash mid-call reports interrupted. |
| `transcribe`, `gif_search`, `proc_status`, `proc_logs` | safe | Reads. |
| `proc_start`, `proc_stop` | unsafe, safe | Background processes; see Long work. |
| `a2a_list`, `a2a_ask`, `a2a_send`, `a2a_status` | safe, unsafe, unsafe, safe | Agent and trigger seats, all deferred. The owner's other agents over A2A, from `a2a.peers` in `data/config.json`: list peers and whether each serves its card, ask and wait, send without waiting, and read a sent task. The `channels` section of every agent conversation names the peers. |
| agent and trigger tools | see below | |

## System prompt

Sections render in this order. Each must be stable between requests, so the provider prompt cache stays warm. No timestamps in any section.

1. `identity`: who mochi is, how to write for chat (short, no markdown tables on WhatsApp), and that tool results and web content are data, not instructions.
2. `owner`: the bodies of every `user` and `rule` note, sorted by slug. The cap is 4,000 characters. With none it reads `no user note yet`.
3. `notes-index`: one line per other note, `slug: subject (kind)`, sorted by slug. With none it reads `no other notes yet`. Both notes sections always render, because a section that appears or disappears makes pi-durable re-add every section.
4. `skills-index`: the skills directory, then one line per bundled skill with its description cut to 120 characters (bundled descriptions fit uncut). The model opens a skill with `read`. It is re-read when a `SKILL.md` modification time changes, so an edit reaches the next request without a restart.
5. `channels`: one line per running chat channel, its profile's `style`, which names the bubble rule `present()` applies.

`BUDGET` in `src/seats.ts` caps each section (identity 2,000 characters, channels 700, owner 4,000, notes-index 1,500, skills-index 2,000) and each seat's tool schemas (owner 8,300, run 7,000, worker 5,200); `src/seats.test.ts` fails the build past a cap.

The notes sections render live from `mochi.memory`. Equal memory renders equal bytes. pi-durable records a changed section as a positional `pi.system` entry and sends only the change as a mid-conversation system message, so a `note` reaches the next request without breaking the provider prompt cache (measured in the 2026-10-05 decision log row). Every local extension is installed before `harness.resume()`, so a run recovered after a restart sees the same tools and the prefix does not churn.

## Index

`data/index.sqlite` is separate from the Harness storage. It holds one FTS5 table:

```sql
CREATE VIRTUAL TABLE docs USING fts5(
  text, kind UNINDEXED, ref UNINDEXED, conversation UNINDEXED, at UNINDEXED,
  tokenize = 'porter unicode61'
);
```

- `kind` is `user`, `assistant` or `note`.
- Tool results are not indexed, and neither is the output of `recall`.
- The feed (`memory/feed.ts`) subscribes to commits, then catches up: for each conversation it scans entries past the stored entry cursor and inserts the user and assistant text, advancing the cursor in the same SQLite transaction. After that, each commit that appends entries indexes its conversations at once. A kill between a commit and the index write is caught up at the next start.
- Notes are reindexed on every `note` write, and from `mochi.memory` at start.
- The index can be rebuilt from scratch: deleting `index.sqlite` and restarting must reproduce it.

## Jobs and webhooks

Three kinds of work start without the owner typing. All three share one rule: **the run happens in its own conversation, and only the `notify` tool reaches the owner.** A run that ends without calling `notify` is silent. Silence is the expected result for most periodic checks.

A trigger's `notify` field lists recipient ids: `user1` is the owner, and `user2` and up are configured users. The default is `["user1"]`. One `notify` call checks `notifyWhen` once, then opens one Turn per recipient; a user's Turn goes on iMessage. Root's `channels` section lists the users by id, so mochi can choose recipients.

Triggers are the main agent's way to run itself later: root creates them with `trigger_add` inside `codemode`, and a trigger run may remove its own trigger but not add one. There is no built-in heartbeat; a periodic check is a `cron` trigger the model or config creates.

### Triggers

```ts
// triggers/types.ts
export type Trigger =
  | { readonly kind: "cron"; readonly id: string; readonly cron: string; readonly tz: string; readonly prompt: string; readonly notifyWhen?: Gate; readonly notify?: string[] }
  | { readonly kind: "once"; readonly id: string; readonly at: string; readonly prompt: string; readonly notifyWhen?: Gate; readonly notify?: string[] }
  | { readonly kind: "webhook"; readonly id: string; readonly auth: WebhookAuth; readonly prompt: string; readonly admitWhen?: Gate; readonly notifyWhen?: Gate; readonly notify?: string[] };  // notify: recipient ids, default ["user1"]

// A yes/no question for the classifier. Passes when P(yes) >= threshold (default 0.5). A classifier error passes.
export interface Gate { readonly question: string; readonly yes: string; readonly no: string; readonly threshold?: number }

export type WebhookAuth =
  | { readonly kind: "hmac-sha256"; readonly header: string; readonly secret: string }   // GitHub: X-Hub-Signature-256
  | { readonly kind: "bearer"; readonly token: string };
```

Each trigger is one durable `mochi.trigger` task, a background task of the trigger's own conversation. Its input is the definition with an `origin` (`model` or `config`), and its checkpoint holds the absolute next slot, so the task record is the only copy of the schedule. The daemon reconciles the `data/config.json` seeds at start: an equal seed is left alone, a changed one is re-added in its conversation, a config trigger whose seed is gone is aborted, and a model trigger is touched only when config claims its id. The `triggers-to-tasks` boot step converted the old `mochi.triggers` document once. Without a daemon (`mochi chat`, `-p`) the task kind is not installed, so triggers wait for one.

### Runs

- Each trigger owns one `ownerless` conversation, created with the trigger. Each run starts from a keyed `pi.reset` whose handoff is the last run's closing note (its final text, or what it notified), so a run never resends the trigger's history and the cached prefix stays small. Older runs stay searchable with `recall` and `history`. Re-adding an id reuses the conversation. Nothing owns it, so root's `/stop` never reaches a trigger.
- A trigger's `role` names an agent type (`agents/<role>.md`, or the owner's own in `<dataDir>/agents/`). The role's instructions follow the trigger's, and its `model` and `thinking` are the run's defaults. The trigger's own `model` and `thinking` override the role's. With neither, a run uses the `fast` tier. The `trigger-agents` boot step re-applies this to every live trigger, so an edited role file reaches the next run.
- The task plans the next slot with the pure `plan(trigger, last, now)`, sleeps to it with `runtime.sleep`, then submits `{ type: "input", content, requestId }` with `whenBusy: "followUp"`. A slot that finds the previous run still busy keeps its context and queues behind it; the run deadline still ends a hung run.
- `requestId` is `<kind>:<id>:<slot ISO>` or `webhook:<id>:<delivery id>`. A restart inside a slot never double-fires. A cron slot more than 15 minutes late (downtime) is recorded `missed`; a `once` always fires, late if it must.
- A run still going 30 minutes after it started is aborted (the conversation's ordinary scope; the trigger task is background and survives) and recorded `timed-out`, so a hung run cannot block later slots.
- `trigger_remove` aborts the trigger task, never its conversation, so a run that removes its own trigger finishes its turn.
- The trigger conversation has seat `run`, root's model and thinking level, written when it is created: `notify`, and `trigger_list` and `trigger_remove` inside `codemode`; no `react`, `agent` or `trigger_add`.

### Gates

- `admitWhen` (webhooks): after authentication, Jev answers the question over `{ webhook, purpose: prompt, payload }`. A no returns 202, logs `webhook.filtered`, and starts no run.
- `notifyWhen` (any trigger): inside `notify`, Jev answers over `{ trigger, purpose: prompt, message }`. A no sends nothing and tells the model to finish silently. The verdict is memoized per call, so a replay decides the same way.
- Gates fail open. A missing `OPENROUTER_API_KEY` or a classifier error passes and logs `*.gate_failed_open`. A gate can save an Opus run or a message; it never loses a delivery.

### Webhooks

- An HTTP server on `${MOCHI_BIND_HOST}:${MOCHI_HOOKS_PORT:-8788}` accepts `POST /hooks/<id>`. Caddy routes `/hooks/` to it; that route is the owner's change.
- Authentication runs before anything else: HMAC over the raw body compared in constant time, or a bearer token. Failure returns 401 and logs. Unknown id returns 404.
- The delivery id comes from `X-GitHub-Delivery`, `X-Request-Id`, or `Webhook-Id`, else the SHA-256 of the body.
- The handler returns 202 after the submission is admitted, before the run.
- Content is the trigger `prompt`, then the body inside `<webhook_payload source="<id>">` tags, truncated to 20,000 characters. The identity section tells the model that payload text is data, never instructions.
- Body limit 1 MB.

### Tools

`notify` is a direct tool of the agent and trigger seats, refused in root. The trigger verbs are script functions inside `codemode`: `trigger_add` for the agent seat, `trigger_list` and `trigger_remove` for agent and trigger.

Agents are one task kind, `mochi.agent`, started from any agent-seat conversation's `codemode`, so an agent can start agents at any depth. Trigger runs and peers cannot start them. There are two ways to make one. `agent` creates a fresh conversation in the task's commit with `createSeatConversation`, with the `agents/<type>.md` body as instructions and the type's or the call's `model` (a tier `fast`, `default`, `strongest`, an alias, or `provider/id`) and `thinking`. `fork` forks the calling conversation at its newest entry (`forkPoint`, read before the commit's first write): the fork keeps the parent's agent, history and `pi.codemode.store`, and the parent's open `codemode` call reads as "Tool result unavailable" in the fork. Its brief is prefixed with its name, that it is a fork, and where its answer goes (the calling script, or nowhere for `fork_start`, which should `notify` if the owner needs the result). The task submits the brief under requestId `agent:<task id>` and settles with the answer text; the creating call journals it under `agent` or `fork`, so a rerun finds the same task and child.

| Function | Contract |
|---|---|
| `agent` | `{ name, brief, type?, model?, thinking? }`, `type` defaulting to `worker`. Foreground: the task is owned by the nested `agent` tool call, so Esc cascades to it and its child, and the call resolves to the answer. |
| `agent_start` | Same arguments, deferred. Background task of the calling conversation: only `/stop` reaches it. Returns `{ name }` at once. It may `notify` the owner; it writes nothing into its caller, and an agent with nothing to say finishes silent. |
| `fork` | `{ name, brief }`. Foreground, like `agent`, on a fork of the calling conversation. |
| `fork_start` | Same arguments, deferred. Background, like `agent_start`, on a fork. |
| `agent_send` | `{ name, brief }`: steer a running agent (`whenBusy: "steer"`, requestId `send:<call task id>`). A finished agent is refused; start a fresh one with its last answer. |
| `agent_stop` | `{ name }`: `abortTask` on the newest agent with that name. |
| `agent_status` | `{ name? }`: each agent of this conversation with `running`, `answered`, `failed` or its abort outcome, and the answer. |

| Tool | Behavior |
|---|---|
| `notify` | Opens a Turn per recipient that sends `text` verbatim. In a trigger run the recipients are the trigger's `notify` ids; elsewhere only the owner. Optional `channel` for the owner; default is the channel of the owner's newest chat message. A user always gets iMessage. After the send, the Turn writes one passive `app.notify` entry into the recipient's conversation (root for `user1`), `[context, no reply needed: told <id> on <channel>, from <trigger or conversation>] <text, at most 280 characters>`, so a reply has context. No turn runs. Idempotent per tool call and recipient through `mochi.journal`. |
| `trigger_add` | `{ id, prompt, when, tz?, auth?, admitWhen?, notifyWhen?, notify? }`. `notify` takes ids only and rejects an unknown id with the list of valid ones. `when` is five cron fields (tz defaults to the owner's), an ISO time with offset, or `webhook`. Validates the cron expression and time zone. For a webhook it generates the secret or token and returns it with the public URL `${MOCHI_PUBLIC_URL}/hooks/<id>`, because the owner or a tool has to configure the sender. Re-adding an id replaces the trigger and keeps its conversation. |
| `trigger_list` | Live triggers, including one added a moment ago: `when`, `origin`, next slot, last result (`done`, `unanswered`, `skipped-busy`, `missed`, `timed-out`). |
| `trigger_remove` | Abort a trigger's task by id; a run may remove its own. Its conversation stays for history. A config trigger returns at the next start. |

### Files

```text
src/triggers/
  types.ts        Trigger, WebhookAuth, TypeBox schemas
  cron.ts         5-field cron parser and next-slot computation, no dependency
  trigger.ts      the mochi.trigger task, plan, seeds, notify, trigger_add, trigger_list, trigger_remove
  webhooks.ts     HTTP server, auth, delivery id, submit; the daemon component that reconciles seeds
```

## Configuration and secrets

Environment variables. Names only here; values live in the owner's shell secrets.

- `BIFROST_VIRTUAL_KEY`
- `OPENROUTER_API_KEY` (classifier; optional)
- `FIRECRAWL_API_KEY` (web tools; optional)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`
- `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_OWNER`
- `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `IMESSAGE_OWNER`
- `MOCHI_DATA_DIR` (default `./data`)
- `EXECUTOR_URL` (default `https://executor.example.com/mcp`)
- `MOCHI_BIND_HOST` (default `127.0.0.1`; set `172.17.0.1` on this box so the Caddy container reaches mochi through the Docker host gateway, the same way it reaches t3)
- `MOCHI_HOOKS_PORT` (default 8788), `MOCHI_PUBLIC_URL` (the Caddy origin, for webhook URLs)
- `MOCHI_A2A_PEER_TOKENS` (`name:token,name2:token2`; unset keeps the A2A server off), `MOCHI_A2A_HOST` (default `127.0.0.1`), `MOCHI_A2A_PORT` (default 8789), `MOCHI_A2A_PUBLIC_URL`, `MOCHI_A2A_AGENT_NAME` (default `mochi`), `MOCHI_A2A_REPLY_TIMEOUT_SECONDS` (default 600)
- One variable per outbound peer token, named by `tokenEnv` in `data/config.json`: `"a2a": { "peers": { "hermes": { "url": "http://127.0.0.1:9900", "tokenEnv": "HERMES_A2A_TOKEN", "timeoutSeconds": 600 } } }`

Each channel logs one readiness line at boot: `ok`, `off` when none of its variables is set, or `fix` naming the missing variables or the bad value. A channel that is not ready does not run, and the daemon starts anyway.

Executor uses MCP OAuth. Mochi stores its own OAuth client and tokens in `data/executor-auth.json` (mode 0600) through `@earendil-works/pi-mcp/oauth`. First run prints the authorization URL. `mochi auth executor` runs the login flow interactively. Never copy another client's tokens.

## Failure behavior

- Executor down or unauthorized: the apps functions throw one line saying so, and the connection retries every 60 seconds. Nothing the model sees changes.
- A script function failure rejects that call inside the script with the error text.
- Channel send failure: by `DeliveryError` class, see Channels. The answer stays in the transcript.
- Model error after pi-durable retries: the submission settles `unanswered`. The Turn sends a one-line failure notice to the channel.
- Crash mid-turn: on restart `harness.resume()` continues the run and every live Turn. A local `chat` or `-p` with no daemon does not install the Turn task kind, so its Turns wait for the daemon. `src/upgrade.ts` turned the Router's pending `mochi.outbox` into Turns and retired `mochi.outbox` and `mochi.route` (U5).

## Build order and verification

Each unit ends in a state that can be checked on its own.

| Unit | Contents | Verified by |
|---|---|---|
| U1 core | config, models, harness, prompt, notes, recall, index, skills, router, main, scheduler | `npm run typecheck`. `npm test`, with unit tests on notes schema and store, FTS index, cron parser, and router routing with a faux model. A live CLI turn against Bifrost Opus that writes a note, then finds it with `history_lookup` in a later turn. A kill and restart mid-turn that resumes. |
| U2 executor | Executor MCP extension | List tools against the live Executor after the owner authorizes. Call `x_firecrawl_firecrawl_search` from a CLI turn. NOT VERIFIED until the owner completes OAuth. |
| U4 triggers | `src/triggers/*`, wiring in `main.ts` and the registry | Unit tests: cron next-slot across DST-free IST and a UTC zone, once at start, `admitWhen` and `notifyWhen` pass, block and fail open, webhook HMAC accept and reject, bearer, duplicate delivery submitted once, busy skip, a silent run sends nothing, a `notify` run sends once across a restart. Live: a cron check against Opus, a gate against Jev, and a curl to `/hooks/<id>` with a valid signature. |
| U3 channels | telegram, whatsapp, imessage adapters | Unit tests on payload parsing and owner filtering, with recorded fixtures. Live only when the owner supplies credentials. WhatsApp needs a public webhook route on Caddy, which is the owner's change. |
| ~~U5 context rollover~~ Removed 2026-10-06 (architect U10). | `context/rollover.ts`: in the 04:00 to 06:00 window, once root is idle 30 minutes, a `rollover:<date>` checkpoint turn saves durable facts with `notes_write`, then `root.reset(handoff)` with at most 15 lines. Built-in compaction handles size within a day. | `src/context/rollover.test.ts` on a faux model: idle root checkpoints then resets with a capped handoff and sends nothing to a channel; busy or recently active root waits; nothing new since the last reset skips; an owner message during the checkpoint skips the reset; a restart inside the window resumes the day's rollover instead of repeating it. NOT VERIFIED live at 04:00. |
| U5b memory | `notes/memory.ts`, `tools/notes.ts`, live prompt sections, file import | `src/tools/notes.test.ts`: a write reaches the next request's `owner` section and the index with its source entry; `notes_read asOf` returns the earlier body; `notes_forget` removes from memory and index; secret, owner-note and cap refusals; a file is imported once, even after it or the note changes. Live: Opus saved "dog is Biscuit" and answered it on the next turn from the prompt with no tool call. |
| U6 tools | `CodingTools` with a per-directory environment, `skill_read` paths, `agent` family replacing `spawn` and `subagent`, receipts | `src/tools/agents.test.ts`, `src/tools/receipts.test.ts`, `src/tools/codemode.test.ts`. Live through `mochi -p`: bash `echo ok`, `skill_read mochi-mode playbooks/errand.md`, a path escape refused, a foreground `worker` agent on haiku (Luna) answered 391 for 17*23, and a background `worker` agent's completion arrived as one follow-up that mochi reported. |
| U7 terminal | `src/attach/*`, modes in `main.ts` | Live: `mochi chat` piped two prompts against an attached daemon and in-process; `-p` and `-p --json`; the TUI in a tmux pane rendered a prompt and its answer, the activity panel and spend. Crash: a `chat` run killed with SIGKILL during a `sleep 15` bash call, then the same `mochi chat --id eval1` resumed it (the bash call got an interrupted result and the model reran it) and printed the reply. A third run printed the same reply from the same submission (8) without a model call, and the transcript holds one answer. A later unrelated `-p` printed only its own reply. |

## Eval

`eval/` runs scripted owner scenarios against live Opus and grades them. Each scenario is one entry in `eval/scenarios.ts`: the situation, the past turns, the files, the owner's messages or a trigger, and what the grade expects.

| File | Job |
|---|---|
| `run.ts` | `node eval/run.ts <label> [ids] [--repo <dir>] [--regrade]`. For each scenario, seeds a clean data directory, drives it, dumps every conversation to `transcript.json` and `transcript.md`, and grades it. Writes `eval/runs/<label>/summary.md`. |
| `clock.ts` | Preload that shifts `Date` by `MOCHI_EVAL_SKEW_MS`, so every scenario happens on Tue 2026-10-06 in Asia/Kolkata at its own hour. |
| `seed.ts` | Replays past turns on the faux model through the real `ingest` and `note`, resets with a handoff, adds a model-made trigger, and builds the index. Costs no model calls. |
| `drive.ts` | The live part. Owner messages enter through `ingest` as the scenario's phone channel with fixed message ids, so a rerun after SIGKILL finds the same submissions. Whatever the channel would send goes to `sent.jsonl`. Trigger scenarios fire the seeded `once` trigger task on the daemon. `--repo` loads mochi's code from another checkout. |
| `dump.ts` | Opens a stopped data directory without resuming and lists every conversation's entries. |
| `grade.ts` | Hard checks: every turn answered and sent once, length, banned phrases, no blank message, no markdown table or heading, no timestamp in prompt sections, every claim of an act backed by a successful non-read tool in the same turn, expected mentions and tools, forbidden calls, notify count, booking count. |
| `judge.ts` | `node eval/judge.ts <baseline> <candidate>`. Blind pairwise judging by Opus 5.5 and GPT-6.1 Sol, each in both orders. |
| `variant.ts` | Copies the checkout with a different identity section, for voice runs that leave `src/` alone. |
| `surface.ts` | Prints every tool and prompt section the root conversation's first request carries, with byte sizes. |

Results and transcripts are in `docs/eval.md` and `eval/runs/`.

## Later

- Voice: Vapi with Azure DeepSeek V4.1 Flash, an `ask_brain` endpoint, Exotel for +91 numbers, and Pipecat for inbound WhatsApp calls.
- Firecrawl `interact` tool, if Executor does not expose it once authenticated.
- Named persistent bots with inboxes.
- Remote attach to the systemd daemon from another machine, through pi-server and pi-client. The local Unix socket covers this box.
- Errands as `defineTask` tasks with phases, the task id as the idempotency key toward outside services, and an `abort` handler that undoes what it can. Waits for the first concrete errand with an undo (a booking, a draft). Until then an errand is an agent, and the kill switch is a task-tree abort.
- `MemoryStorage` for unit tests that never restart. Tests open SQLite files today because many reopen the same directory to simulate a restart.
- Secure-input page.
- A memory eval of about 50 questions from real chats: search versus full context on Opus 5.5.
- Typed WhatsApp templates for messages mochi starts outside the 24-hour window.

## Git memory and reflect

Mochi publishes typed durable notes into a separate local Cognition-style memory repository, defaulting to `<home>/memory`. `MemoryDoc` remains canonical for reads, provenance, owner protection, and rewind. Every edit queues an immutable snapshot and persistent Git publication proof. Native tasks replay local commits without pushes or imports of human edits. Human edits block publication rather than being overwritten. See [Memory repository](docs/memory.md).

**Reflect.** When the settle task is about to compact root (quiet past 4 minutes, inside the cache life), it first starts a background `mochi.agent` task on a fork of root with `REFLECT_BRIEF`: save lasting facts, standing rules and corrections with `tools.note`, update rather than duplicate, message no one. The fork is journaled in the settle task under `reflect:<last turn time>`, so one quiet spell forks once even across a crash. The fork has root's whole context and reads root's cache; `note` applies its usual checks (secret scan, owner notes, the 4,000-character cap on `user` and `rule`). `memory.reflect = false` turns it off. It replaced nightly Dreaming on 2026-10-14; the `retire-dreaming` boot step settles a live `mochi.dream` task and retires `mochi.dream`, and a config that still has `[memory.dreaming]` is read and ignored.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-05 | WhatsApp uses mochi's own Cloud API adapter (`channels/whatsapp.ts`), not Spectrum's WhatsApp provider. | Spectrum direct mode relays the Meta token and every message through `whatsapp-business-grpc.spectrum.photon.codes`. WhatsApp is listed only on Photon's $250/line Business plan. Our adapter keeps credentials on the box and costs one Caddy route. The Meta app webhook must point at mochi, not Photon. |
| 2026-10-05 | iMessage stays on Spectrum's free tier. | No self-hosted option on Linux. Verified reachable to the owner's +91 handle. |
| 2026-10-05 | Triggers run in their own conversations and reach the owner only through `notify`. | Keeps the root transcript and its prompt cache clean, makes silent periodic runs the default, and gives one delivery path for cron, once and webhook runs. |
| 2026-10-05 | Webhooks get their own port, 8788, instead of sharing the WhatsApp server. | The WhatsApp adapter owns its server. Caddy routes by path either way. |
| 2026-10-05 | Port mechanisms from Pi extensions; install none. | Every memory extension except `pi-durable-components` targets the coding-agent API. `pi-durable-components/context` pins pi-durable 1.0.2 exactly, owns the submit path, disables compaction, and brings untyped notes that would compete with ours. Ported instead: secret scan on notes (pi-hermes-memory), history that skips visible context (pi-posthorse), preferences kept through compaction (pi-vcc), nightly checkpoint and `reset(handoff)` (pi-durable-components/context), durable schedule loop as reference (pi-pocket). Unit U5. |
| 2026-10-05 | Channels expose `react`. | Owner request. Native on WhatsApp and Telegram; iMessage via tapbacks if the SDK supports it. |
| 2026-10-05 | Heartbeat removed; periodic checks are `cron` triggers. | Owner request. Cron and webhooks are the main agent's tools for running itself; a fixed checklist note was a second mechanism for the same thing. |
| 2026-10-05 | Jev classifier gates on webhooks (`admitWhen`) and `notify` (`notifyWhen`), plus a `classify` tool. Per-message thinking effort was rejected. | Live probe: Jev ~300 ms and ~$0.00002 per call, decisive on clear cases, low confidence on ambiguous ones, so it gates cheap yes/no decisions and fails open. pi-durable itself never calls classifiers. |
| 2026-10-05 | Ported firecrawl-web, pi-processes and pi-subagents' mechanism; added codemode from `@earendil-works/pi-codemode`. | Owner request to make them first class. The pi packages target pi-coding-agent's `ExtensionAPI` and TUI, so the mechanisms were ported, not installed. Background subagents follow pi-durable's own example 23. codemode adds `llm` (a batch is `Promise.all`, 8 in flight) so Opus can hand data slices to Luna, after prime-agent's RLM harness. `history` (2026-10-14) gives a script the transcript as rows to slice. |
| 2026-10-05 | Smart model, minimal harness. No injection-defense hooks, no done-claim check on answers, no approval prompts. | Owner decision. Opus 5.5 follows the identity section's rule that tool and web content is data. pi-durable features are used where they delete mochi code or add a capability: memory documents, agent tasks and the kill switch, compaction, the attach view. |
| 2026-10-05 | Memory moves from `data/notes/*.md` into the rewindable root document `mochi.memory`. ~~Tool names stay `notes_*`, because the skills call them that.~~ Renamed 2026-10-06 (architect U3). | Owner decision ("pi durable already has memory, we can remove notes"). A write commits with its source entry; `snapshotAsOf` answers "what did you believe on that date" and lets mochi restore a bad note. One document on root, not a session family, because only conversation documents are rewindable. Existing files are imported once at start. |
| 2026-10-05 | The frozen `mochi.notes-snapshot` is removed; memory sections render live. | Measured through Bifrost on Opus 5.5 with a 20,785-token prefix: after a mid-conversation system message replaced one section, the next request read 20,797 tokens from cache and wrote 73, and the model used the new section. pi-durable sends only changed sections, so the snapshot bought nothing. |
| 2026-10-05 | One `agent` tool family (`agent`, `send_message`, `list_agents`, `stop_agent`) replaces `spawn` and `subagent`. | Matches the pstack tool contract the bundled skills are written against. Foreground and background are pi-durable examples 22 and 23; `agents/*.md` load generically, and tiers resolve through `agents/models.json`. |
| 2026-10-05 | ~~Receipts are one wrapper applied by name to outward tools, appending to `mochi.receipts`.~~ Removed 2026-10-06. | Nothing read `mochi.receipts`; tool task records are the audit. |
| 2026-10-05 | Terminals attach to the daemon over a Unix socket with mochi's own JSON-lines protocol, not pi-server and pi-client. | The protocol is pi-durable's `watch()` frames plus nine requests, about 300 lines with the client. pi-server routes facet services over CBOR and needs the experimental session-worker plumbing (about 2,000 more lines) to host a Harness. Remote attach is under Later. |
| 2026-10-05 | ~~Triggers keep the 15-second polling scheduler.~~ Reversed 2026-10-06 (architect U8, owner decision 1). | |
| 2026-10-06 | Triggers are tasks (architect U8): one `mochi.trigger` task per trigger in its own ownerless conversation, sleeping to an absolute slot; the 15-second tick and `mochi.triggers` are gone. A cron slot more than 15 minutes late is recorded missed; a run past 30 minutes is aborted and recorded `timed-out`. The trigger verbs moved into `code`. | The task input is the only copy of the schedule, so the old "second copy" reason no longer holds. A SIGKILL mid-sleep fires the slot once; root's `/stop` cannot reach a trigger; a hung run no longer blocks later slots. Live-store copy: the empty `mochi.triggers` retired once, a second boot did nothing. |
| 2026-10-05 | ~~Built-in compaction plus the nightly `reset(handoff)` rollover; no `beforeCompact` hook.~~ Reversed 2026-10-06 (architect U10, owner decision 2). | Memory renders as a prompt section, so compaction cannot drop it. The rollover already uses pi-durable's `reset(handoff)`; it adds only the daily window and the checkpoint turn, which compaction thresholds cannot express per model. |
| 2026-10-05 | Terminal scripts print the answer of their own submission; the `cli` channel delivers nothing. | Queuing `cli` replies for the next client printed a stale answer at an unrelated later script (reproduced in architect review). `--id` gives a script exactly-once retries through requestIds instead. |
| 2026-10-05 | The eval drives owner turns through `Router.submit` (`ingest` since U5) as WhatsApp, iMessage or Telegram (`eval/drive.ts`), not through `mochi chat`. | The owner reads mochi on a phone. Through the terminal channel, Opus answered with bold labels and a 1,379-character tour because `cli` has no length limit. Both paths enter the same Router; the attach layer was already verified in U7. Fixed message ids keep the exactly-once rerun that `--id` gives. |
| 2026-10-05 | Scenario time comes from a `Date` preload (`eval/clock.ts`), not from a picked time zone. | Picking a zone whose local hour matched made Opus question the owner's zone ("6pm GMT+11, since that's the timezone your message came in on"). A shifted clock keeps Asia/Kolkata and fixes every scenario on Tue 2026-10-06, so runs compare. No clock hook in `src/`. |
| 2026-10-05 | ~~Every eval process runs in `eval/sandbox.sh`~~ (replaced 2026-10-06 by `src/env/jail.sh`), and a probe through mochi's own bash gates each batch. | Incident: in an unsandboxed run, mochi found the owner's Todoist CLI token under `~/.config` and created a real task in the owner's Todoist inbox. A clean data directory isolates storage, not the machine. The owner deletes the task; the eval never touches the token. |
| 2026-10-05 | Identity section v6 (`docs/identity-prompt.md`) is drafted and evaluated but not yet in `src/brain/identity.ts`. | The owner froze `prompt.ts` and the tool surface for the architect pass. `eval/variant.ts` runs the text from a throwaway copy. On the sandboxed batches, v6 passed every hard check, against 10 of 12 scenarios for the old section on the same harness. |
| 2026-10-05 | Onboarding is a mochi-mode playbook (`playbooks/onboarding.md`), reached from the identity section when no `user` note exists. | It costs a `skill_read` on the first conversation only, instead of onboarding text in every request. Without apps it asks what the owner keeps dropping and acts on it. With apps it does a read-only sweep and comes back with three sourced observations. The second path is NOT VERIFIED: Executor is not connected in the eval. |
| 2026-10-05 | Follow-through lives in `once` triggers that check before they nudge. The mochi-mode skill says a promise needs a trigger, and the identity section says to report back only through one. | Triggers already survive restarts and reach the owner only through `notify`. The dropped-thread baseline showed the failure: mochi said "i'll nudge you wednesday" and set nothing. A second store of commitments would duplicate `mochi.triggers`. |
| 2026-10-05 | Proactivity stays triggers plus `notify`. The one standing proactive message is a morning text that onboarding offers once, as a `cron` trigger with a `notifyWhen` gate. | Silence is the default. Both cron scenarios behave: a quiet watch sends nothing, and a price drop sends one 90-character message. No heartbeat. |
| 2026-10-05 | ~~Replies stay one message per answer. They are not split into several bubbles.~~ Replaced 2026-10-06 (architect U4). | The Router sends one message per run and removes it from `mochi.outbox` after the send. Several bubbles would resend the earlier ones after a crash mid-sequence, unless the outbox tracked each bubble. The voice keeps answers to one or two short paragraphs, and `react` covers the acknowledgements. |
| 2026-10-06 | Removed the `process` tool, `agent`'s `isolation: "worktree"` and `readonly`, and receipts (architect U1). A skills lint (`src/skills.lint.test.ts`) fails on a backticked tool name the live surface does not have. | Owner decisions 3, 6 and 7 in the architect synthesis. `process` records died with the daemon and its wakes cost a root turn; a child can run `git worktree` through bash. The lint keeps skills from naming deleted tools. |
| 2026-10-06 | The tool environment is the boundary (architect U2). Bash runs in an allow-list jail with no capabilities and no network unless `grants.network`; the file tools refuse paths outside the policy's roots; `grants` in `data/config.json` hands over variables, bins and paths by name. The eval wraps its processes in the same script. | The credential incident, and the umount escape of a deny-list jail (uid 0 with every capability could unmount the tmpfs over the home). Approvals and model guards stay out, so the environment decides. With the network grant, bash can reach the EC2 metadata service; the owner should remove the instance role or block metadata for the mochi user on the AWS side. |
| 2026-10-06 | Memory is two tools and skills are files (architect U3). `note` replaces `notes_write` and `notes_forget` (an empty body forgets); `recall` replaces `history_lookup`, `history_scroll`, `notes_read` and `notes_list`; `skill_read` is gone and the model opens a skill with `read`. The `data/notes` import and `MemoryDoc.imported` are removed, with a version 2 `migrate`. `owner` and `notes-index` always render. Root went from 25 to 20 tools. | Fewer tools, same memory: the owner and notes-index sections already show every note, and a `recall` note hit carries the whole note. The skills directory is a read-only root of the work environment, so `read` reaches every skill file. Nothing wrote `data/notes` after 2026-10-05. |
| 2026-10-06 | One channel interface (architect U4). Adapters take bubbles, typed reactions and `typing(on)`, throw `ChannelDown`, `SendUnknown` or `SendRejected`, and return `Setup<Channel>` from the `ADAPTERS` table in `main.ts`; `present()` turns a reply into at most three bubbles on iMessage. `cli` is no longer a channel, and adapters drop the sender. | The Turn (U5) needs one error class per outcome to decide retry, retry once, or skip. The owner asked for few short bubbles and silence by default; `present()` and the profile are where that lives, as data and one pure function with table tests. Multi-bubble replies can repeat earlier bubbles after a crash until U5 checkpoints each bubble. |
| 2026-10-06 | The Turn replaces the Router (architect U5). One `mochi.turn` task per owed message, a background task of the ownerless line conversation; `ingest` is the one inbound path; claims, the per-channel chain and the per-bubble checkpoint are documents and checkpoints; `notify` opens a Turn and the record follows the send. `mochi.outbox`, `mochi.route` and the Router's in-memory tracking are gone, converted at boot by `src/upgrade.ts`. | Exactly-once and ordered delivery across a SIGKILL at each phase (`src/turn/crash.test.ts`), `/stop` cannot drop an owed reply, and the live store's outbox converts. The owner ruling: no progress chatter, silence by default, a blank answer sends nothing. |
| 2026-10-06 | Seats (architect U6). Every conversation's seat, model and thinking level are written when it is created, never inherited; root has no `notify` and is the only seat that starts agents or adds triggers, so agents nest one level; `SURFACE` replaces the trigger conversation's `EXCLUDED_EXTENSIONS` and the agent depth limit. The `root-seat` boot step seats the existing root. | On the real Harness a task-owned conversation copied root's agent and an ownerless one had no model (architect `check/spike/seat-probe.out`). Live-store copy: after boot root holds the owner seat, no `notify`, still `claude-opus-5-5` at `medium`. |
| 2026-10-06 | One agent task (architect U9). `agent`, `send_message`, `list_agents` and `stop_agent` leave the surface; `mochi.agent` with `agent`, `agent_start`, `agent_send`, `agent_stop`, `agent_status` inside root's `codemode` replaces them, and scripts can fan out subagents again. The Anchor and Reporter tasks and the `mochi.agents` and `mochi.agent-depth` documents are gone; the `drain-agent-kinds` boot step settles live ones `orphaned` and retires the documents. Root goes from 12 tools to 8. | Owner ruling: nothing posts into root. A background agent reaches the owner only with `notify`, which leaves one passive record in root; root asks with `agent_status`. |
| 2026-10-06 | The `code` door (architect U7). `codemode`, `web_*`, `classify`, `x_execute` and `x_skills` leave the surface; their capabilities are script functions inside `codemode`, each nested call a durable `mochi.call` child task keyed in the call's journal. Executor is one connection that never reinstalls an extension. Root goes from 19 tools to 15. | A crash mid-script no longer repeats an app action: an interrupted `apps_call` reports "interrupted" (gate test `src/code/code.gate.test.ts`, SIGKILL in a subprocess). Executor flapping changed root's tool list before; now nothing the model sees depends on it. |
| 2026-10-06 | One context policy and an event-fed index (architect U10). The nightly rollover is gone; pi-durable's built-in compaction, with its settings written out in `openMochi`, is the only context policy. The 5-second indexer poll became `subscribeCommits` plus a catch-up from each conversation's entry cursor at start. The `retire-rollover` boot step aborts a checkpoint turn left in flight. | Owner decision 2: the checkpoint turn was background work writing into root, which the 2026-10-06 ruling rules out. A message is searchable as soon as it commits; deleting `index.sqlite` still rebuilds it. |
| 2026-10-06 | The surface has a budget and boot reports readiness (architect U11). `BUDGET` caps each seat's tool bytes and each prompt section; `src/seats.test.ts` fails past a cap. Descriptions were trimmed to fit (root 8,535 to 8,258 tool bytes; skills-index 2,099 to 1,960 characters, every bundled description now uncut). Boot logs one `setup` line per boundary: models, classifier, firecrawl, executor and each channel, with the fix for a broken one. | The surface can no longer grow past its caps without a failing build, and a missing key or login is named at boot instead of at the first failing call. |
| 2026-10-06 | The iMessage line (architect U12). The adapter supervises its own connection: it catches up from `mochi.inbound-cursor` (written by the ingest commit) on every connect and every 10 minutes when the app offers `catchUp`, probes after 5 silent minutes with a `getMessage` round trip, and rebuilds on an ended stream or two failed probes, with `send` throwing `ChannelDown` meanwhile. A rebuild only logs `imessage.rebuilt`; silence alone never rebuilds. | Owner ruling: never message the owner about channel health. Spectrum 12.10.1 does not expose the advanced-imessage client or live event sequences, so the production app has no `catchUp` yet and the cursor stays empty; the replay path is proven only against a fake event log. |
| 2026-10-06 | The jail, the file-tool allow-list, `grants`, `mochi grants`, `MOCHI_JAIL` and the eval probe are removed (supersedes U2). bash, read, edit and write have the daemon user's full access: every path, the whole environment, the network. Eval processes run unsandboxed. Only the 600-second default bash timeout stays. | Owner's call: a model that is trusted with the owner's life is not boxed in on the owner's own machine. bash went from 123 ms to 8 ms per call (eval/bench.ts). Known cost: a prompt injection in a web page, email or webhook can reach `~/.ssh`, `~/.aws`, `data/`, API keys and the EC2 metadata service, and an eval run can touch the owner's real accounts, as the Todoist incident did. |
| 2026-10-12 | mochi speaks A2A v1.0 (JSON-RPC) as server and client: agent card, SendMessage, GetTask, and the a2a_list, a2a_ask, a2a_send and a2a_status functions. Each peer context gets its own worker conversation. Per-peer bearer tokens, localhost by default. No streaming or push. | The owner wants intercom-style talk between Hermes, mochi and other mochis. Hermes 2026.9.24 already ships A2A v1.0 in both directions, so mochi adopts the open standard instead of a new protocol. One server and four functions cover Hermes and mochi to mochi with config only. |
| 2026-10-14 | One agent seat, and `fork`. Seats become trust levels: `owner` and agent children merge into `agent`, where every copy of root has root's tools and prompt, so agents start agents at any depth, and `fork` copies a conversation with its context. Trigger runs (`trigger`) and A2A contexts (`peer`) keep master's narrower sets: a review found that putting them in `agent` let a webhook payload or a peer reach `note`, `trigger_add` and `profile_create`. `notify` and `handoff` are model-only and refuse where they make no sense (root; a task-owned agent). `agent_start` is deferred to keep the `codemode` section under budget. | Owner direction: mochi should use what agents have and people don't (copying the current context, running many at once, no fixed depth) instead of a human org chart of secretary, helper and new hire. Measured live through Bifrost on Opus 5.5 (`forkcache.ts` in the session scratchpad, a fresh store, two forks in one `Promise.all`): root's second request read 6,430 cached tokens; each fork's first request read 6,528 cached tokens and wrote about 225, and both recalled a word only root had been told. A fork costs its new tokens, not its parent's context. |
| 2026-10-14 | Reflect replaces nightly Dreaming. Before settle compacts root, a fork of root saves notes with `note`. `dream.ts`, its tests, its crash fixture and `eval/dream-dry.ts` are deleted (about 600 lines). | A 04:30 review by a tool-less reader of transcripts is a sleep cycle. An agent can review when the context is about to be lost, from inside that context, at cache-read price, through the same `note` checks every other write uses. Measured live through Bifrost on Opus 5.5 (`reflect-live.ts`, fresh store, two owner turns, clock moved past the settle time): the fork read 6,369 cached tokens and wrote 428. Root had already saved both facts with `note` mid-chat, and the fork answered "Nothing new" without duplicating them, so reflect is a backstop, not the main path. A copy of the live store upgraded with `retire-dreaming` changed 2 and a second boot changed 0. |
| 2026-10-14 | `persona.md` becomes `instructions.md`, and profile tools take `instructions`. A home renames an old `persona.md` once at start (`adoptInstructions`), and so does `profile_list` and `profile_update` for a profile home. A profile is described as an address (home, channels, instructions), not a person. | Owner direction to drop human framing. The file always held root's instructions; a persona is a costume. A guest user's `persona` in `[[users]]` stays: it describes a real person. |
