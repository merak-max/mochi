# mochi

A personal agent that runs all day on your own machine. You text it on iMessage or WhatsApp, and it does the work: email, calendar, the web, files, code, errands. It stays quiet until something needs you.

mochi is built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), the durable runtime under [pi](https://github.com/earendil-works/pi). Every reply, routine, fork and profile run is a durable task, so a crash or a restart never loses work or sends a message twice.

## What it does

- **One thread per person.** You get one long conversation across every channel. Each configured friend gets their own.
- **Few tools, one code mode.** The model sees three tools. Everything else (web, apps, files, forks, profiles, routines, memory) is a function its scripts call.
- **Forks.** `fork` copies the current conversation, context and all, once per brief, six at a time. Every copy reuses the prompt cache, so trying three drafts at once costs only the new tokens. Copies fork too, as deep as the work needs.
- **Profiles.** A profile is a standing teammate in the same daemon, with its own role, model, tool list and memory. mochi gives it work with `profile_send` or a board task.
- **Memory that does not forget.** Memory and every conversation's turns are append-only logs. Old lines merge into summary lines once, in the background, and the prompt shows recent lines whole and older ones merged. `zoom` opens any merged line again.
- **Routines.** Cron and webhook triggers run in their own conversations as a chain of steps. A classify step is a fast yes/no question that stops the chain before the model runs, and a run reaches you only when it calls `notify`.
- **The board.** Every promise goes on the board with a due time. At the due time the board wakes the lead, root or a profile, with the task.

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

`node src/main.ts --headless` starts the daemon by hand. `node src/main.ts -p "hello"` sends one message to a running daemon. `node src/main.ts chat` sends each line of stdin.

## Your home

Everything that is yours lives in `~/.mochi`, or in `MOCHI_HOME`. The repository holds only code, bundled skills and the bundled `worker` profile.

| Path | What |
|---|---|
| `config.toml` | Time zone, providers and models, routines, users, peers, apps and web. See `config.example.toml`. |
| `.env` | Keys and tokens. See `.env.example`. |
| `instructions.md` | Root's own instructions, after the built-in prompt. Optional. |
| `profiles/<name>/instructions.md` | One profile. A profile with a bundled name replaces the bundled one. |
| `skills/` | Your skills, next to the bundled ones. |
| `mochi.sqlite`, `index.sqlite`, `work/` | The durable store, the search index and mochi's working directory. |

## Models

Any provider works through one of four protocols: `anthropic`, `responses`, `chat`, and `classifier` for the yes/no classifier. A gateway is one provider per protocol it serves.

```toml
[providers.gateway]
api = "anthropic"
url = "https://gateway.example.com/anthropic"
keyEnv = "GATEWAY_KEY"

[models]
brain = "gateway/claude-opus-5-5"
fast = "gateway/claude-haiku-5-5"
```

## Profiles

A profile is a Markdown file at `~/.mochi/profiles/<name>/instructions.md`, with front matter:

```markdown
---
description: Mail. Triage new mail and draft replies.
model: fast
thinking: medium
tools: recall, note, apps_search, apps_call, board_list, board_update, board_claim
---

You are relay. You own the inboxes. Notify only when ignoring a mail would cost the owner something.
```

`model` is a tier, an alias or `<provider>/<id>`. `tools` is optional. Without it the profile has every tool, and with it the profile has only those script functions plus `codemode`, `notify` and `handoff`. An edit reaches the profile's next message without a restart. Name a profile in a routine with `profile = "relay"`, or ask mochi to send it work.

## Development

```sh
npm run typecheck
```

There are no unit tests. Verify a change by running the real daemon on a copy of a store: `MOCHI_HOME=<copy> node src/main.ts -p "<prompt>"`. Without a running daemon, `-p` and `chat` start no channels and no triggers, so a copy reaches no one.

`SPEC.md` is the design: process shape, conversations, tools, prompt, memory, triggers, profiles and the decisions that still hold.

## License

MIT. The bundled skills in `skills/` carry their own license.
