# What mochi lacks that Hermes has, and the session lifecycle we skipped

Measured 2026-10-06 on this box. Hermes evidence: `~/.hermes/state.db`, `~/.hermes/config.yaml`, Hermes 2026.9.24 source under `~/.local/share/mise/installs/http-hermes/2026.9.24/`. Mochi evidence: `data/mochi.sqlite`, `src/`, pi-durable 1.0.3 in `vendor/pi/packages/durable`.

## The session problem: one root conversation forever

Mochi has exactly one conversation for the owner, `harness.root()`, across every channel and forever. Nothing ever starts a new one. Hermes has the same idea of a long-lived chat but wraps it in a lifecycle. These are the gaps, in the order they will bite.

### 1. Compaction never fires on Opus

`src/mochi.ts:79` sets pi-durable's defaults: `reserveTokens 16,384`, `backgroundTokens 32,768`, `keepRecentTokens 20,000`. pi-durable triggers on the model's `contextWindow` (`durable/src/harness/generation.ts:309-321`). Mochi declares Opus with `contextWindow: 1_000_000` (`src/brain/models.ts:37`). So:

- background compaction starts at about 1,000,000 − 16,384 − 32,768 ≈ **950k tokens**
- blocking compaction at about **984k tokens**

Every request until then resends the whole transcript. With caching that is cheap per token but not free: Hermes's longest photon session already averaged ~74k prompt tokens per call over 79 calls (5.2M cache reads). Mochi today: 10 calls, ~9.8k per call, climbing about 500 tokens per exchange.

Hermes hit the same trap and fixed it in config (`hermes_cli/config_defaults.py:553-600`): `threshold: 0.50` of the window **and** `threshold_tokens: 256_000`, with a comment that the 50% trigger on 1M-window models "sat at 500K, so compaction never fired". Its tail is token-bounded ("lean": 10k floor, 25k cap) and it keeps at least the last real user message verbatim.

Fix in mochi: no new code. Tell pi-durable the budget we want, not the model's maximum. Either declare `contextWindow` lower on the Opus `Model` (the trigger reads it; pi-ai also clamps `maxTokens` against it, `ai/src/api/simple-options.ts:18-22`), or raise `reserveTokens` so `contextWindow − reserveTokens` lands where we want. Target: start background compaction around 120k, block around 160k.

### 2. Compaction summarizes with Opus

pi-durable's compaction task uses the conversation's own agent model (`durable/src/harness/compaction.ts:112-137`). Hermes routes summaries to an auxiliary model (`auxiliary.compression: azure/gpt-6.1-sol, reasoning_effort: low`). pi-durable's escape hatch is the `beforeCompact` hook: it receives the messages and may return `{ summary }` (`durable/src/harness/types.ts:648-665`). A ~30-line `beforeCompact` in mochi can call the fast model with pi-durable's own summarization prompt, plus a line that preserves open promises and the owner's latest message verbatim.

### 3. No new thread, no reset

Hermes: `/new` and `/reset` start a fresh session (`gateway/slash_commands_session.py`). It used to also auto-reset daily at 04:00 or after 24h idle; that `SessionResetPolicy` is now inert (`gateway/config.py:353`: "Gateway configuration and session lifecycle do not consume this datatype"). Current Hermes relies on compression plus explicit `/new`, which is the right lesson: **time-based resets were removed upstream**.

Mochi: pi-durable has `conversation.reset(handoff)` (`durable/src/harness/harness.ts:110`) and a tool can return `control: { handoff }`. Mochi uses neither since the rollover was deleted (SPEC decision log 2026-10-06, U10). Memory survives a reset because notes render as a prompt section, and `recall` searches everything before the reset.

What to build: owner says "new thread" or `/new` on iMessage, mochi resets root with a short handoff note. That is a `handoff` tool returning `control: { handoff }`, about 20 lines, exactly the launch post's example.

### 4. No owner commands at all

Hermes gateway handles ~60 slash commands (`gateway/slash_commands*.py`). The owner's own usage in `state.db`: zero slash commands from photon, `/new` once on the CLI. The ones worth having on a phone:

| Command | Hermes | Mochi today | pi-durable primitive |
|---|---|---|---|
| `/new` | fresh session | none | `reset(handoff)` |
| `/stop` | abort the running turn | TUI only | `root.abort()` |
| `/compress` | manual compaction | TUI `/compact` only | `root.compact(instructions)` |
| `/model` | switch model | TUI only | `root.configure({ model })` |
| `/status`, `/usage` | session and cost | TUI panel only | `harness.usage()` |
| `/undo`, `/retry` | rewind one turn | none | none built in |

Mochi routes every inbound text to the model. A channel-level command table for these five is about 40 lines in `src/turn/turn.ts` `ingest`, before `openTurn`.

### 5. Inbound read receipts and tapbacks are dropped

The live log shows `channel.message_dropped reason=empty content=read`: iMessage read receipts arrive as messages, and tapbacks from the owner are not parsed (`src/channels/imessage.ts:96-120` ignores everything but text, attachments, voice, richlink, reply, effect, group). Read receipts should be ignored silently; owner tapbacks should become the passive `tapback` write that `ingest` already supports (`src/turn/turn.ts:392-395`).

## Capabilities Hermes has and mochi lacks

| Capability | Hermes | Mochi | Matters? |
|---|---|---|---|
| Voice notes in | STT (off in your config) | saved as a file, not transcribed | yes: iMessage voice notes are common. Deepgram key exists in your shell. |
| HEIC photos | vision tool converts | passed to Opus as `image/heic`, which Anthropic does not accept | yes: iPhone photos are HEIC. ffmpeg is on the box. |
| Logged-in browser | 15 browser tools + vault | Firecrawl through Executor apps only | maybe: Executor holds the logins; no click-through browser |
| Image generation | `image_gen` via Azure | none | low |
| Text to speech | `text_to_speech` | none | low |
| Computer use | toolset enabled | none | low on a headless box |
| Todo list | `todo` tool | notes + triggers | no |
| Kanban | `kanban.db` (0 tasks) | none | no, unused |
| Session titles, `/sessions`, `/resume` | yes | one conversation | no until threads exist |
| Background review fork | after each turn, forks the agent to save memory/skills (`agent/background_review.py`) | model calls `note` itself | worth considering: it writes memory without root turns, and SPEC already rules out auto-generated skills |
| Usage/cost per session | `state.db` sessions table | `harness.usage()`, TUI only | small |
| Group chats, multi-user | `group_sessions_per_user` | owner only; others dropped | later: the per-person conversation design |
| Self-update, restart command | `/update`, `/restart` | systemd only | no |

## What mochi has that Hermes does not

- Exactly-once, ordered delivery across SIGKILL (Turn task, per-bubble checkpoint). Hermes has a delivery ledger but no crash-safe resume of a half-generated answer.
- First request ~4.3k tokens vs ~20k (8 tools vs 38).
- Triggers whose runs never touch the owner's thread; mail-watch slots with no mail cost zero model calls, now inside mochi.
- Rewindable memory (`snapshotAsOf`), every note tied to the entry that wrote it.
- bash with the daemon user's full access: every path, the environment, the network.

## Order to fix

1. Compaction budget (config only) and a Luna `beforeCompact` summarizer. Without this the thread grows to ~950k.
2. `/new` via a `handoff` tool and `reset`; `/stop`, `/compress`, `/status` in `ingest`.
3. Drop read receipts quietly; map owner tapbacks.
4. HEIC to JPEG with ffmpeg before the model; voice notes through Deepgram.
