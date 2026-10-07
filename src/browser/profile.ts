const owners = new Map<string, Promise<void>>();
const TTL_MS = 600_000;

export async function acquireProfile(key: string, signal?: AbortSignal): Promise<ProfileLease> {
	const previous = owners.get(key) ?? Promise.resolve();
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const tail = previous.then(() => held);
	owners.set(key, tail);
	const abandon = () => {
		release();
		void tail.then(() => { if (owners.get(key) === tail) owners.delete(key); });
	};
	let abort: (() => void) | undefined;
	try {
		signal?.throwIfAborted();
		await (signal === undefined ? previous : Promise.race([
			previous,
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
			}),
		]));
		signal?.throwIfAborted();
	} catch (error) {
		abandon();
		throw error;
	} finally {
		if (abort !== undefined) signal?.removeEventListener("abort", abort);
	}
	return new ProfileLease(abandon);
}

export class ProfileLease {
	readonly #release: () => void;

	constructor(release: () => void) {
		this.#release = release;
	}

	async stop(stop: () => Promise<unknown>): Promise<void> {
		try {
			await stop();
			this.#release();
		} catch (error) {
			const timer = setTimeout(this.#release, TTL_MS);
			timer.unref();
			throw error;
		}
	}

	keepOpen(stop: () => Promise<unknown>): void {
		const timer = setTimeout(() => { void this.stop(stop).catch(() => {}); }, 290_000);
		timer.unref();
	}

	uncertain(): void {
		const timer = setTimeout(this.#release, TTL_MS);
		timer.unref();
	}
}
