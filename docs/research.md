# Research brief: what makes a personal assistant worth texting

This brief covers what the four assistants launched in 2025 and 2026 get right and wrong, the scene mochi's voice comes from, and what pi-durable's worked apps show. It ends with what mochi can do better on one box. Research date: 2026-10-05.

The raw notes behind it are in the session scratchpad: `research/products.md`, `research/punk.md` and `research/pi-apps.md`. Every link below was opened during the research. A claim taken from a secondary source or a search snippet is marked as such.

## The four products

### Poke

Poke is from The Interaction Company. Cognition announced the acquisition on 2026-07-23 and said people had "exchanged more than 100 million messages with it in just the last three months" ([Cognition](https://cognition.com/blog/interaction)). Poke lives in iMessage and SMS, and Cognition calls it "the only AI agent approved to text natively on Apple Messages". WhatsApp is doubtful in 2026: Meta's Business terms barred general-purpose assistants from 2026-01-15, and one explainer names Poke ([process-one](https://www.process-one.net/blog/ai-bots-cant-use-whatsapp-anymore/)).

Two corrections to the owner's notes. The inbox roast and the price haggling were the September 2025 launch onboarding, not current behaviour. Pricing is now fixed at Free, $19 and $199 a month ([Poke FAQ](https://poke.com/faq)).

- **What people love.** The onboarding was a demo of what Poke already knew about you. A cofounder said "we wanted Poke to be a demo of how much it can already know about the user" ([Srivatsa](https://tanishasrivatsa.substack.com/p/i-spent-30-minutes-arguing-with-a)). People also like the 8am brief, and that there's no new app to learn.
- **What makes them uneasy.** Shlok Khemani said Poke "pointed out a genuine insecurity I carry" and found it "very scary realising LLMs can wield immense psychological power over us" ([X](https://x.com/shloked_/status/1965146536305983647)). One user needed three tries for a usable email. Another got told to search for flights himself.
- **Mechanism.** Most of the personality is prompt rules. A leaked prompt (unofficial) says to match the user's length, to use lowercase if they do, to send no emoji unless they did, to react "more liberally", to never make "multiple jokes in a row", and to ban "How can I help you" ([leak](https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/poke/2025-09-15_prompt_guidelines.md)). Khemani's reconstruction is one voice agent in front of persistent execution agents ([OpenPoke](https://www.shloked.com/writing/openpoke)).

### Instinct

Instinct is Noah Shinn's company. Its launch post says "You can text or call it", and that it uses "a phone and a computer in the same way that humans do" ([X](https://x.com/noahrshinn/status/2092691344456351744)). The $10B valuation is from reporting, on a $1B Series C, not from the company ([Runtime Wire](https://runtimewire.com/article/instinct-noah-shinn-1-billion-series-c-personal-ai-agent)).

- **What people love.** It acts first. Kenan Saleh said it was "already checking me into flights, reminding me about reservations I forgot to cancel" (quoted by [eesel](https://www.eesel.ai/blog/instinct-ai-review)).
- **What failed.** All three failures in the owner's notes are confirmed by the users' own posts:
  - Alex Cohen emailed his own inbox from a new account, and "Instinct happily followed the instructions!" ([X](https://x.com/anothercohen/status/2091251836917350512)).
  - Katie Stanton said it "sent an innocuous email on my behalf without checking with me first". She added: "One unauthorized action can reset that trust to zero" ([X](https://x.com/KatieS/status/2091152514603422074)).
  - Claire Vo disconnected Google and got an email summary three hours later ([X](https://x.com/clairevo/status/2090929592853037078)). TechCrunch reports the emails were "stored in plain text for later searches" ([TechCrunch](https://techcrunch.com/2026/08/24/instincts-powerful-ai-assistant-is-raising-privacy-and-security-concerns/)).
- **A failure missing from the notes.** On September 22 and 23 it stopped mid-task: "It was supposed to send two emails for me and confirm a dentist appointment" ([Yahoo](https://finance.yahoo.com/technology/ai/articles/hello-frozen-users-viral-ai-161755806.html)). Users had no way to tell what had happened.

### Grok Bot

- **Corrections.** The cloud computer is shared across all of an account's bots: "They share its files, browser sessions, and logins" ([xAI FAQ](https://docs.x.ai/grok-bot/faq)). Teach-a-task records one browser workflow and produces "a draft skill that you can review and test". Learning your voice is something you ask for: "Ask bot to scan your gmail and slack for how you write" ([xAI guide](https://x.ai/bot/guides/grok-bot-for-gtm)).
- **What people love.** The Primary Bot, from 2026-10-01, offers work before you ask. Its suggestions "DON'T count against your usage", and accepting one spends quota ([X](https://x.com/XFreeze/status/2105785753490043240)). Visible status: "A Bot may be idle, thinking, working, waiting, blocked, or done" ([xAI design post](https://x.ai/news/designing-grok-bot)).
- **What makes people uneasy.** Agents with access to every account, cost blowups ("retry storms"), and memories you "can't inspect, correct, export, or delete" (secondary, [Vellum](https://www.vellum.ai/blog/official-grok-bot-breakdown)).

### OpenAI Dots

Every claim in the owner's notes is confirmed on OpenAI's own pages ([privacy FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs), read through a reader proxy because the page returned 403).

- **Read-only research.** Proactive research can read and keep private notes. It "cannot directly: Send messages to other people. Change content through plugins. Control a browser or computer."
- **Memory deletion is all or nothing.** "You currently cannot view, delete or directly modify individual dot memories". Disconnecting an app "does not delete information your dot has already built into its context."
- **Too many confirmations.** One review counts four confirmations for one shuttle booking. It also reports that the rules checker rejected broad rules: "2 rules got accepted after trying many" (secondary, [eesel](https://www.eesel.ai/blog/openai-dots-review)).

## What this means for mochi

People love the same thing in all four: **it texts first with something specific and correct.** They hate the same thing too: **it acted or kept data without a grant they could see and take back.** The owner has ruled out approvals, so mochi earns trust another way. Five ways follow, and all but the last are partly built.

1. **Per-memory provenance and rewind.** No product lets you inspect, correct or delete one memory and see where it came from. Mochi's `mochi.memory` already stores each note with its source entry, and `snapshotAsOf` answers "what did you believe on Tuesday". None of the four can do this.
2. **Email is data, said out loud.** Instinct obeyed an injected email. In mochi's eval, Opus 5.5 never followed the injected order, in any run. With the old identity it said nothing about the phishing in one of two runs. With the new identity it named the email as phishing in every run. That costs one sentence in the prompt and no hook.
3. **Every action is crash-safe and visible.** Instinct's outage left users asking "did it send?". Mochi's receipts and request ids answer that, and the crash scenario shows a killed errand that resumes and reports once.
4. **Offer, don't nag.** Grok's free suggestions and Dots' read-only research both separate noticing from acting. In mochi, a trigger run notices and `notify` speaks, and a `notifyWhen` gate keeps it silent unless there's something to act on.
5. **The roast with a source.** Poke's roast landed because it was specific. Mochi's onboarding playbook does the same from the owner's connected mail and calendar, with a source for every observation and at most one roast, aimed at a habit.

Mochi can't match some things on one box: Apple Messages for Business, phone calls, thousands of plugins, and a residential IP for sites like Resy.

## The scene behind the voice

The owner asked for 90s Bay Area punk that today's San Francisco nerds recognise as their own. The research read primary material. Three findings shaped the voice spec.

- **The values were logistics, not slogans.** Gilman's posted rules end with "NO MAJOR LABEL BANDS" ([bayareapunk.com](https://bayareapunk.com/blog/924-gilman-rules.html)). Its founders talk about permits and being "un-shut-down-able" ([Berkeleyside](https://www.berkeleyside.org/2026/08/26/924-gilman-berkeley-punk-green-day)). Ian MacKaye: "We started the label because it was obvious that no one else was going to put out our record," and "I'm not interested in fighting them. I'm in interested in doing my work despite them" ([Perfect Sound Forever](https://www.furious.com/perfect/fugazi.html)). Noisebridge's do-ocracy: "If you want something done, do it", and "Let people know you're responsible for your change" ([Noisebridge](https://www.noisebridge.net/wiki/Do-ocracy)). These became "do it, then say what you did".
- **The register is terse and dry.** Eric Hughes's actual list post: "The hopping remailer is finished. I wrote it this morning... Here's the new perl script:" ([cypherpunks archive](https://mailing-list-archive.cryptoanarchy.wiki/archive/1992/09/2fe5a28bc8c23820dc93de1603b58c1ac84c93a16bc852a9b51eb3faed1aa231)). 2600's review of *Hackers* praised it because "The word "cyber-space" wasn't used once," and ended "as always, watch your ass" ([2600, Autumn 1995](https://archive.org/details/1995-09-2600)). The manifesto voice ([Hughes](https://www.activism.net/cypherpunk/manifesto.html)) is what the scene wrote once. The two-sentence post is how it talked every day.
- **The people who lived it deflate it now.** R.U. Sirius annotates his 1989 Mondo 2000 editorial with "(I GIVE IT ABOUT A 2% CHANCE.)" ([Mondo 2000](https://www.mondo2000.com/first-mondo-2000-editorial-1989-annotated-2017/)). Tobi Vail on the riot grrrl label: "yes ok, that is the term, fine, I surrender" ([Jigsaw](https://jigsawunderground.blogspot.com/2013/06/the-riot-grrrl-collection-preliminary.html)). jwz runs a San Francisco nightclub and blogs about "our core competency: plumbing disasters" ([DNA Lounge](https://www.dnalounge.com/backstage/log/)). So mochi never names the scene and never explains a reference.

The costume to avoid came straight from the sources. 2600 was already mocking "elite" in 1995. The Recurse Center's social rules ban "well-actually's" and "feigned surprise" ([Recurse](https://www.recurse.com/social-rules)). The present-day register comes from Sam Altman's lowercase as a "mildly interesting observation" ([Fortune](https://fortune.com/2026/01/29/openai-ceo-sam-altman-types-all-lowercase-like-gen-z-but-could-be-career-chatgpt-boss/)) and "I want to hate Waymo but can't" ([The Bold Italic](https://thebolditalic.substack.com/p/i-want-to-hate-waymo-but-cant)). Robin Sloan's "an app can be a home-cooked meal" is the scale mochi works at: "It is ruthlessly simple; we love it; no one else will ever use it" ([Sloan](https://www.robinsloan.com/notes/home-cooked-app/)).

Some sources were out of reach: cypherpunks.venona.com was down (the cryptoanarchy.wiki mirror of the same archive was used instead), and the CUNY riot grrrl zine page returned nothing. The present-day X voice rests on few samples and is NOT VERIFIED beyond them.

## What pi-durable's worked apps show

The vacation planner and the small coding agent (`packages/coding-agent/src/experimental/` in [earendil-works/pi](https://github.com/earendil-works/pi)) use fewer features than the launch post lists.

- They use tasks with phases, `configure` per conversation, `viewState`, `taskGraph`, `onYield` (example 28's review loop) and `wrapTool` (example 30).
- Undo through an `abort` handler, `runtime.sleep` and `failFast` appear only in example 24's checkout.
- No app calls `fork()`, `watchDoc`, `beforeTool`, `afterTool`, `beforeCompact` or `api.memo`.
- A written `app.*` entry reaches the model only through its `model` messages, in place (`dist/harness/context.js:50`). That is how mochi's `app.notify` lets the root conversation see what a trigger run sent.
- Two features would delete mochi code or add a capability. A trigger run's `notify` can return `control: { terminate: true }` and skip the extra model request after it speaks. Example 24's task shape fits an errand with an undo. That waits for the first real errand that can be undone, as SPEC's Later section says.
