# mochi

![Preparations for New Year's Day (Pounding Mochi), Utagawa Kunisada, 1834 to 1867](docs/pounding-mochi.jpg)

*Preparations for New Year's Day (Pounding Mochi), by Utagawa Kunisada, via Wikimedia Commons. Public domain.*

mochi is a personal agent that runs all day on a machine you own. You text it on iMessage, and it does the work: mail, calendar, the web, files, code and errands. It stays silent unless something needs you.

- mochi is one person's daily tool, published as is. It works for me. It will need edits to work for you.
- It runs on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), the durable runtime under [pi](https://github.com/earendil-works/pi). Most of the hard parts come from pi-durable.
- The code has the MIT license. The bundled skills in `skills/` carry their own license.

## What it does

You get one long conversation across every channel. Text it "move my 4pm to Friday" from your phone, and the reply comes back in the same thread. Each friend you configure gets a thread of their own. Those threads never see your chat or your apps. They do have the file and shell tools, so they can read your memory files.

The model sees two tools. One of them, `codemode`, runs JavaScript in a sandbox. Everything else is a function that the script calls: the web, the tools of each MCP server you configure, files, a shell, memory, agents and the board. This is the main design choice. A model that writes one loop over 200 mails and filters them before it reads anything uses far fewer tokens than a model that calls a tool 200 times. Two tools also keep the first request small, which keeps the prompt cache warm.

When a task splits, `agent` with `fork: true` copies the current conversation, with all its context, once per job, six at a time. Each copy reads the parent's prompt cache, so three drafts at once cost about the price of the new tokens. On Opus 5.5, each fork's first request read about 6,500 cached tokens and wrote about 225. Forks can fork.

Some work belongs to a role, such as a watch on the inbox, the bills or the outreach. An agent definition holds that role. A definition is a Markdown file with a role, a model and a tool list. mochi hands it a job with `agent`, or the definition owns a board item. A resident definition also keeps one standing conversation with its own memory, inside the same daemon.

## Memory keeps every message

The chat is the memory. A cheaper model summarizes each message into one line. Then it merges neighboring lines in pairs, again and again, into a binary tree, as uniichat does. Each request sees a view of the whole chat: recent messages whole, and older ones as fewer, broader lines. `zoom` opens any line into the two lines it came from, down to the original message. The tree grows in the background, and the view changes only at its end, so the prompt cache stays warm. mochi deletes nothing. Facts that must outlive a reset go in plain Markdown files under `~/.mochi/memory`, which you can read and edit too.

The earlier design rewrote the whole history on each compaction, and each pass lost a little. Promises were lost first. Of 23 commitments mochi made from October 6 to 14, 10 had nothing behind them by the end of the week. Now every promise is a board item with an `at` time, and at that time the item's owner gets the task as a message.

## The board

One board holds everything owed. An item has a text and an owner: root, or an agent definition. An item with no `when` is only listed. An item fires once at an `at` time, at each slot of a `cron`, or on each POST to its webhook. A fire first runs the item's `check` script, if it has one. Empty output ends the fire with no model call. So a mail check that runs every 30 minutes and usually finds nothing costs one script run. Next, the fire sends the item's text to its owner. Root's final text is the reply to you. A definition's final text goes to you verbatim, after an optional yes or no gate on the classifier. `NO_REPLY` stays silent, so silence is the default. When a background process exits, it wakes the conversation that started it.

## It survives a crash

Every reply, board fire and agent job is a durable task in one SQLite file. After a crash or a restart, each task continues from where it stopped. A reply records each bubble as it sends it, so a crash repeats at most one bubble. A message that arrives twice gets one answer.

Delivery has three kinds of failure, and each has one response. When a channel is down, mochi waits 5 seconds, doubles the wait up to 5 minutes, and stops after an hour. A send with an unknown outcome gets one retry. mochi skips a send that the platform refuses for good.

## Some numbers

These come from about two weeks of my own use, on one 8-core ARM EC2 box in Mumbai:

- Reply delivery: over 299 sends, the send itself has a median of 661 ms, a p90 of 3.4 s and a p99 of 12 s. Most of the tail is Photon's servers in us-west-1. (`jq` over the `turn.sent` lines in `mochi.log`.)
- The time from your message to its first bubble is mostly the model writing. A one-line Opus reply takes 4 to 11 s.
- Cost: the brain model is most of the spend. Opus as the brain for every reply is the expensive choice. If you run this on a budget, change it first.

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

To run mochi as a systemd user service on Linux:

```sh
node src/main.ts service install   # writes ~/.config/systemd/user/mochi.service
systemctl --user daemon-reload && systemctl --user enable --now mochi
```

`node src/main.ts --headless` starts the daemon by hand. `node src/main.ts -p "hello"` sends one message to a running daemon. `node src/main.ts chat` sends each line of stdin. The terminal is one more channel, like iMessage, so `/new` starts a fresh thread there too. `node src/main.ts help` lists the other commands.

iMessage goes through [Photon Spectrum](https://photon.codes), which needs a project id and a secret.

## Your home

Everything that is yours lives in `~/.mochi`, or in `MOCHI_HOME`. The repository holds only code, the bundled skills and the bundled agent definitions.

| Path | What |
|---|---|
| `config.toml` | Time zone, providers and models, users, MCP servers, web and webhooks. See `config.example.toml`. |
| `.env` | Keys and tokens. See `.env.example`. |
| `instructions.md` | Facts about you. The prompt puts them after root's definition. |
| `agents/root.md` | Required. Root's definition: who root is and how it works. Start from `root.example.md`. |
| `agents/<name>.md` | One agent definition. A definition with a bundled name replaces the bundled one. |
| `skills/` | Your skills, next to the bundled ones. |
| `tools/<name>.ts` | Your own tools, one `defineTool` default export each. `tools_reload` loads them without a restart. |
| `memory/` | Lasting facts as Markdown files. |
| `mcp/<name>.json` | OAuth tokens from `mochi auth <name>`. |
| `mochi.sqlite`, `work/` | The durable store and mochi's working directory. |
| `mochi.log` | The daemon's log. |

## Models

A provider speaks one protocol, which is a pi-ai api id. Chat models use `anthropic-messages`, `openai-responses`, `openai-completions` or another chat api. The decision model behind `classify` uses `typesafe-system-one`, `cloudflare-workers-ai-system-one`, `openai-decisions` or `llama-cpp-classify`. Each provider names its `url` and `keyEnv`. A gateway is one provider per protocol that it serves.

```toml
[providers.gateway]
api = "anthropic-messages"
url = "https://gateway.example.com/anthropic"
keyEnv = "GATEWAY_KEY"

[providers.gateway-openai]
api = "openai-responses"
url = "https://gateway.example.com/openai/v1"
keyEnv = "GATEWAY_KEY"

[models]
brain = "gateway/claude-opus-5-5"
fast = "gateway-openai/gpt-6.1-sol"
memory = "gateway/claude-haiku-5-5"
sol = "gateway-openai/gpt-6.1-sol"
```

`brain` answers you. `fast` reads data for scripts and runs the definitions that name it. `memory` writes the summary lines of each conversation's view. It makes many small calls, so a cheap model fits. Any other key in `[models]` is a name of your own. A definition or a tool call picks a model by its name.

## Agents

An agent definition is a Markdown file at `~/.mochi/agents/<name>.md`:

```markdown
---
description: Mail. Triage new mail and draft replies.
model: fast
thinking: medium
tools: executor_execute, executor_skills, board_list
resident: true
---

You are relay. You own the inboxes. Speak only when ignoring a mail would cost the owner something.
```

`tools` is optional. Without it, the definition has every function. An edit reaches the next job without a restart. To make a definition the owner of a board item, set `owner: "relay"` on the item, or ask mochi to give it work. Without `resident: true`, each job is a fresh child that ends with its answer. With it, every job goes to the same standing conversation, so the agent remembers earlier jobs.

## What it does not do

mochi has no approvals, guard hooks or tool sandbox. It runs as your user, with your files and your keys. A prompt injection in a web page or a mail can reach them. I accept that cost on my own machine. Decide for yours.

mochi does not replay the messages sent while the iMessage link is down, because the Spectrum version it pins cannot catch up on them.

## Development

```sh
npm run typecheck
npm test
```

`npm test` runs the unit tests of two pure functions: the view algorithm in `src/memory/view.test.ts` and the voice note remux in `src/media/caf.test.ts`. Everything else has no unit tests. To verify a change, run the real daemon on a copy of a store: `MOCHI_HOME=<copy> node src/main.ts -p "<prompt>"`. Without a running daemon, `-p` and `chat` start no channels and no board fires, so a copy reaches no one.

`SPEC.md` is the design: the process shape, conversations, tools, the prompt, memory, the board, agents, and the decisions that still hold and why.
