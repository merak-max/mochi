---
name: apps
description: The owner's apps through Executor (mail, calendar, GitHub, the logged-in browser). Read before apps_search or apps_call.
---
# Apps

Executor holds the owner's connected apps. Reach them from `code` with three functions:

- `apps_search({ query })` returns each matching tool's `path` and TypeScript `signature`. Search before every unfamiliar call. Never guess a path or an argument.
- `apps_call({ path, args })` calls one tool by that path. It acts for real. If a restart interrupts it, the script gets "interrupted" and the call is not run again, so read the app before you retry.
- `apps_skills({ app })` returns an app's instructions, or the list of apps without `app`. Read it before unfamiliar work in that app.

Approval prompts are off for mochi, so a call that needs approval fails. Tell the owner instead of retrying.

Ordinary web search, page reading and site maps use `web_search`, `web_fetch` and `web_map`. Use Executor's Firecrawl only for the logged-in browser. Scrape a page first with `profile: { name: "mochi", saveChanges: true }`, then interact with it using the same profile, so logins and cookies persist. If no interact tool shows up in `apps_search`, say so instead of improvising.

```js
const { items } = await tools.apps_search({ query: "github list pull requests" });
// items[0].signature names the profile path and accountId to pass
return await tools.apps_call({ path: items[0].path, args: { accountId: "acc_...", input: { owner: "o", repo: "r", state: "open" } } });
```
