# Epistemics

How to reason about confidence when evidence is historical, fragmentary, and sometimes contradictory, and how to communicate it without flattening it into false certainty.

A thing doesn't carry its own motivation. You can see a charge, a rule or a setting. You can't see *why it exists*. That lives in emails, chats, notes, terms and announcements, all incomplete, biased, and sometimes missing. Pretending otherwise produces confident guesses that mislead the owner.

## Claims about human decisions

When the exact scope of a human ruling matters, locate the person's original attributable words. Preserve a source pointer, the speaker, and enough original wording to establish scope. Label an agent summary or interpretation as such, regardless of its age. A paraphrase alone cannot establish the original instruction's exact scope. If the original is unavailable, say so and leave that scope uncertain; do not invent a firm restriction or permission.

For example, the owner's "don't book Indigo this month" and a note saying "the owner never flies Indigo" are different claims. Report the scoped original and the broader interpretation separately. Copies of that interpretation in several notes form one dependent evidence chain, not independent decisions. Trace them to their source before increasing confidence. This rule concerns human rulings; ordinary factual reporting does not require verbatim quotes for every claim.

## Confidence Tiers

Every claim in the answer must sit in one of these tiers. The tier determines which output section the claim goes in and how it's phrased.

### 1. Direct

An explicit, textual citation that answers the question. Not "it happened, so someone must have wanted it." Something a person or organization actually *wrote* that says why.

Examples:
- An email from the airline that says "your flight was cancelled due to a crew shortage"
- The bank's notice that says "the annual fee applies from your card's anniversary month"
- The owner writing in a past chat "let's skip the gym membership, I'm travelling too much"
- A provider's changelog that says "free tier limits reduced on 1 March"

Phrasing: confident, present tense. "This exists because X." Cite the source.

### 2. Supported

Multiple pieces of indirect evidence converge. No single source states it explicitly, but the pattern across sources makes it likely.

Examples:
- The charge date matches a renewal date in the order history, and the amount matches the plan price on the pricing page
- Three emails from the same week all mention the same schedule change

Phrasing: confident but clearly derived. "The evidence points strongly to X: [the specific pieces]." Cite multiple sources.

### 3. Inferred

A reasonable reading of the context, but nothing explicitly supports it. The reader should understand this is *your interpretation*, not a fact from the record.

Examples:
- The email doesn't say why the booking moved, but it arrived the day the venue announced renovations, so the move was likely related.

Phrasing: hedged. "It appears", "likely", "suggests", "is consistent with", "one reading is". Make the inference chain explicit: "Given A and B, C seems likely because D."

### 4. Speculative

A plausible hypothesis, but the evidence is thin and other explanations fit equally well. Presenting these is valuable, but mark them clearly as guesses.

Examples:
- "The fee may come from a currency conversion, but the statement doesn't break it out."

Phrasing: explicitly speculative. "One possibility is X, but we have no direct evidence." Usually lives in the "Competing Hypotheses" section alongside other possibilities.

### 5. Unknown

You looked and couldn't find out. A valid and important outcome. Document it.

Phrasing: "We searched X, Y, and Z and found no evidence of why." Be specific about *what* you searched. "We couldn't find out" is less useful than "we searched email for the merchant name and the amount since January, read the card's fee schedule, and searched past chats for the merchant. None explained the charge."

## Phrasing Guide

### Words that carry confidence. Use carefully

These imply **Direct** or **Supported** confidence. Don't use them for inferences.

- "because". Implies a causal claim with evidence
- "the reason is". Same
- "was designed to". Claims author intent
- "fixes", "addresses", "solves". Claims the change achieved its goal
- "the team decided". Claims a group decision happened

If you're using these, you should have a citation immediately adjacent.

### Words that hedge. Use for inferences

- "appears to"
- "seems to"
- "likely"
- "suggests"
- "is consistent with"
- "one reading is"
- "plausibly"
- "may have been"
- "the evidence points toward"

These signal that you're interpreting, not reporting. Use them liberally in the "What We Can Reasonably Infer" section.

### Words to avoid

- "obviously". If it were obvious, the owner wouldn't be asking
- "clearly". Almost always precedes a claim that isn't clear
- "of course". Same
- "just" (as in "it's just X for performance"). Dismissive and usually hides uncertainty
- "I think" / "I believe". You're synthesizing evidence, not giving a personal opinion. Use "the evidence suggests" instead.

### Avoid rationalization

Something that "makes sense" today may exist for reasons that no longer apply, or that were wrong at the time. Don't retrofit a clean rationale onto messy history.

Resist the urge to:
- Assume the other party did the "right" thing and work backward to justify it
- Assume a pattern was intentional when it might be an accident or a default
- Turn an absence of evidence into evidence of absence ("no one mentioned security concerns, so it must not have been a concern")

## The Sycophancy Trap

The owner often asks with a hypothesis built in: "Why did they charge me twice, is it the hotel's mistake?" Don't simply confirm it. Treat it as one candidate among others and check the evidence independently. If the evidence supports it, say so with citations. If not, say so and present what the evidence *does* support.

The owner's guess is a prompt for investigation, not a conclusion to validate.

## When Evidence Contradicts

If two sources disagree (the confirmation email says one thing, the app says another), surface both. Don't pick the one that fits a tidier story. Both may be true at different times, or one may be wrong. Present both with their citations and let the owner make the call.

## When Evidence Is Missing

An honest "we don't know" is one of the most valuable outputs this skill can produce. The owner now knows:

- The answer isn't in the obvious places
- They'll need to ask a person (support, the sender, the other party) to find out, and you can draft that message
- Or they can decide the question isn't worth pursuing

Failing to mark a gap and filling it with a confident guess harms the owner. They'll act on the guess.

When you hit a gap, name it concretely:
- What question you were trying to answer
- What sources you searched
- What you searched for in each
- What you found (nothing, or only tangentially related material)

## Calibration Check Before Finalizing

Before delivering the answer, review every claim in "What We Found" and "What We Can Reasonably Infer" and ask:

1. Does this claim have a citation? If not, either add one or move it to "Inferred" / "Hypotheses".
2. Is the phrasing calibrated to the tier? (A Direct claim can use "because". An Inferred claim cannot.)
3. Am I treating the thing itself as evidence for its own motive? A charge's existence doesn't explain it. Remove or reclassify.
4. Does the output include a "What We Don't Know" section? If no gaps are mentioned, that's suspicious. Either the evidence was unusually complete or something is being swept under the rug.
