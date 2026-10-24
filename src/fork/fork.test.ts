import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_CONVERSATION_ID, type ConversationId } from "@earendil-works/pi-durable";
import { forkWakeTurn, wakesRoot } from "./fork.ts";
import { wakeChannelOf } from "../turn/turn.ts";

test("a finished background child wakes root with its note as a chat Turn", () => {
	const turn = forkWakeTurn("task-1", "video", "done: attach: out/video.mp4", "imessage");
	assert.equal(turn.source, "chat");
	assert.equal(turn.channel, "imessage");
	assert.equal(turn.key, "fork-back:task-1");
	assert.equal(turn.text, "[video]\ndone: attach: out/video.mp4");
	assert.deepEqual(turn.files, []);
});

test("a background child of root wakes at once, any other caller reads the note on its next turn", () => {
	const root = ROOT_CONVERSATION_ID;
	const child = "2" as unknown as ConversationId;
	assert.equal(wakesRoot(root), true);
	assert.equal(wakesRoot(child), false);
});

test("the wake replies on the owner's last channel, cli when none", () => {
	assert.equal(wakeChannelOf("imessage", (id) => id === "imessage"), "imessage");
	assert.equal(wakeChannelOf(undefined, () => true), "cli");
	assert.equal(wakeChannelOf("imessage" as never, () => false), "cli");
});
