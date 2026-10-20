import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@earendil-works/chord";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { FastCompletion } from "../turn/lifecycle.ts";
import { clipBytes, LINE_BYTES, merge, turnLine } from "./memory.ts";
import { redact } from "./redact.ts";

const context = {} as Context;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function scripted(answers: readonly string[]): { fast: FastCompletion; prompts: string[]; systems: string[] } {
	const prompts: string[] = [];
	const systems: string[] = [];
	const fast: FastCompletion = async ({ system, prompt }) => {
		systems.push(system);
		prompts.push(prompt);
		return answers[Math.min(prompts.length - 1, answers.length - 1)]!;
	};
	return { fast, prompts, systems };
}

test("merge names the byte limit and a ruler in the prompt", async () => {
	const { fast, systems } = scripted(["short"]);
	await merge(fast, "#0 a\n#1 b", context);
	assert.match(systems[0]!, /512 bytes \(about 70 words\)/);
	assert.ok(systems[0]!.includes("-".repeat(LINE_BYTES)));
	assert.match(systems[0]!, /Invent nothing; keep names, dates, numbers, ids, decisions, promises, what was sent or submitted/);
});

test("merge asks again after a line too long and keeps the short one", async () => {
	const { fast, prompts } = scripted(["word ".repeat(200), "a short line"]);
	const line = await merge(fast, "input", context);
	assert.equal(line, "a short line");
	assert.equal(prompts.length, 2);
	assert.match(prompts[1]!, /^input\n\nToo long: your last line was 999 bytes, over the 512-byte limit/);
	assert.match(prompts[1]!, /\| ← LIMIT$/);
});

test("merge stops after three tries and clips the shortest to 512 bytes", async () => {
	const { fast, prompts } = scripted(["é".repeat(400), "é".repeat(300), "é".repeat(350)]);
	const line = await merge(fast, "input", context);
	assert.equal(prompts.length, 3);
	assert.ok(bytes(line) <= LINE_BYTES);
	assert.equal(line, "é".repeat(256));
});

test("clipBytes cuts on a UTF-8 boundary", () => {
	assert.equal(clipBytes("ab", 512), "ab");
	assert.equal(clipBytes("aé", 2), "a");
	assert.equal(clipBytes("a😀b", 4), "a");
	assert.equal(clipBytes("a😀b", 5), "a😀");
});

let nextId = 1;
const entry = (kind: string, message: unknown): EntryRecord => ({ id: nextId++, kind, model: [message] }) as unknown as EntryRecord;

