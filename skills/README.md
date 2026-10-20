# Skills

On-demand instructions for mochi. The prompt's skills index shows each skill's `name` and `description`, and mochi opens a `SKILL.md`, or a file it links such as `mochi-mode/playbooks/errand.md`, with `read`.

| Skill | Use it for |
| --- | --- |
| `mochi-mode` | Any task beyond a one-line answer. Routes to a playbook and holds the door rules and the rules for verifying, forks, profiles and replies. |
| `how`, `why`, `teach` | How something works, why it happened, and teaching it. |
| `recall` | Catching up before resuming work. |
| `apps` | The owner's apps through Executor, from `codemode`. |
| `swarm`, `arena`, `interrogate` | Parallel fan-out, a multi-model bakeoff, and multi-model challenge. |
| `show-me-your-work` | The decision log for long or unattended work. |
| `reflect`, `automate-me` | Learning from a run, and learning the owner's style into memory. |
| `improve` | The nightly self-improvement run and its undo. |
| `unslop`, `technical-writing`, `bro` | Writing rules, document structure, and plain restatement. |

Bundled profiles live in `../agents/`. The `worker` profile follows an exact brief on the model its front matter names. Tiers and aliases come from `[models]` in the owner's `config.toml`.

## Adding or editing a skill

- One directory per skill, with a `SKILL.md` whose front matter has `name` (the directory name) and `description`.
- The index loads every description each turn. Front-load the leading word and give one trigger per branch.
- Every line changes a decision. State each rule in one place and point at it by name. Door rules live in `mochi-mode`.
- Name only mochi's real tools. Do not restate what a tool's description already says. Link files with relative links that resolve.
- Run the checks below after each change.

## Checks

```sh
# Every relative link resolves.
grep -roE '\]\([^)#]+' skills agents | while IFS= read -r m; do
	f=${m%%:*}; t=$(printf '%s' "$m" | sed 's/.*(//')
	case $t in http*) continue ;; esac
	[ -e "$(dirname "$f")/$t" ] || echo "broken: $f -> $t"
done
# No coding-agent or deleted-skill references outside NOTICE.md and LICENSE.
grep -rnE 'AskUserQuestion|TodoWrite|subagent_type: "general|principle-|poteto|pstack|worktree|pull request' skills agents | grep -v -e NOTICE.md -e LICENSE -e README.md
# No em dash or en dash.
grep -rnP '\x{2014}|\x{2013}' skills agents
```

Provenance and licenses are in [NOTICE.md](NOTICE.md).
