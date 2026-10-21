---
name: apps
description: Use before apps_search or apps_call, or on a site where the owner is logged in. The owner's apps and browser through Executor.
---

# Apps

Executor holds the owner's apps. Scripts reach it with three tools:

- `apps_search({ query })` returns each tool's `path` and `signature`. Search before each unfamiliar call, and take paths and arguments only from the result.
- `apps_call({ path, args })` acts for real. An interrupted call is reported and never rerun, so read the app's state before you retry.
- `apps_skills({ app })` returns an app's own instructions, or the list of apps when you omit `app`. Read it before unfamiliar work in that app.

An app with more than one account takes `args: { accountId, input: { ... } }`.

```js
const { items } = await tools.apps_search({ query: "github list issues" });
return await tools.apps_call({ path: items[0].path, args: { accountId: "acc_...", input: { owner: "o", repo: "r", state: "open" } } });
```

Executor passes its approvals at once, so a gated call is a one-way door that you open yourself. Apply the door rules before the call.

## Pick the web tool

| Need | Tool |
| --- | --- |
| Search, page text, a site map | `web_search`, `web_fetch`, `web_map` |
| Structured provider data (podcasts, app stores, filings) | Find a tool with `web_find_tools` (free), then run it with `web_alexandria` (spends credits) |
| A site where the owner is logged in | Executor's Firecrawl, below |

## The logged-in browser

1. Scrape the page with `profile: { name: "mochi" }`. Do not pass `saveChanges`.
2. Call Executor's Firecrawl interact on the returned `scrapeId` with a plain-language prompt.
3. Stop the session when you are done.

If the owner must log in, send the live-view URL from the interact result. If `apps_search` finds no interact tool, tell the owner.
