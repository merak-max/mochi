---
name: apps
description: The owner's apps through Executor (mail, calendar, GitHub, the logged-in browser). Read before apps_search or apps_call.
---
# Apps

Call the owner's Executor apps from `codemode`:

- `apps_search({ query })` returns each tool's `path` and `signature`. Search before each unfamiliar call. Take paths and arguments only from the result.
- `apps_call({ path, args })` acts for real. An interrupted call is reported and never rerun: read the app's state before you retry.
- `apps_skills({ app })` returns an app's instructions, or lists the apps without `app`. Read it before unfamiliar work in that app.

An app with more than one account takes `args: { accountId, input: { ... } }`.

Executor approvals pass at once, so a gated call is a one-way door you walk through yourself. Apply the door rules from `mochi-mode` before the call.

For web search, page text and site maps, use `web_search`, `web_fetch` and `web_map`. For structured provider data (podcasts, app stores, filings), find a tool with the free `web_find_tools`, then run it with `web_alexandria`, which spends credits. Use Executor's Firecrawl only for sites where the owner is logged in:

1. Scrape the page with `profile: { name: "mochi" }`. Do not pass `saveChanges`.
2. Call Executor's Firecrawl interact on the returned `scrapeId` with a plain-language prompt.
3. Stop the session when you are done.

If the owner must log in, send them the live-view URL from the interact result. If `apps_search` finds no interact tool, tell the owner.

```js
const { items } = await tools.apps_search({ query: "github list pull requests" });
return await tools.apps_call({ path: items[0].path, args: { accountId: "acc_...", input: { owner: "o", repo: "r", state: "open" } } });
```
