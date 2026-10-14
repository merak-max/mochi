type SecretMatch = { readonly kind: "pattern"; readonly id: string } | { readonly kind: "env"; readonly name: string };

export type Env = Readonly<Record<string, string | undefined>>;

const PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
	{ id: "anthropic api key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
	{ id: "api key (sk-)", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
	{ id: "aws access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	{ id: "github token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/ },
	{ id: "github fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
	{ id: "slack token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/ },
	{ id: "google api key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
	{ id: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
	{ id: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
	// Longer than a SHA-1 (40), so git SHAs pass.
	{ id: "long hex string", pattern: /\b[0-9a-fA-F]{48,}\b/ },
];

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;
const MIN_ENV_VALUE_CHARS = 8;
const TOKEN_RUN = /[A-Za-z0-9_+=-]{32,}/g;
const MIN_TOKEN_ENTROPY_BITS = 4.2;

/** The first credential-looking thing in `text`. Never returns the matched value. */
export function findSecret(text: string, env: Env): SecretMatch | undefined {
	for (const { id, pattern } of PATTERNS) if (pattern.test(text)) return { kind: "pattern", id };
	for (const run of text.match(TOKEN_RUN) ?? []) {
		// Mixed case and digits with near-uniform characters: random tokens, not words, paths or slugs.
		if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !/[0-9]/.test(run)) continue;
		if (entropyBits(run) >= MIN_TOKEN_ENTROPY_BITS) return { kind: "pattern", id: "high-entropy token" };
	}
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && value.length >= MIN_ENV_VALUE_CHARS && SECRET_ENV_NAME.test(name) && text.includes(value)) {
			return { kind: "env", name };
		}
	}
	return undefined;
}

export function secretRejection(match: SecretMatch): string {
	const what = match.kind === "env" ? `the value of the environment variable ${match.name}` : `a credential (${match.id})`;
	const example = match.kind === "env" ? `"the key is in env ${match.name}"` : `"the speech key is in env SPEECH_API_KEY"`;
	return `Not saved: the note contains ${what}. Notes must never hold secrets. Store a reference instead, such as ${example}.`;
}

function entropyBits(text: string): number {
	const counts = new Map<string, number>();
	for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / text.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}
