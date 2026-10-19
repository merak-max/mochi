# NOTICE

The skills in this directory are adapted from MIT-licensed work. The copyright notices and license terms travel beside this file in [LICENSE](LICENSE).

| Included work | Upstream | Copyright | License |
| --- | --- | --- | --- |
| `mochi-mode` (from `poteto-mode`), `arena`, `automate-me`, `how`, `interrogate`, `recall`, `reflect`, `show-me-your-work`, `teach`, `unslop`, `why`, `swarm`, `technical-writing`, `bro`, and the agents in `../agents/` (from `poteto-agent`) | [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/e46364b8be46000b7df0f260550cd712afbb8d36/pstack), with later additions from [3fe2823](https://github.com/cursor/plugins/tree/3fe2823ce17c1656c222d4b7c59d3f82fbf20143/pstack) and [4612556](https://github.com/cursor/plugins/tree/4612556/pstack) | (c) 2026 Lauren Tan | MIT |
| The Claude Code port these were vendored from (pstack 0.9.69) | [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude) | (c) 2026 Michael Denyer | MIT |

Mochi trimmed the vendored copy to the skills that serve a personal assistant, rewrote them for mochi's tools, folded the principle skills into `mochi-mode`, and rewrote the playbooks for assistant work. These modifications are released under the same MIT license. No content from cursor-team-kit remains, so its license file is not carried.

`improve` adapts the method and prompts of [Harness²](https://github.com/google-research/harness2) (Copyright 2026 Google LLC, Apache License 2.0): the INV and DOM proposal dimensions, the compose step, and the experience library with per-edit verdicts. Mochi replaced probing on the same task with live signals judged on the next run, because its tasks act on the world. The Apache 2.0 license is at https://www.apache.org/licenses/LICENSE-2.0.
