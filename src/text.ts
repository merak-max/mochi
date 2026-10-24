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
