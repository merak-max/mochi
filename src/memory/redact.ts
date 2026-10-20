const MASK = "[secret]";

const SECRET_KEY = String.raw`[\w.-]*(?:token|secret|password|passwd|api[_-]?key|auth(?!or)|cookie|session)[\w.-]*`;

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const AUTHORIZATION = /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest)\s+)?([^\s"',;}]+)/gi;
const BEARER = /\b(bearer)\s+([A-Za-z0-9._~+/-]{16,}=*)/gi;
const KNOWN_PREFIX =
	/(?<![\w-])(?:sk-ant-[\w-]{10,}|sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|ya29\.[\w.-]{20,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{30,})/g;
const JWT = /\beyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]*/g;
const KEY_VALUE = new RegExp(`(?<![\\w.-])(${SECRET_KEY})(["']?\\s*[:=]\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s"',;&})\\]]+))`, "gi");
const FLAG_VALUE = /(?<![\w-])(--?[\w-]*(?:token|secret|password|passwd|api[_-]?key)[\w-]*)\s+(?!-)(\S+)/gi;
const HEX_RUN = /(?<![\w+/.-])[0-9a-fA-F]{32,}(?![\w+/.-])/g;
const BASE64_RUN = /(?<![\w+/.-])[A-Za-z0-9+/_-]{32,}={0,2}(?![\w+/.-])/g;
const ID_PREFIX = /^[a-z]{2,}(?:[-_][a-z]{2,})*[-_]/;

function isReference(value: string): boolean {
	if (value === "" || value.startsWith("[secret")) return true;
	if (/^(?:true|false|null|undefined)$/i.test(value)) return true;
	if (/^\$\{?\w+\}?$/.test(value)) return true;
	return /^process\.env\.\w+$/.test(value);
}

function looksRandom(token: string): boolean {
	if (token.startsWith("/")) return false;
	const run = token.replace(ID_PREFIX, "").replace(/=+$/, "");
	if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !/[0-9]/.test(run)) return false;
	const pieces = run.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g) ?? [];
	const letters = pieces.join("").length;
	return letters / pieces.length < 3.5;
}

/** `text` with credentials replaced by [secret]: auth headers, secret-named values, known token shapes and random runs. */
export function redact(text: string): string {
	let out = text.replace(URL_USERINFO, `$1${MASK}@`);
	out = out.replace(AUTHORIZATION, (match, head: string, scheme: string | undefined, value: string) => {
		if (isReference(value)) return match;
		return scheme === undefined ? `${head}${MASK}` : `${head}${scheme} ${MASK}`;
	});
	out = out.replace(BEARER, `$1 ${MASK}`);
	out = out.replace(KNOWN_PREFIX, MASK);
	out = out.replace(JWT, MASK);
	out = out.replace(KEY_VALUE, (match, key: string, separator: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
		const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
		if (isReference(value) || /^(?:bearer|basic|token|digest)$/i.test(value)) return match;
		if (doubleQuoted !== undefined) return `${key}${separator}"${MASK}"`;
		if (singleQuoted !== undefined) return `${key}${separator}'${MASK}'`;
		return `${key}${separator}${MASK}`;
	});
	out = out.replace(FLAG_VALUE, (match, flag: string, value: string) => (isReference(value) ? match : `${flag} ${MASK}`));
	out = out.replace(HEX_RUN, MASK);
	out = out.replace(BASE64_RUN, (run) => (looksRandom(run) ? MASK : run));
	return out;
}
