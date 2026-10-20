---
name: unslop
description: Rules that cut AI tells. Read before you write more than a few lines for the owner or in their name.
---

# Unslop

Scan for the patterns below, then rewrite. Keep the meaning and the intended tone. Rule numbers are stable ids: a removed rule leaves a gap.

## Content

3. **Superficial -ing phrases.** "highlighting...", "ensuring...", "showcasing...". Delete, or expand with real sources.
5. **Vague attributions.** "Experts believe", "Some critics argue". Name the source or delete.

## Language

7. **AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant. Use plain words.
8. **Fancy "is".** "serves as", "stands as", "boasts", "features". Say "is" or "has".
9. **"Not just X, but Y."** State the point.
10. **Rule of three.** Use the natural number of items.
11. **Synonym cycling.** Flight, trip, journey and itinerary for one thing. Pick one and repeat it.
12. **False ranges.** "from X to Y" with no real scale. List the topics.

## Style

13. **Dashes.** Never an em dash or an en dash, and no hyphen as a dash. End the sentence, or use a comma, a colon or parentheses.
14. **Colon as a crutch.** A colon before a list, an example or an explanation is fine. Cut the colon that props up comparison framing: "If you're coming from traditional automation: instead of registering event handlers, you describe conditions" becomes "Describe when the reminder should fire in plain English."
15. **Boldface overuse.** Do not bold every proper noun or acronym.
16. **Inline-header lists.** A bold label and colon that restate the line ("**Performance:** Performance improved...") become prose. A bold lead-in that ends in a period and is followed by new detail ("**Schema in TypeScript.** Tables live in one file.") is fine.
17. **Title case headings.** Use sentence case.
18. **Decorative emojis.** Remove them from headings and bullets.
19. **Curly quotes.** Use straight quotes.

## Communication artifacts

20. **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Certainly!", "Found the smoking gun!" Remove.
22. **Sycophancy.** "Great question! You're absolutely right!" Answer directly.

## Filler

23. **Filler phrases.** "In order to" becomes "to". "Due to the fact that" becomes "because". "It is important to note that" goes.
24. **Excessive hedging.** "could potentially possibly be argued that it might" becomes "may".
25. **Generic conclusions.** "The future looks bright." State specific plans or facts.

## Jargon

26. **Abstract metaphor nouns.** Substrate, wedge, vector, locus, vantage, nexus, primitive (noun), harness (metaphor), surface ("API surface"), bedrock, scaffolding (metaphor), modality, paradigm, gold-plating, ratchet (metaphor), evacuate (for moving code), endgame, north star, flywheel. Pick the concrete word: "substrate" is "base", "wedge in" is "add", "gold-plating" is "more than the job needs", "ratchet" is "a limit that only tightens", "endgame" is "the last phase".

## Plain speech

27. **Say what it does, not how it feels.** "SQL you can read" names a feeling. "`.toSQL()` returns the exact string sent to the database" names the mechanism. If a sentence cannot become a concrete instruction, fact or number, cut it. If it could appear unchanged in another project's docs, cut it.
28. **Dense sentences.** If the reader must backtrack, split the sentence or drop clauses. One idea per sentence.
29. **Active voice.** Name the actor: "queries are validated" becomes "the compiler validates queries". Use the passive only when the actor is unknown or does not matter.
30. **Adverbs.** "runs quickly" becomes "is fast" or the number. "significantly improves" becomes the measured delta.
31. **The plain word.** "utilize" and "leverage" are "use", "facilitate" is "help", "numerous" is "many", "in the event that" is "if".
32. **Mannered prose.** Aphorisms ("wire it or delete it"), fragments for effect, personified code ("the plan holds it"), figurative verbs ("rides along"), stock framing. "A dial worth turning" becomes "a parameter worth varying".
33. **Over-compression.** Dropped articles, verbless fragments, arrows and abbreviations. "Parser rejects bad date → exit 2, no write" becomes "The parser rejects a bad date, exits with code 2, and writes nothing."
