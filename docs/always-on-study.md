# Always-on agents: Grok Bot, Hermes, prime-agent and mochi

Studied 2026-10-14. The sources are Lee Robinson's Stanford CS146S talk "How always-on agents work" (2026-10-11, youtube.com/watch?v=L1OBRtfPS34), xAI's Grok Bot docs, Hermes v0.21.5 source and `~/.hermes/state.db`, prime-agent 0.9.8 source, the RLM paper, pi-durable at pi main `6db4070`, and mochi at `291a50d`. Numbers carry the command or file that produced them. Other numbers are marked ESTIMATE.

## What makes Grok Bot good

The agent loop is ordinary: a model calls tools in a loop. The product is the system around the loop.

1. **Durability.** Each turn and each helper is a Temporal workflow. A crash resumes at step N.
2. **Server and computer are separate.** The agent loop runs on a server. A Firecracker VM is the agent's computer, and it sleeps when idle. The VM can be rebuilt without touching the agent.
3. **One message path.** The server talks to every client through one `send_user` tool. Each client decides how to render it: a sign-in form, a payment, a draft to approve, or an emoji.
4. **It knows when to be quiet.** A router dedupes events. A check decides whether the event is worth a message.
5. **The owner comes first.** An owner message preempts background work. Other work queues, and a burst becomes one turn.
6. **Cache misses are bugs.** Sections keep a fixed order, so an A/B test does not move the prefix. The server warms the cache while the owner types. It compacts a long thread while the cache is still warm.
7. **Memory has three layers.** Core facts go in every prompt. Dated work logs come next. Scratch notes expire. Everything else is in files that the model greps.
8. **An escalation ladder.** The order is context, then API or plugin, then web search, then browser, then full desktop. The agent asks the owner last.
9. **A sparse orchestrator.** The main agent stays small and fast. Helpers get fresh context and report back.
10. **Auto Review.** A separate model reviews shell, plugin and computer-use actions. Memory writes are not reviewed (docs.x.ai/grok-bot/security).
11. **"Delete the product."** Build as little as possible for the next model.

## Where mochi stands

Mochi already has most of the hard parts. In some areas it is ahead of Grok Bot's public design and of Hermes.

| Dimension | Mochi | Hermes | Notes |
|---|---|---|---|
| Durability | **Ahead.** Each Turn is a pi-durable task with exactly-once, per-bubble delivery across SIGKILL (`src/turn/turn.ts:106-135`). Codemode replays from a journal. | A delivery ledger. A crashed turn does not resume. | Grok Bot needs Temporal for this. pi-durable gives it in-process. |
| Tool surface | **Ahead.** 2 model tools. The first request is about 3,649 tokens (`node eval/surface.ts`). 21 tools are deferred. | 59 core tools. The first call is 20-31k tokens (`state.db`). tool_search is off. | |
| Silence | Has it. Triggers are silent by default, and `notifyWhen` is a Jev gate. | `[SILENT]` suppressed 111 of 117 cron runs. | Both work for routines. Neither has a chat-level gate. |
| Queue and priority | Partial. Owner messages steer. A busy trigger slot is `skipped-busy`, and a busy webhook gets a 503. | Interrupt, queue and steer modes. No iMessage batching. | Mochi drops work that it should queue. |
| Compaction | 200k declared window. A Luna `beforeCompact`. A 60-min idle reset. | 256k cap. A Haiku summarizer. It never fired (`sum(compacted)=0`). | Neither compacts while the cache is warm. |
| Prompt cache | Stable sections. Root reads 91.5% from cache with the 5-min TTL. Trigger runs read 50-65%. | `cache_ttl: auto`: 1 h for humans, 5 m for machines. | See "Where the money goes". |
| Memory | Notes in the prompt, FTS5 `recall`, rewind, git. Dreaming is built but off. | `MEMORY.md`/`USER.md`, FTS5 search. Background review is off. | No dated log and no expiring scratchpad in either. |
| Safety | No reviewer, by owner ruling. **bash inherits every secret.** | A smart approval guardian, untrusted-result wrappers. The owner turned approvals off. | See finding 2. |
| Server/computer split | One box and one user. | Same. Hosted Hermes scales to zero. | Acceptable for a personal agent. |
| Client protocol | Reply text plus `react` and `attach:`. | Native iMessage polls, approval buttons. | Low value for an iMessage-first agent. |
| Multi-agent | A2A server and client, per-user threads. | Bot Mode, A2A, a loop guard. | Group chats have mostly negative evidence (Moltbook, the Hugging Face incident). Skip them. |

