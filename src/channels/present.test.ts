import { WHATSAPP_PROFILE } from "./whatsapp.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IMESSAGE_PROFILE } from "./imessage.ts";
import { present } from "./present.ts";

const texts = (text: string) => present(text, IMESSAGE_PROFILE).map((bubble) => (bubble.kind === "text" ? bubble.text : bubble.kind === "link" ? `<${bubble.url}>` : bubble.name));

test("present splits paragraphs into at most three bubbles, merging the rest into the last", () => {
	const five = ["First paragraph here.", "Second paragraph here.", "Third paragraph here.", "Fourth paragraph here.", "Fifth paragraph here."];
	assert.deepEqual(texts(five.join("\n\n")), [five[0], five[1], five.slice(2).join("\n\n")]);
	assert.deepEqual(texts("One line.\nSame bubble, next line."), ["One line.\nSame bubble, next line."]);
});

test("present sends nothing for blank text, and strips only the true blanks", () => {
	for (const blank of ["", "  \n\n ", "\u{200B}", "\u{FEFF}\u{2060} \u{200B}"]) assert.deepEqual(present(blank, IMESSAGE_PROFILE), [], JSON.stringify(blank));
	assert.deepEqual(texts("on\u{200B}it\u{FEFF}"), ["onit"]);
});

test("present keeps ZWJ and ZWNJ sequences byte-identical", () => {
	const technologist = "\u{1F469}\u{200D}\u{1F4BB} shipping it now";
	const devanagari = "\u{915}\u{94D}\u{200D}\u{937}\u{924}\u{94D}\u{930}\u{93F}\u{92F} and \u{915}\u{94D}\u{200C}\u{937}";
	assert.deepEqual(texts(technologist), [technologist]);
	assert.deepEqual(texts(devanagari), [devanagari]);
	assert.deepEqual(texts(`${technologist}\n\n${devanagari}`), [technologist, devanagari]);
});

test("a URL alone is a link bubble, also when it sits on its own line inside a paragraph", () => {
	assert.deepEqual(present("https://example.com/menu", IMESSAGE_PROFILE), [{ kind: "link", url: "https://example.com/menu" }]);
	assert.deepEqual(texts("Here is the menu for tonight:\nhttps://example.com/menu\nThe ramen is good."), [
		"Here is the menu for tonight:",
		"<https://example.com/menu>",
		"The ramen is good.",
	]);
	assert.deepEqual(present("see https://example.com/menu", IMESSAGE_PROFILE), [{ kind: "text", text: "see https://example.com/menu" }]);
});

test("short fragments merge into a neighbour and a long paragraph splits at a sentence end", () => {
	assert.deepEqual(texts("done.\n\nThe flight is booked for Friday."), ["done.\n\nThe flight is booked for Friday."]);
	const sentence = "This sentence is exactly long enough to matter here. ";
	const long = sentence.repeat(10).trim();
	const bubbles = texts(long);
	assert.equal(bubbles.length, 2);
	assert.ok(bubbles[0]!.length <= IMESSAGE_PROFILE.maxBubbleChars && bubbles[0]!.endsWith("."));
	assert.equal(bubbles.join(" "), long);
	assert.deepEqual(texts("x".repeat(500)), ["x".repeat(500)], "a word longer than a bubble is never cut");
});

test("a channel without paragraph bubbles sends one bubble", () => {
	assert.deepEqual(present("One.\n\nTwo paragraphs here.", WHATSAPP_PROFILE), [{ kind: "text", text: "One.\n\nTwo paragraphs here." }]);
});
