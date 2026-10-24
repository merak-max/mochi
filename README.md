# mochi

![Preparations for New Year's Day (Pounding Mochi), Utagawa Kunisada, 1834 to 1867](docs/pounding-mochi.jpg)

*Preparations for New Year's Day (Pounding Mochi), by Utagawa Kunisada, via Wikimedia Commons. Public domain.*

mochi is a personal agent that runs all day on a machine you own. You text it on iMessage, and it does the work: mail, calendar, the web, files, code, errands. Most of the time it says nothing, because most of the time nothing needs you. This README covers what it does, how it stays up, how to run it, and some numbers from running it on one person's life for a few weeks.

Housekeeping items:

- mochi is one person's daily tool, published as is. It works for me. It will need edits to work for you.
- It is built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), the durable runtime under [pi](https://github.com/earendil-works/pi). Most of what is interesting here comes from that.
- MIT license. The bundled skills in `skills/` carry their own license.

## What it does

You get one long conversation across every channel. Text it "move my 4pm to Friday" from your phone, and the reply comes back in the same thread. Each friend you configure gets a thread of their own, and those threads never see your memory or your apps.

The model sees three tools. One of them, `codemode`, runs JavaScript in a sandbox, and everything else is a function that script calls: the web, your apps through an MCP server, files, a shell, memory, agents, routines. This sounds like a small detail, and it is the main design choice. A model that writes a loop over 200 mails and filters them before it reads anything uses far fewer tokens than a model that calls a tool 200 times. It also keeps the first request small, which keeps the prompt cache warm.

When a task splits, `agent` with `fork: true` copies the current conversation, context and all, once per job, six at a time. Each copy reads the parent's prompt cache, so three drafts at once cost about the price of the new tokens. Measured on Opus 5.5, each fork's first request read about 6,500 cached tokens and wrote about 225. Forks can fork.

Some work belongs to a role: someone has to watch the inbox, the bills, the outreach. That is an agent definition. A definition is a Markdown file with a role, a model and a tool list. mochi hands it a job with `agent`, or a routine runs under it. A resident definition also keeps one standing conversation with its own memory, inside the same daemon.

## Memory that does not forget

The chat is the memory. Each message is summarized into one line, and neighboring lines merge in pairs, again and again, into a binary tree, as in uniichat. Each request sees a view of the whole chat: recent messages whole, older ones covered by fewer, broader lines. `zoom` opens any line into the two it was made from, down to the original message. A cheaper model builds the tree in the background, and the view changes only at its end, so the prompt cache stays warm. Nothing is thrown away. Facts that must outlive a reset go in plain markdown files under `~/.mochi/memory`, which you can read and edit too.

The reason for this is a failure the earlier design had. It rewrote the whole history on each compaction, and each pass lost a little. Promises died first. Of 23 commitments mochi made from October 6 to 14, 10 had nothing behind them by the end of the week. So now every promise is a schedule with an `at` time, and at that time a fresh run of mochi gets the task.

## Routines

One scheduler runs everything later: a cron, a one-time `at`, a webhook, or the exit of a background process. Each run lives in its own conversation, as a chain of steps. A step can be a classify step: a fast yes or no question that stops the chain before the model runs. A mail check that runs every 30 minutes and usually finds nothing costs one classifier call, not one model call. A run reaches you only when it calls `notify`, so silence is the default.

## It survives a crash

Every reply, routine and agent job is a durable task in one SQLite file. A crash or a restart picks up where it stopped. A reply records each bubble as it sends, so a crash repeats at most one bubble, and a message that arrives twice is answered once.

Delivery has three kinds of failure, and each has one response. A channel that is down waits 5 seconds, doubles up to 5 minutes, and gives up after an hour. A send whose outcome is unknown retries once. A send the platform refuses for good is skipped.

## Some numbers

From about two weeks of my own use, on one 8-core ARM EC2 box in Mumbai:

- Reply delivery: the send itself has a median of 661 ms, p90 3.4 s and p99 12 s over 299 sends. Most of the tail is Photon's servers in us-west-1. (`jq` over `turn.sent` lines in `mochi.log`.)
- Your message to its first bubble is mostly the model writing. A one-line Opus reply takes 4 to 11 s.
- Cost: most of the spend is the brain model. Opus as the brain for every reply is the expensive choice, and it is the first thing to change if you run this on a budget.

## Start

You need Node 24 or newer.

```sh
git clone https://github.com/0oAstro/mochi && cd mochi
npm install
mkdir -p ~/.mochi
cp config.example.toml ~/.mochi/config.toml
cp .env.example ~/.mochi/.env && chmod 600 ~/.mochi/.env
mkdir -p ~/.mochi/agents && cp root.example.md ~/.mochi/agents/root.md
$EDITOR ~/.mochi/.env            # at least ANTHROPIC_API_KEY
node src/main.ts                 # a terminal UI; it becomes the daemon
```

To run it as a systemd user service on Linux:

```sh
node src/main.ts service install   # writes ~/.config/systemd/user/mochi.service
systemctl --user daemon-reload && systemctl --user enable --now mochi
```

`node src/main.ts --headless` starts the daemon by hand. `node src/main.ts -p "hello"` sends one message to a running daemon. `node src/main.ts chat` sends each line of stdin. The terminal is one more channel, like iMessage, so `/new` starts a fresh thread there too. `node src/main.ts help` lists the rest.

iMessage goes through [Photon Spectrum](https://photon.codes), which needs a project id and secret.

## Your home

Everything that is yours lives in `~/.mochi`, or in `MOCHI_HOME`. The repository holds only code, bundled skills and the bundled agent definitions.

| Path | What |
|---|---|
| `config.toml` | Time zone, providers and models, routines, users, apps and web. See `config.example.toml`. |
| `.env` | Keys and tokens. See `.env.example`. |
| `instructions.md` | Facts about you, after root's definition. |
| `agents/root.md` | Required. Root's definition: who root is and how it works. Start from `root.example.md`. |
| `agents/<name>.md` | One agent definition. A definition with a bundled name replaces the bundled one. |
| `skills/` | Your skills, next to the bundled ones. |
| `tools/<name>.ts` | Your own tools, one `defineTool` default export each. `tools_reload` loads them without a restart. |
| `mochi.sqlite`, `work/` | The durable store and mochi's working directory. |

## Models

Any provider works through a protocol: any pi-ai api id: `anthropic-messages`, `openai-responses`, `openai-completions` and the rest for chat models, and `typesafe-system-one`, `cloudflare-workers-ai-system-one`, `openai-decisions` or `llama-cpp-classify` for the decision model behind `classify`. Each provider names its `url` and `keyEnv`. A gateway is one provider per protocol it serves.

```toml
[providers.gateway]
api = "anthropic-messages"
url = "https://gateway.example.com/anthropic"
keyEnv = "GATEWAY_KEY"

[models]
brain = "gateway/claude-opus-5-5"
fast = "gateway/gpt-6.1-sol"
memory = "gateway/claude-haiku-5-5"

[models.aliases]
sol = "gateway/gpt-6.1-sol"
```

`brain` answers you. `fast` runs routines and reads data for scripts. `memory` writes the summary lines of each conversation's view; it makes many small calls, so a cheap model fits. Definitions and routines pick a tier or an alias by name.

## Agents

An agent definition is a Markdown file at `~/.mochi/agents/<name>.md`:

```markdown
---
description: Mail. Triage new mail and draft replies.
model: fast
thinking: medium
tools: apps_search, apps_call, schedule_list
resident: true
---

You are relay. You own the inboxes. Notify only when ignoring a mail would cost the owner something.
```

`tools` is optional. Without it the definition has every function. An edit reaches the next job without a restart. Name a definition in a routine with `agent = "relay"`, or ask mochi to give it work. Without `resident: true`, each job is a fresh child that ends with its answer. With it, every job goes to the same standing conversation, so the agent remembers earlier jobs.

## What it does not do

There are no approvals, guard hooks or tool sandbox. mochi runs as your user, with your files and your keys. A prompt injection in a web page or a mail can reach them. I accept that cost on my own machine. You should decide for yours.

Messages sent while the iMessage link is down are not replayed, because the Spectrum version it pins has no catch-up for them.

## Development

```sh
npm run typecheck
```

There are no unit tests. Verify a change by running the real daemon on a copy of a store: `MOCHI_HOME=<copy> node src/main.ts -p "<prompt>"`. Without a running daemon, `-p` and `chat` start no channels and no triggers, so a copy reaches no one.

`SPEC.md` is the design: process shape, conversations, tools, prompt, memory, routines, agents, and the decisions that still hold and why.