## Where the money goes

All numbers come from read-only queries on `/opt/docker/bifrost/data/logs.db` (2026-10-06 to 2026-10-14) and on mochi's own usage records in `data/mochi.sqlite` (`pi.assistant` entries, `usage.cost`). Bifrost hides request content, so it cannot separate mochi from pi coding sessions. Mochi's records give the mochi split.

- **Total Bifrost spend: $1,017.75 in 8 days.** Opus 5.5 is $764.08 of it. Output tokens are $367.49. By client: pi $767.91, Claude Code $222.53, everything else $26.
- **Mochi is $51.70 of that, about 5%.** The expensive part is coding sessions in pi and Claude Code. Pi Opus calls average 122,928 prompt tokens, and Claude Code Opus calls average 173,878. Pi Opus calls with more than 150k prompt tokens cost $217.33 of pi's $544.84 on Opus.
- **The cache hit rate is already high.** Pi reads 95.6% from cache, and Claude Code reads 98.0%. Misses are not the main cost. Long contexts on Opus are: each call re-reads 120-170k cached tokens, and the output cost adds to that.

Inside mochi:

| Conversation | Model | Calls | Cost | Cache read | Main cost |
|---|---|---|---|---|---|
| root (owner thread) | Opus | 564 | $24.10 | 91.5% | Cache writes $12.79 |
| mail-watch trigger | Luna | 347 | $1.92 | 64.6% | Cheap: correct model choice |
| Gradescope regrade agent | Fable | 77 | $9.48 | 97.8% | Output $6.78 |
| `ell305-minor-regrade` trigger | Opus | 57 | $5.27 | 50.0% | Cache writes $4.92 |
| COL202 worksheet agent | Fable | 16 | $4.51 | 91.5% | Output $3.49 |
| `notion-board-sweep` trigger | Opus | 51 | $3.61 | 55.3% | Cache writes $3.05 |

Root cache writes, split by the gap since the previous call: 529 calls within 5 minutes wrote 0.99M tokens. 19 calls after a 5-60 minute gap wrote 1.15M tokens ($5.76). 15 calls after more than 1 hour wrote 0.41M. A 1-hour TTL writes at 2x input instead of 1.25x. A replay of root's real calls gives $19.54 of cache cost with a 1-hour TTL, against $18.27 actual. So for this traffic the 5-minute TTL is the cheaper choice. Do not switch root to the 1-hour cache.

## Findings, ranked for the primary goal

Each item is small, has evidence behind it, and builds on what mochi has.

