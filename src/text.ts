import type { Message } from "@earendil-works/pi-ai";

/** The text parts of a model message; system messages, thinking and tool calls contribute nothing. */
export function messageText(message: Message): string {
	if (message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** `text` cut to `max` characters with "…", never inside a surrogate pair. */
export function clip(text: string, max: number): string {
	const chars = [...text];
	return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** `2026-10-05 14:02 IST` in the owner's zone. */
export function formatStamp(date: Date, timeZone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-IN", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZoneName: "short",
		})
			.formatToParts(date)
			.map((part) => [part.type, part.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}
