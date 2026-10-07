/** A parsed 5-field cron expression: the allowed values of each field. */
export interface Cron {
	readonly minutes: ReadonlySet<number>;
	readonly hours: ReadonlySet<number>;
	readonly days: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	readonly weekdays: ReadonlySet<number>;
	/** Vixie cron: when both day fields are restricted, a slot matches either of them. */
	readonly dayOr: boolean;
}

interface Field {
	readonly name: string;
	readonly min: number;
	readonly max: number;
	readonly names?: readonly string[];
}

const FIELDS: readonly Field[] = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
	{ name: "day of week", min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];

/** Parses `m h dom mon dow` with `*`, ranges, steps and lists. Throws an error naming the bad field. */
export function parseCron(expression: string): Cron {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error(`Cron needs 5 fields (minute hour day month weekday), got ${parts.length}: "${expression}"`);
	const [minutes, hours, days, months, weekdays] = FIELDS.map((field, index) => parseField(parts[index] ?? "", field));
	if (minutes === undefined || hours === undefined || days === undefined || months === undefined || weekdays === undefined) {
		throw new Error(`Invalid cron "${expression}"`);
	}
	if (weekdays.has(7)) weekdays.add(0);
	weekdays.delete(7);
	return { minutes, hours, days, months, weekdays, dayOr: !parts[2]?.startsWith("*") && !parts[4]?.startsWith("*") };
}

function parseField(text: string, field: Field): Set<number> {
	const values = new Set<number>();
	for (const item of text.split(",")) {
		const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(item);
		if (match === null) throw new Error(`Invalid ${field.name} "${item}"`);
		const [range = "", stepText] = [match[1], match[2]];
		const step = stepText === undefined ? 1 : Number(stepText);
		if (step < 1) throw new Error(`Invalid ${field.name} step "${item}"`);
		let from: number;
		let to: number;
		if (range === "*") {
			[from, to] = [field.min, field.name === "day of week" ? 6 : field.max];
		} else {
			const [low = "", high] = range.split("-");
			from = value(low, field);
			to = high === undefined ? (stepText === undefined ? from : field.max) : value(high, field);
		}
		if (from > to) throw new Error(`Invalid ${field.name} range "${item}"`);
		for (let v = from; v <= to; v += step) values.add(v);
	}
	return values;
}

function value(text: string, field: Field): number {
	const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
	const parsed = named >= 0 ? named + field.min : /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!Number.isInteger(parsed) || parsed < field.min || parsed > field.max) {
		throw new Error(`Invalid ${field.name} "${text}" (allowed ${field.min}-${field.max})`);
	}
	return parsed;
}

/** Wall-clock fields of an instant in an IANA zone. */
export interface LocalTime {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formats = new Map<string, Intl.DateTimeFormat>();

/** Throws a RangeError for an unknown zone. */
export function localTime(date: Date, timeZone: string): LocalTime {
	let format = formats.get(timeZone);
	if (format === undefined) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			weekday: "short",
		});
		formats.set(timeZone, format);
	}
	const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
	};
}

export function assertTimeZone(timeZone: string): void {
	try {
		localTime(new Date(0), timeZone);
	} catch {
		throw new Error(`Unknown time zone "${timeZone}"`);
	}
}

const MINUTE = 60_000;
const SEARCH_LIMIT = 5 * 366 * 24 * 60 * MINUTE;

/** The first slot strictly after `after`, on a whole minute; undefined when none falls within five years. */
export function nextCronSlot(cron: Cron, timeZone: string, after: Date): Date | undefined {
	let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
	const end = t + SEARCH_LIMIT;
	while (t < end) {
		const local = localTime(new Date(t), timeZone);
		const dayMatches = cron.dayOr
			? cron.days.has(local.day) || cron.weekdays.has(local.weekday)
			: cron.days.has(local.day) && cron.weekdays.has(local.weekday);
		if (!cron.months.has(local.month) || !dayMatches || !cron.hours.has(local.hour)) {
			// Hour steps stay correct across offset changes: the next candidate is re-read in local time.
			t += (60 - local.minute) * MINUTE;
			continue;
		}
		if (cron.minutes.has(local.minute)) return new Date(t);
		t += MINUTE;
	}
	return undefined;
}