1. **Give each trigger run a fresh context, and run it on a cheaper model.** This is the largest measured waste in mochi (see "Where the money goes"). Each run of a trigger appends to the same conversation (SPEC "Runs"). Runs are hours apart, so every run writes the whole growing history to the cache again. `ell305-minor-regrade` read only 50% from cache, and `notion-board-sweep` read 55%. Both ran on Opus, because a trigger without `model` inherits root's. Hermes starts each cron tick with no history. OpenClaw's `isolatedSession` cut each run from about 100K tokens to 2-5K. Fix: reset the run conversation with a short handoff before each slot, and set a cheaper default model for `run` seats.
2. **Keep secrets out of bash.** pi-durable's bash tool sets `inheritEnv: true` (`dist/tools/bash.js:37`). The daemon env holds `BIFROST_VIRTUAL_KEY`, `FIRECRAWL_API_KEY` and the channel tokens, so the model can read them with `env`. The comment at `src/web/web.ts:10` says the opposite. Non-model controls are the safety layer with the strongest evidence: adaptive attacks broke 12 model-based defenses at over 90% (arXiv 2510.09023). The fix is an allow-listed env for the work environment. This also blocks the OSS goal, because a stranger's keys would leak the same way.
3. **Batch bursts.** iMessage users send 3-4 short texts. Set `steeringMode: "all"` and `followUpMode: "all"` in the harness settings (`dist/harness/agent.js:48-49`), so a burst lands in one turn. This is one line of config. Hermes fails here on Photon.
4. **Queue trigger work instead of dropping it.** Trigger runs submit with `whenBusy: "reject"` (`src/triggers/trigger.ts:133`, `src/triggers/webhooks.ts:105`). A slow run loses the next mail-watch slot, and a webhook gets a 503. `followUp` keeps the work and still never steers into a running check.
5. **Compact while the cache is warm.** Today compaction fires only on tokens, and the idle reset fires on the next message after 60 minutes, when the cache is cold. Build one background task per human thread: it sleeps until shortly before the TTL ends, then compacts if the context is above a floor. Make the summary request reuse the cached prefix (same system prefix and `sessionId` through `api.models`). Mochi's summarizer and pi-durable's built-in summarizer both send `cacheRetention: "none"` today. Claude Code ships this design, and the talk names it. Take pi main #10904 first, because it keeps cache hits after a compaction.
6. **Adopt the RLM idea where it fits a personal agent: history as data.** The paper's gain comes from holding the input in a REPL variable and sending only slices to sub-calls. Examples: BrowseComp-Plus from 0 to 91.33 and OOLONG-Pairs from 0.04 to 58 with GPT-5 (arXiv 2512.24601, Table 1). The paper also reports losses on math and higher latency everywhere. Mochi has the outer part: codemode plus `llm` on Luna. It lacks three parts:
   - a `history({after, before, conversation})` library tool that returns entries as JSON into the script, not into Opus's window
   - a concurrency limit and a token cap per script on `llm` (a `Promise.all` over 500 slices has no bound today)
   - Dreaming as map-reduce: Luna maps over all new entries, then one reduce runs, which removes the 40k-character cap (`src/memory/dream.ts:57-86`)

   Then turn Dreaming on. Prime-agent's "self-improving" `/refine` changes no model weights. It is an LLM pass that edits a ledger of notes, skills and subagent specs, with rollback. That is Dreaming with a wider target, so add skill proposals only after an eval shows the need.
7. **Move to npm pi 1.2.0.** The `deps/*.tgz` tarballs come from pi main `6db4070`, not the 1.1.0 release. v1.2.0 contains that commit and adds 21 more (`gh api repos/earendil-works/pi/compare/6db4070...v1.2.0`). It adds the Anthropic strict-tool fallback and the `// @options:` fix. This step also serves the OSS goal.
8. **An owner decision, not a recommendation: a reviewer on irreversible actions.** The minimal-harness ruling stands. The evidence is new: Anthropic measured a reasoning-blind action classifier at 0.4% false positives and 17% false negatives on real traffic. Grok Bot, OpenAI dots and Hermes all ship one. If the owner wants one, a `beforeTool` hook on `apps_call`, `a2a_send` and `bash` is the attachment point, and it reaches nested codemode calls. The default is to leave it out.

Not recommended:
- a VM split or a thin-client protocol, because one box and text channels fit a personal agent
- group chats, because the evidence is negative
- a vector or graph memory, because files plus search scored 74.0 against Mem0's 68.5 (Letta, weak benchmark), and five shipped harnesses use files plus search

## Teams of agents: the owner's Grok Bot tree in mochi

The owner's Grok Bot setup is a tree of persistent roles. dr eggbot (CEO) is the root. poteto (chief of staff) owns the day. relay, clock and kubera own mail, calendar and money. A marketing room has its own leads. projects and paper hand code briefs to a Cursor project. builder is a backup that only forwards briefs.

