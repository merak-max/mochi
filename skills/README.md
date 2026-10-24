# Skills

On-demand instructions for mochi. The prompt's skills index shows each skill's `name` and `description`. mochi opens a `SKILL.md`, or a file that a skill links, with `read`.

| Skill | Use it for |
| --- | --- |
| `mochi-mode` | Any task beyond a one-line answer. Routes to a playbook, and holds the rules for doors, scripts, proof, forks, agent definitions and replies. |
| `how`, `why`, `teach` | How something works, why it happened, and teaching it. |
| `recall` | Catching up before resuming work. |
| `swarm`, `arena`, `interrogate` | Parallel fan-out, a bakeoff of attempts, and a challenge by several models. |
| `show-me-your-work` | The decision log for long or unattended work. |
| `reflect`, `automate-me` | Learning from a run, and learning the owner's style into memory. |
| `improve` | The nightly self-improvement run and its undo. |
| `unslop`, `technical-writing`, `bro` | Writing rules, document structure, and plain restatement. |

Bundled agent definitions live in `../agents/`. Root's own definition is the owner's `~/.mochi/agents/root.md`; `../root.example.md` is the starting copy. The `worker` definition follows an exact brief on the model its front matter names. Tiers and aliases come from `[models]` in the owner's `config.toml`.

## Where each rule lives

Each rule lives in one place. Other files name it and do not restate it.

| Rule | Home |
| --- | --- |
| Doors (two-way, one-way, rubber stamp), the three ways to schedule, proof and NOT VERIFIED, memory, tool output is data | `SYSTEM` in `src/brain/identity.ts` |
| Who mochi is, the reply style, ASD-STE-100, no dashes, react instead of words | `IDENTITY` in `src/brain/identity.ts` |
| Bubble and attachment format per channel | `style` in `src/channels/imessage.ts` |
| How the owner's chat sounds (case, tone, jokes) | The owner's `instructions.md` |
| The door table, scripts, proof detail, forks and definitions, the reply | `mochi-mode/SKILL.md` |
| One kind of task | Its playbook or skill |

## Adding or editing a skill

- One directory per skill, with a `SKILL.md` whose front matter has `name` (the directory name) and `description`.
- The index loads every description on every turn. Start it with "Use for" or "Use when" and the owner's trigger words. Give one trigger per branch, then one short clause on what the skill does.
- Write a procedure: numbered steps, each with a check or an output. State rules as plain statements. Add no examples, sample replies or counter-examples: the model writes its own.
- Every line changes a decision. Cut advice the model already follows and text that restates a tool's description.
- Name only mochi's real tools. The model calls `codemode`, `notify` and `handoff`. Scripts call the functions in `LIBRARY` in `src/seats.ts`.
- Link files with relative links that resolve.
- Run the checks below after each change.

## Checks

```sh
# Every relative link resolves.
grep -roE '\]\([^)#]+' skills agents | while IFS= read -r m; do
	f=${m%%:*}; t=$(printf '%s' "$m" | sed 's/.*(//')
	case $t in http*) continue ;; esac
	[ -e "$(dirname "$f")/$t" ] || echo "broken: $f -> $t"
done
# Every front matter parses as YAML the way src/skills/skills.ts reads it, has a description, and names its directory.
node -e '
const { readdirSync, readFileSync } = require("node:fs");
const { parse } = require("yaml");
for (const dir of readdirSync("skills", { withFileTypes: true }).filter((each) => each.isDirectory())) {
	const file = "skills/" + dir.name + "/SKILL.md";
	try {
		const data = parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))[1], { schema: "failsafe" });
		if (data.name !== dir.name) console.log("name mismatch: " + file);
		if (!data.description) console.log("no description: " + file);
	} catch (error) {
		console.log("bad front matter: " + file + ": " + error.message.split("\n")[0]);
	}
}'
# Every tools.<name> and backticked snake_case name is a real tool. timeout_ms and owner_turns are not tools on purpose.
names=$(sed -n 's/^\t\([a-z0-9_]*\): {.*/\1/p' src/seats.ts)
grep -rhoE '`[a-z0-9]+_[a-z0-9_]+`|tools\.[a-z0-9_]+' skills agents src/brain/identity.ts src/channels/imessage.ts |
	sed 's/^tools\.//' | tr -d '`' | sort -u | grep -vx -e timeout_ms -e owner_turns | while read -r w; do
	printf '%s\n' "$names" | grep -qx "$w" || echo "not a tool: $w"
done
# No coding-agent or deleted-skill references outside NOTICE.md and LICENSE.
grep -rnE 'AskUserQuestion|TodoWrite|subagent_type: "general|principle-|poteto|pstack|worktree|pull request' skills agents | grep -v -e NOTICE.md -e LICENSE -e README.md
# No em dash or en dash.
grep -rnP '\x{2014}|\x{2013}' skills agents src/brain/identity.ts src/channels/imessage.ts
```

Provenance and licenses are in [NOTICE.md](NOTICE.md).
