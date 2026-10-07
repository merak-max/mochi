import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredChannels, services } from "../main.ts";
import { setupReport } from "../setup.ts";
import { attachmentKind } from "./types.ts";

test("attachmentKind sorts images, audio and everything else", () => {
	assert.equal(attachmentKind("image/png"), "image");
	assert.equal(attachmentKind("audio/ogg; codecs=opus"), "audio");
	assert.equal(attachmentKind("application/pdf"), "file");
});

test("each outside service reports one readiness line naming its fix", () => {
	assert.deepEqual(setupReport(services({ dataDir: "/nonexistent", bifrostKey: "k", openRouterKey: undefined, firecrawlKey: undefined })), [
		"ok   models",
		"off  classifier (not configured)",
		"fix  firecrawl: FIRECRAWL_API_KEY is not set. Fix: export it where mochi starts",
		"fix  executor: not logged in. Fix: node src/main.ts auth executor",
	]);
	assert.deepEqual(configuredChannels({ PHOTON_PROJECT_ID: "p" }).report[0], "fix  imessage: PHOTON_PROJECT_SECRET, IMESSAGE_OWNER are not set. Fix: export them where mochi starts");
});

test("each adapter reports one readiness line, and only ready ones run", () => {
	const { channels, report } = configuredChannels({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_ID: "42", WHATSAPP_TOKEN: "w" });
	assert.deepEqual([...channels.keys()], ["telegram"]);
	assert.deepEqual(report, [
		"off  imessage (not configured)",
		"ok   telegram",
		"fix  whatsapp: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_OWNER are not set. Fix: export them where mochi starts",
	]);
});