What makes this shape work, with evidence:
- **One owner per stage.** Each role owns one domain, and builder only forwards briefs and never codes. The Grok Bot docs warn that parallel handoffs cause duplicate work, and Hermes reverted parallel group rounds to serial ones. A tree with clear ownership avoids both problems.
- **Cheap roles on cheap models.** mochi's mail watcher on Luna cost $1.92 for 347 calls. The two Opus triggers cost $8.88 for 108 calls. Most roles in the tree are routine readers (mail, calendar, bills, metrics) and do not need Opus.
- **Fresh context per job.** A role keeps durable memory, not a long transcript.

What mochi has for this today:
- `agents/*.md` types (`mochi`, `worker`) with a model tier, and `agent`/`agent_start`/`agent_send`/`agent_stop`/`agent_status` (`src/agents/subagent.ts`). These are one-off helpers. Each one gets a fresh context and returns an answer.
- Triggers with a per-trigger `model` and their own conversation. These are routines.
- A2A between separate mochi daemons (the profiles ruling, 2026-10-06).

What a role tree needs, in the smallest form:
1. **A role is an `agents/<role>.md` file.** It holds the instructions, the default model tier and the skills. relay, clock and kubera become files, not daemons.
2. **A role's routines are triggers that name the role.** The run uses the role's instructions and model, so a routine role costs Luna or Sonnet prices, not Opus prices.
3. **A role's memory is a note namespace** (`relay/*`), so a run starts fresh and still knows its domain.
4. **Root stays the orchestrator.** Root is poteto in the owner's tree. It delegates by brief and keeps its own context sparse. That is the talk's "main agent stays sparse" rule, and it also cuts root's cache writes.

Keep separate daemons (profiles over A2A) for a role that needs its own identity or channel, such as a bot with its own number. Most of the owner's tree does not need that.

## Findings for the OSS goal

The mochi audit found 20 couplings to this box or this owner. Hermes shows the pattern that removes them. These are the steps, in order:

1. **Dependencies.** Replace the five `file:deps/*.tgz` tarballs and the 1.0.3 overrides with registry pi 1.2.0. Add a `bin` entry. State Node 24 as the minimum.
2. **Provider profiles.** Today Bifrost is the only way to reach a model: the host, the `x-bf-vk` header and the model ids are constants (`src/brain/models.ts:10-128`). Add profiles for direct Anthropic, an OpenAI-compatible base URL, and OpenRouter. Bifrost becomes one OpenAI-compatible instance. The brain, fast and classifier models become config with defaults.
3. **Config defaults, not owner values.** The Executor URL (`src/config.ts:73`) and the timezone `Asia/Kolkata` (`src/config.ts:68`, `src/memory/dream.ts:26`) change to neutral defaults. Remove the owner's text from the repo: the Azure resource names in `src/media/config.example.json`, and Riya and Hermes in `skills/mochi-mode/`.
4. **Each channel and tool declares `requiresEnv` and `check()`.** A missing key leaves the feature out, and `mochi doctor` shows it. An enabled feature that is broken fails loudly. Hermes's Photon sidecar logged "node not found" 971 times and stayed quiet. Mochi must not repeat that.
5. **A first-run path.** Add a README, a LICENSE for mochi (today only `skills/LICENSE` exists), `.env.example`, `config.example.json`, a `mochi setup` wizard with sections that can run alone, `mochi service install` for systemd or launchd, and a Dockerfile. Procs survive a restart only under systemd (`src/procs/procs.ts:131-135`), so Docker needs a supervisor.

## Stale docs found

- `SPEC.md:240` quotes old tool budgets. `SPEC.md:413` lists `beforeCompact` as later, but it is built. `SPEC.md:436` names `llm_query`/`llm_batch`, but the code has `llm`.
- `docs/mechanisms.md` says no defect is fixed. Two are fixed: the process wake and the zero-width bubble.
- `docs/hermes-vs-mochi.md` "Order to fix": items 1-4 are built. `/compress`, `/model` and `/usage` are still open.
- `recall` with a date-only `asOf` still reads the end of the day in UTC (`src/memory/memory.ts:57`).
