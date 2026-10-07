/** A boundary's readiness. `off`: not configured, which is fine. `broken`: configured but unusable; `fix` is one line. */
export type Setup<T> =
	| { readonly kind: "ready"; readonly value: T }
	| { readonly kind: "off" }
	| { readonly kind: "broken"; readonly fix: string };

export const ready = <T>(value: T): Setup<T> => ({ kind: "ready", value });
export const off: Setup<never> = { kind: "off" };
export const broken = (fix: string): Setup<never> => ({ kind: "broken", fix });

/** One line per boundary, in order. A `broken` entry never stops the daemon; the feature it names is off. */
export function setupReport(entries: readonly (readonly [name: string, setup: Setup<unknown>])[]): readonly string[] {
	return entries.map(([name, setup]) =>
		setup.kind === "ready" ? `ok   ${name}` : setup.kind === "off" ? `off  ${name} (not configured)` : `fix  ${name}: ${setup.fix}`,
	);
}
