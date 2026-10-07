import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export function parseWith<const T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	if (Value.Check(schema, value)) return value;
	const details = Value.Errors(schema, value)
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"} ${error.message}`)
		.join("; ");
	throw new Error(`Invalid ${what}: ${details}`);
}
