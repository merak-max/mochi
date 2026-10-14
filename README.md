# mochi

A personal agent that runs all day on your own machine. You text it on iMessage, Telegram or WhatsApp, and it does the work: email, calendar, the web, files, code, errands. It stays quiet until something needs you.

mochi is built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), the durable runtime under [pi](https://github.com/earendil-works/pi). Every reply, routine and helper is a durable task, so a crash or a restart never loses work or sends a message twice.

## What it does

- **One thread per person.** You get one long conversation across every channel. Each configured friend gets their own.
- **Few tools, one code mode.** The model sees three tools. Everything else (web, apps, files, agents, routines, memory) is a function its scripts call, so the first request is about 3,700 tokens.
- **Copies of itself.** `fork` copies the current conversation, context and all, and reuses its prompt cache, so trying three drafts at once costs the new tokens only. `agent` starts a fresh copy from a brief. Every copy has the same tools, so copies make copies, as deep as the work needs.
- **Routines.** Cron, one-shot and webhook triggers run in their own conversations. A cheap check script or a classifier gate decides whether a run happens at all, and a run reaches you only when it calls `notify`.
- **Roles.** A routine or a helper can run as a role: a Markdown file with instructions and a model. Routine roles run on the fast model.
- **Memory.** Notes you can read and edit, and searchable history. Before a quiet conversation is compacted, a fork of it, with the whole context still in its cache, saves anything worth keeping.
- **Profiles.** mochi can start other mochis, each with its own home, persona and memory, nested as deep as you like. They talk over A2A.
- **Prompt-cache care.** Stable prompt sections, bursts of texts answered in one turn, and quiet threads compacted while their cache is still warm.

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

Run it as a service with systemd (Linux):

```sh
node src/main.ts service install   # writes ~/.config/systemd/user/mochi.service
systemctl --user daemon-reload && systemctl --user enable --now mochi
```

`node src/main.ts --headless` starts the daemon by hand. `node src/main.ts -p "hello"` sends one message to a running daemon.

## Your home

Everything that is yours lives in `~/.mochi` (or `MOCHI_HOME`). The repository holds only code, bundled skills and bundled roles.

| Path | What |
|---|---|
| `config.toml` | Time zone, providers and models, routines, users, peers. See `config.example.toml`. |
| `.env` | Keys and tokens. See `.env.example`. |
| `persona.md` | Who mochi is to you. Optional. |
| `agents/*.md` | Your roles. A file with a bundled name replaces the bundled role. |
| `skills/` | Your skills, next to the bundled ones. |
| `memory/` | Your notes as Markdown in a local Git repository. |
| `profiles/<name>/` | Another mochi, with a home of its own. |
| `mochi.sqlite`, `work/` | The durable store and mochi's working directory. |

## Models

Any provider works, through one of three protocols. A gateway such as LiteLLM or Bifrost is one provider per protocol it serves.

```toml
[providers.gateway]
api = "anthropic"                 # or "responses", or "chat"
url = "https://gateway.example.com/anthropic"
keyEnv = "GATEWAY_KEY"

[models]
brain = "gateway/claude-opus-5-5"
fast = "gateway/claude-haiku-5-5"
```

## Roles

A role is a Markdown file with front matter:

```markdown
---
model: fast
thinking: medium
---

You are relay. You own the inboxes. Notify only when ignoring a mail would cost the owner something.
```

Put it in `~/.mochi/agents/relay.md`, then name it in a routine (`role = "relay"`) or ask mochi to start it as a helper.

## Profiles

Ask mochi: "make a profile called poteto for my day planning". It runs `profile_create`, which:

1. Creates `~/.mochi/profiles/poteto` with its own config, persona and keys. Channel keys are never copied.
2. Links it to its parent over A2A.
3. Starts it as a user service.

`poteto/relay` nests relay under poteto. Removing a profile stops it and everything below it, and archives its home.

## Development

```sh
npm run typecheck
npm test
node eval/surface.ts      # what the first request costs, per seat
```

`SPEC.md` is the design: process shape, conversations, tools, prompt, memory, triggers and the decision log.

## License

MIT. The bundled skills in `skills/` carry their own license.
