import assert from "node:assert/strict";
import { test } from "node:test";
import { findSecret, secretRejection } from "./secrets.ts";

const credentials: Record<string, string> = {
	"anthropic api key": "key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
	"api key (sk-)": "sk-proj-abcdefghijklmnopqrstuvwx",
	"aws access key": "AKIAIOSFODNN7EXAMPLE",
	"github token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
	"github fine-grained token": "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
	"slack token": "xoxb-1234567890-abcdefghij",
	"google api key": "AIzaSyA1234567890abcdefghijklmnopqrstuv",
	"bearer token": "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123",
	"private key block": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==",
	jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
	"long hex string": "a3f1".repeat(16),
	"high-entropy token": "token Zq8vR2mXk9LpT4wYc7NbH3sFj6Ud1GaE0oQi5",
};

for (const [id, text] of Object.entries(credentials)) {
	test(`rejects ${id}`, () => {
		assert.deepEqual(findSecret(text, {}), { kind: "pattern", id });
	});
}

test("rejects the value of a secret-named env var without echoing it", () => {
	const env = { DEEPGRAM_API_KEY: "dg-plain-words-value", HOME: "/home/ec2-user" };
	const match = findSecret("my key is dg-plain-words-value", env);
	assert.deepEqual(match, { kind: "env", name: "DEEPGRAM_API_KEY" });
	const message = secretRejection(match!);
	assert.match(message, /DEEPGRAM_API_KEY/);
	assert.doesNotMatch(message, /dg-plain-words-value/);
	assert.equal(findSecret("lives in /home/ec2-user", env), undefined, "a non-secret env name is ignored");
});

test("passes git SHAs, UUIDs, ids, paths and prose", () => {
	for (const text of [
		"Fixed in commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39",
		"Order id 123e4567-e89b-12d3-a456-426614174000",
		"Telegram message id 01J9ZK3M4N5P6Q7R8S9T0V1W2X",
		"The repo is at /home/ec2-user/Developer/mochi/src/notes/secrets.ts",
		"Owner prefers short answers and never wants markdown tables on WhatsApp.",
		"deepgram key is in env DEEPGRAM_API_KEY",
	]) {
		assert.equal(findSecret(text, { DEEPGRAM_API_KEY: "dg-plain-words-value" }), undefined, text);
	}
});
