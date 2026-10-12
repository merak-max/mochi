# Errand

**You own the outcome in the world, not the tool calls.**

1. State done as something you can observe, such as "event on Friday 7pm with Riya invited" or "order confirmation email received".
2. Find the tool. The owner's apps go through Executor inside `code`. Read the apps skill, find the tool with `apps_search`, call it with `apps_call`, and read the app's instructions with `apps_skills` before unfamiliar work. Sites the owner is logged into go through Firecrawl in Executor: scrape with the persistent profile first, then interact. Public pages use `web_fetch`.
3. Check what the act commits the owner to: money, a message in their name, a fee, data shared with someone. If it can't be undone, check the specifics yourself (what, to whom, cost, deadline), then act. Do not wait for the owner.
4. Go one step at a time and check each result before the next: the form saved before submit, the cart right before paying.
5. Verify on the real thing. Read back the event, the sent mail, the confirmation page or email. Save what the owner will need later, such as a confirmation number, as a note or in the calendar entry.
6. If a site blocks you with a captcha, a login or 2FA, try once yourself. Then send the owner the one step only they can do, with the link (for a browser session, its live view link), and continue when they are done.

**Reply:** what is done, the proof (confirmation number, link, time), what is left for the owner, and anything NOT VERIFIED.
