# Skills

On-demand instructions for mochi. The prompt's skills index shows each skill's `name` and `description`, so the description says when to use the skill. The index gives the skills directory, and mochi opens a skill's `SKILL.md`, or a file it points at such as `mochi-mode/playbooks/errand.md`, with `read`.

| Skill | Use it for |
| --- | --- |
| `mochi-mode` | Any task beyond a one-line answer. Routes to a playbook and holds the rules for asking, verifying, subagents and replies. |
| `how`, `why`, `teach` | Explaining how something works, why it happened, or teaching it. |
| `recall` | Catching up on earlier work before resuming it. |
| `apps` | The owner's apps through Executor, from `codemode`. |
| `swarm`, `arena`, `interrogate` | Parallel fan-out, a multi-model bakeoff, and multi-model challenge. |
| `show-me-your-work` | The decision log for long or unattended work. |
| `reflect`, `automate-me` | Learning from a run, and learning the owner's style into notes. |
| `unslop`, `technical-writing`, `bro` | Writing rules, document structure, and plain restatement. |

Subagent types live in `../agents/`: `mochi` for delegated work that needs judgment and `worker` for an exact brief. Tiers and aliases come from `[models]` in the owner's `config.toml`.

## Adding or editing a skill

- One directory per skill with a `SKILL.md` whose frontmatter has `name` (the directory name) and `description`.
- Keep a skill short. Every line should change a decision. Point at other skills by name instead of repeating them.
- Name only mochi's real tools. Link files inside a skill with relative links that resolve.
- Run the checks in the next section after any change.

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
```

Provenance and licenses are in [NOTICE.md](NOTICE.md).
