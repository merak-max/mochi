import type { Bubble } from "./types.ts";

/** The iMessage send effects the SDK knows, by its own names. */
const EFFECTS = ["balloons", "celebration", "confetti", "echo", "fireworks", "gentle", "heart", "invisible", "lasers", "loud", "slam", "sparkles", "spotlight"] as const;
export type EffectName = (typeof EFFECTS)[number];

const EFFECT_ALIASES: Readonly<Record<string, EffectName>> = {
	"invisible ink": "invisible",
	love: "heart",
	hearts: "heart",
	impact: "slam",
	"happy birthday": "celebration",
	birthday: "celebration",
};

function effectName(raw: string): EffectName | undefined {
	const name = raw.trim().toLowerCase().replace(/\s+/g, " ");
	const known = EFFECTS.find((effect) => effect === name);
	return known ?? EFFECT_ALIASES[name];
}

interface OutgoingFile {
	readonly path: string;
	readonly voice: boolean;
}

interface Directives {
	readonly text: string;
	readonly files: readonly OutgoingFile[];
	readonly effect?: EffectName;
	readonly replyTo?: string;
}

const FILE_LINE = /^[ \t]*(attach|voice):[ \t]+(.+?)[ \t]*$/;
const EFFECT_LINE = /^[ \t]*effect:[ \t]+(.+?)[ \t]*$/;
const REPLY_LINE = /^[ \t]*reply:[ \t]+(\S+)[ \t]*$/;

/**
 * Takes the standalone directive lines out of a reply: attach: and voice: name files, effect: names a known effect, and
 * reply: names the message to thread on. The first effect and reply win. An effect line with an unknown name stays text.
 */
export function splitDirectives(text: string): Directives {
	const files: OutgoingFile[] = [];
	const kept: string[] = [];
	let effect: EffectName | undefined;
	let replyTo: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const file = FILE_LINE.exec(line);
		if (file?.[2]) {
			files.push({ path: file[2], voice: file[1] === "voice" });
			continue;
		}
		const named = EFFECT_LINE.exec(line);
		const found = named?.[1] === undefined ? undefined : effectName(named[1]);
		if (found !== undefined) {
			effect ??= found;
			continue;
		}
		const reply = REPLY_LINE.exec(line);
		if (reply?.[1]) {
			replyTo ??= reply[1];
			continue;
		}
		kept.push(line);
	}
	return { text: kept.join("\n"), files, ...(effect === undefined ? {} : { effect }), ...(replyTo === undefined ? {} : { replyTo }) };
}

/** Puts the effect on the first text bubble. */
export function withEffect(bubbles: readonly Bubble[], effect: EffectName | undefined): Bubble[] {
	const out = [...bubbles];
	if (effect === undefined) return out;
	const index = out.findIndex((bubble) => bubble.kind === "text");
	const first = out[index];
	if (first?.kind === "text") out[index] = { ...first, effect };
	return out;
}
