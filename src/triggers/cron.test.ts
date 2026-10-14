import assert from "node:assert/strict";
import { test } from "node:test";
import { nextCronSlot, parseCron } from "./cron.ts";

const next = (expression: string, tz: string, after: string) => nextCronSlot(parseCron(expression), tz, new Date(after))?.toISOString();

test("cron steps and ranges in Asia/Kolkata land on IST wall-clock slots", () => {
	assert.equal(next("*/15 9-17 * * 1-5", "Asia/Kolkata", "2026-10-05T03:20:00Z"), "2026-10-05T03:30:00.000Z");
	assert.equal(next("*/15 9-17 * * 1-5", "Asia/Kolkata", "2026-10-05T03:30:00Z"), "2026-10-05T03:45:00.000Z");
	assert.equal(next("*/15 9-17 * * mon-fri", "Asia/Kolkata", "2026-10-09T12:20:00Z"), "2026-10-12T03:30:00.000Z");
	assert.equal(next("0 0 * * *", "Asia/Kolkata", "2026-10-05T03:20:00Z"), "2026-10-05T18:30:00.000Z");
});

test("cron in UTC: lists, day-of-week, and the day-of-month OR weekday rule", () => {
	assert.equal(next("0 0 1,15 * *", "UTC", "2026-10-05T10:00:00Z"), "2026-10-15T00:00:00.000Z");
	assert.equal(next("30 2 * * 0", "UTC", "2026-10-05T10:00:00Z"), "2026-10-11T02:30:00.000Z");
	assert.equal(next("30 2 * * 7", "UTC", "2026-10-05T10:00:00Z"), "2026-10-11T02:30:00.000Z");
	assert.equal(next("0 12 13 * 5", "UTC", "2026-10-05T10:00:00Z"), "2026-10-09T12:00:00.000Z");
	assert.equal(next("10-20/5 * * * *", "UTC", "2026-10-05T10:20:00Z"), "2026-10-05T11:10:00.000Z");
	assert.equal(next("0 9 29 2 *", "UTC", "2026-10-05T10:00:00Z"), "2028-02-29T09:00:00.000Z");
});

test("invalid cron expressions are rejected with the bad field", () => {
	assert.throws(() => parseCron("60 * * * *"), /minute "60"/);
	assert.throws(() => parseCron("* * *"), /5 fields/);
	assert.throws(() => parseCron("* * * * mon-xyz"), /day of week/);
	assert.throws(() => parseCron("*/0 * * * *"), /step/);
	assert.throws(() => parseCron("5-1 * * * *"), /range/);
});
