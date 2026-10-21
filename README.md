# mochi

![Preparations for New Year's Day (Pounding Mochi), Utagawa Kunisada, 1834 to 1867](docs/pounding-mochi.jpg)

*Preparations for New Year's Day (Pounding Mochi), by Utagawa Kunisada, via Wikimedia Commons. Public domain.*

mochi is a personal agent that runs all day on a machine you own. You text it on iMessage or WhatsApp, and it does the work: mail, calendar, the web, files, code, errands. Most of the time it says nothing, because most of the time nothing needs you. This README covers what it does, how it stays up, how to run it, and some numbers from running it on one person's life for a few weeks.

Housekeeping items:

- mochi is one person's daily tool, published as is. It works for me. It will need edits to work for you.
- It is built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), the durable runtime under [pi](https://github.com/earendil-works/pi). Most of what is interesting here comes from that.
- MIT license. The bundled skills in `skills/` carry their own license.

## What it does

You get one long conversation across every channel. Text it "move my 4pm to Friday" from your phone, and the reply comes back in the same thread. Each friend you configure gets a thread of their own, and those threads never see your memory or your apps.

The model sees three tools. One of them, `codemode`, runs JavaScript in a sandbox, and everything else is a function that script calls: the web, your apps through an MCP server, files, a shell, memory, forks, profiles, routines. This sounds like a small detail, and it is the main design choice. A model that writes a loop over 200 mails and filters them before it reads anything uses far fewer tokens than a model that calls a tool 200 times. It also keeps the first request small, which keeps the prompt cache warm.

When a task splits, `fork` copies the current conversation, context and all, once per brief, six at a time. Each copy reads the parent's prompt cache, so three drafts at once cost about the price of the new tokens. Measured on Opus 5.5, each fork's first request read about 6,500 cached tokens and wrote about 225. Forks can fork, three levels deep.

Some work is standing work: someone has to watch the inbox, the bills, the outreach. That is a profile. A profile is a Markdown file with a role, a model, a tool list and its own memory, and it lives inside the same daemon. mochi hands it work, or a routine runs under it.

## Memory that does not forget

Memory and every conversation's turns are append-only logs. Old lines merge into summary lines, once, in the background, following the merge tree from OptMem. The prompt shows recent lines whole and older ones merged, and `zoom` opens any merged line back down to the raw text. Nothing is summarized twice and nothing is thrown away.

The reason for this is a failure the earlier design had. It rewrote the whole history on each compaction, and each pass lost a little. Promises died first. Of 23 commitments mochi made from October 6 to 14, 10 had nothing behind them by the end of the week. So now every promise goes on a board with a due time, and at the due time the board wakes a copy of mochi with the task.

## Routines

Cron and webhook triggers run in their own conversations, as a chain of steps. A step can be a classify step: a fast yes or no question that stops the chain before the model runs. A mail check that runs every 30 minutes and usually finds nothing costs one classifier call, not one model call. A run reaches you only when it calls `notify`, so silence is the default.

## It survives a crash

Every reply, routine, fork and profile run is a durable task in one SQLite file. A crash or a restart picks up where it stopped. A reply records each bubble as it sends, so a crash repeats at most one bubble, and a message that arrives twice is answered once.

Delivery has three kinds of failure, and each has one response. A channel that is down waits 5 seconds, doubles up to 5 minutes, and gives up after an hour. A send whose outcome is unknown retries once. A send the platform refuses for good is skipped.

## Some numbers

From about two weeks of my own use, on one 8-core ARM EC2 box in Mumbai:

- Reply delivery: the send itself has a median of 661 ms, p90 3.4 s and p99 12 s over 299 sends. Most of the tail is Photon's servers in us-west-1. (`jq` over `turn.sent` lines in `mochi.log`.)
- Your message to its first bubble is mostly the model writing. A one-line Opus reply takes 4 to 11 s.
- Cost: over 8 days the gateway logged about $1,110, of which Opus was $723. That is the price of using the strongest model as the brain for everything, and it is the first thing I would change for you.

## Start

You need Node 24 or newer.

```sh
git clone https://github.com/0oAstro/mochi && cd mochi
npm install
mkdir -p ~/.mochi
cp config.example.toml ~/.mochi/config.toml
cp .env.example ~/.mochi/.env && chmod 600 ~/.mochi/.env
$EDITOR ~/.mochi/.env            # at least ANTHROPIC_API_KEY
node src/main.ts                 # a terminal UI; it becomes the daemon
```

To run it as a systemd user service on Linux:

```sh
node src/main.ts service install   # writes ~/.config/systemd/user/mochi.service
systemctl --user daemon-reload && systemctl --user enable --now mochi
```

`node src/main.ts --headless` starts the daemon by hand. `node src/main.ts -p "hello"` sends one message to a running daemon. `node src/main.ts chat` sends each line of stdin. `node src/main.ts help` lists the rest.

iMessage goes through [Photon Spectrum](https://photon.codes), which needs a project id and secret. WhatsApp uses the Cloud API directly and needs a public webhook URL. See `.env.example`.

## Your home

Everything that is yours lives in `~/.mochi`, or in `MOCHI_HOME`. The repository holds only code, bundled skills and the bundled `worker` profile.

| Path | What |
|---|---|
| `config.toml` | Time zone, providers and models, routines, users, peers, apps and web. See `config.example.toml`. |
| `.env` | Keys and tokens. See `.env.example`. |
| `instructions.md` | Your own instructions, after the built-in prompt. This is where its voice comes from. |
| `profiles/<name>/instructions.md` | One profile. A profile with a bundled name replaces the bundled one. |
| `skills/` | Your skills, next to the bundled ones. |
| `mochi.sqlite`, `index.sqlite`, `work/` | The durable store, the search index and mochi's working directory. |

## Models

Any provider works through one of four protocols: `anthropic`, `responses`, `chat`, and `classifier` for the yes or no classifier. A gateway is one provider per protocol it serves.

```toml
[providers.gateway]
api = "anthropic"
url = "https://gateway.example.com/anthropic"
keyEnv = "GATEWAY_KEY"

[models]
brain = "gateway/claude-opus-5-5"
fast = "gateway/glm-5.3-flash"

[models.aliases]
sol = "gateway/gpt-6.1-sol"
```

`brain` answers you. `fast` summarizes memory, runs routines and reads data for scripts. Profiles and triggers pick a tier or an alias by name.

## Profiles

A profile is a Markdown file at `~/.mochi/profiles/<name>/instructions.md`:

```markdown
---
description: Mail. Triage new mail and draft replies.
model: fast
thinking: medium
tools: recall, note, apps_search, apps_call, board_list, board_update, board_claim
---

You are relay. You own the inboxes. Notify only when ignoring a mail would cost the owner something.
```

`tools` is optional. Without it the profile has every function. An edit reaches the profile's next message without a restart. Name a profile in a routine with `profile = "relay"`, or ask mochi to send it work.

## What it does not do

There are no approvals, guard hooks or tool sandbox. mochi runs as your user, with your files and your keys. A prompt injection in a web page or a mail can reach them. I accept that cost on my own machine. You should decide for yours.

Messages sent while the iMessage link is down are not replayed, because the Spectrum version it pins has no catch-up for them.

## Development

```sh
npm run typecheck
```

There are no unit tests. Verify a change by running the real daemon on a copy of a store: `MOCHI_HOME=<copy> node src/main.ts -p "<prompt>"`. Without a running daemon, `-p` and `chat` start no channels and no triggers, so a copy reaches no one.

`SPEC.md` is the design: process shape, conversations, tools, prompt, memory, triggers, profiles, and the decisions that still hold and why.
