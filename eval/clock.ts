// Preload for eval processes: shifts the wall clock by MOCHI_EVAL_SKEW_MS so a scenario runs at its own owner-local time.
// Timers and performance.now are untouched; only Date moves.
const skew = Number(process.env.MOCHI_EVAL_SKEW_MS ?? 0);

if (skew !== 0) {
	const RealDate = Date;
	class ShiftedDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(RealDate.now() + skew);
			else super(...(args as [string]));
		}
		static override now(): number {
			return RealDate.now() + skew;
		}
	}
	globalThis.Date = ShiftedDate as DateConstructor;
}
