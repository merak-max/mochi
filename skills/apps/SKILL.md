---
name: apps
description: The owner's apps through Executor (mail, calendar, GitHub, the logged-in browser). Read before apps_search or apps_call.
---
# Apps

Executor holds the owner's connected apps. Call them from `codemode` with three tools:

- `apps_search({ query })` returns each matching tool's `path` and TypeScript `signature`. Search before each unfamiliar call. Do not guess a path or an argument.
- `apps_call({ path, args })` calls one tool by its path. The call is real. If a restart interrupts it, the script gets an "interrupted" error and the call does not run again. Read the app's state before you retry.
- `apps_skills({ app })` returns an app's instructions. Without `app`, it lists the apps. Read it before unfamiliar work in that app.

An app with more than one account takes `args: { accountId, input: { ... } }`. The signature names the `accountId`.

Mochi accepts Executor approvals by itself, so a gated call runs at once. Only the owner's conversation and trigger runs have these tools.

For ordinary web search, page reading and site maps, use `web_search`, `web_fetch` and `web_map`. Use Executor's Firecrawl only for sites where the owner is logged in:

1. Scrape the page with `profile: { name: "mochi" }`. Do not pass `saveChanges`.
2. Call Executor's Firecrawl interact on the returned `scrapeId` with a plain-language prompt.
3. Stop the session when you are done.

If the owner must log in, send them the live-view URL from the interact result. If `apps_search` finds no interact tool, tell the owner.

```js
const { items } = await tools.apps_search({ query: "github list pull requests" });
return await tools.apps_call({ path: items[0].path, args: { accountId: "acc_...", input: { owner: "o", repo: "r", state: "open" } } });
```