test("turnLine keeps tool calls and result heads", () => {
	const code = `const page = await tools.web_fetch({ url: "https://example.com" });\nawait tools.note({ line: "x" });\nawait tools.note({ line: "y" });\nreturn page;`;
	const line = turnLine([
		entry("pi.user", { role: "user", content: "Check example.com and send me the title", timestamp: 0 }),
		entry("pi.assistant", {
			role: "assistant",
			content: [
				{ type: "text", text: "Looking." },
				{ type: "toolCall", id: "c1", name: "codemode", arguments: { code } },
				{ type: "toolCall", id: "c2", name: "notify", arguments: { text: "x".repeat(300), to: "owner" } },
			],
			timestamp: 0,
		}),
		entry("pi.tool-result", { role: "toolResult", toolCallId: "c1", toolName: "codemode", content: [{ type: "text", text: "Example Domain ".repeat(20) }], isError: false, timestamp: 0 }),
		entry("pi.tool-result", { role: "toolResult", toolCallId: "c2", toolName: "notify", content: [{ type: "text", text: "Channel down" }], isError: true, timestamp: 0 }),
		entry("pi.assistant", { role: "assistant", content: [{ type: "text", text: "The title is Example Domain." }], timestamp: 0 }),
	])!;
	const parts = line.split(" | ");
	assert.equal(parts[0], "owner: Check example.com and send me the title");
	assert.equal(parts[1], "mochi: Looking.");
	assert.match(parts[2]!, /^tool codemode\(const page = await tools\.web_fetch.*…\) calls tools\.web_fetch\( tools\.note\($/);
	assert.match(parts[3]!, /^tool notify\(text=x{115}…\)$/);
	assert.match(parts[4]!, /^codemode result: (Example Domain ){10}Example Do…$/);
	assert.equal(parts[5], "notify error: Channel down");
	assert.equal(parts[6], "mochi: The title is Example Domain.");
});

const masked: Array<[string, string, string]> = [
	["bearer header", 'curl -H "Authorization: Bearer abcDEF123456789xyz" https://api.example.com', 'curl -H "Authorization: Bearer [secret]" https://api.example.com'],
	["authorization in JSON", '{"Authorization":"Basic dXNlcjpwYXNz"}', '{"Authorization":"Basic [secret]"}'],
	["bare bearer", "send Bearer abcdefghijklmnop0123 now", "send Bearer [secret] now"],
	["env assignment", "export OPENAI_API_KEY=plainvalue", "export OPENAI_API_KEY=[secret]"],
	["JSON password", '{"password": "hunter two", "user": "bob"}', '{"password": "[secret]", "user": "bob"}'],
	["quoted token", "token='abc'", "token='[secret]'"],
	["client_secret query", "https://x.com/cb?code=1&client_secret=abc&x=2", "https://x.com/cb?code=1&client_secret=[secret]&x=2"],
	["auth key", "auth: hunter2", "auth: [secret]"],
	["cookie", "cookie: sid=xyz", "cookie: [secret]"],
	["session", "session=abc123", "session=[secret]"],
	["password flag", "mysql --password hunter2 -u root", "mysql --password [secret] -u root"],
	["sk-", "key sk-proj-abcdefghijklmnop1234 end", "key [secret] end"],
	["sk-ant-", "sk-ant-api03-abcdefghijklmnop", "[secret]"],
	["ghp_", "ghp_abcdefghijklmnopqrstuvwxyz0123", "[secret]"],
	["gho_", "gho_abcdefghijklmnopqrstuvwxyz0123", "[secret]"],
	["github_pat_", "github_pat_11ABCDEFG0abcdefghijklmn", "[secret]"],
	["slack", "xoxb-1234567890-abcdef and xoxp-1234567890-abcdef", "[secret] and [secret]"],
	["AWS key id", "AKIAIOSFODNN7EXAMPLE", "[secret]"],
	["Google API key", "AIzaSyA1234567890abcdefghijklmnopqrstu", "[secret]"],
	["Google OAuth", "ya29.a0AfH6SMBabcdefghijklmnop", "[secret]"],
	["GitLab", "glpat-abcdefghij0123456789", "[secret]"],
	["npm", "npm_abcdefghijklmnopqrstuvwxyz0123456789", "[secret]"],
	["JWT", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_abc-1 ok", "jwt [secret] ok"],
	["hex run", "digest 0123456789abcdef0123456789abcdef01234567", "digest [secret]"],
	["base64 run", "b64 Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpL==", "b64 [secret]"],
	["URL userinfo", "git clone https://bob:pa55word@github.com/x/y.git", "git clone https://[secret]@github.com/x/y.git"],
];

for (const [name, input, expected] of masked) {
	test(`redact masks ${name}`, () => {
		assert.equal(redact(input), expected);
	});
}

test("redact leaves ordinary text alone", () => {
	const plain = [
		"read /home/ec2-user/Developer/mochi/node_modules/@earendil-works/pi-ai/dist/types.d.ts",
		"acc_01JABCDEFGHJKMNPQRSTVWXYZ0 id 123e4567-e89b-12d3-a456-426614174000",
		"spc-msg-01JAB2CDEFGH3JKMNPQRSTVW4XYZ",
		"https://github.com/0oAstro/austroporean-cards/blob/main/README.md",
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"https://drive.google.com/file/d/1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV/view",
		"author=Shaurya auth=true apiKey: process.env.KEY Authorization: $TOKEN",
		"getElementByIdAndSomethingVeryLongName2 UPPER_CASE_CONSTANT_NAME_FOR_THE_APP_V2",
		"IMG_20241019_123456_HDR_Portrait_Mode1 Shaurya_Pratap_Singh_Resume_2024_Final_v3",
		"The tokenizer counts 512 bytes; the password manager is 1Password.",
	];
	for (const text of plain) assert.equal(redact(text), text);
});

test("turnLine masks a secret before it clips, so no half secret is left", () => {
	const command = `${"x".repeat(95)} sk-ant-api03-abcdefghijklmnopqrstuvwxyz`;
	const line = turnLine([
		entry("pi.user", { role: "user", content: "Call the API", timestamp: 0 }),
		entry("pi.assistant", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command } }], timestamp: 0 }),
		entry("pi.tool-result", { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "token: ghp_abcdefghijklmnopqrstuvwxyz0123" }], isError: false, timestamp: 0 }),
	])!;
	assert.ok(!line.includes("abcdefghijklmnop"), line);
	assert.match(line, /tool bash\(command=x{95} \[secret\]\)/);
	assert.match(line, /bash result: token: \[secret\]$/);
});
