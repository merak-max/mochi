import { Worker } from "node:worker_threads";

/** pi-durable's image limit: a larger photo is only shrunk again before the model sees it. */
const MAX_SIDE = 2000;

/** An iPhone HEIC photo as an upright JPEG that fits MAX_SIDE, decoded in a worker that exits after it. */
export async function heicToJpeg(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
	const worker = new Worker(new URL("./heic-worker.ts", import.meta.url), { workerData: { bytes, maxSide: MAX_SIDE } });
	const stop = (): void => void worker.terminate();
	signal?.addEventListener("abort", stop);
	try {
		return await new Promise<Uint8Array>((resolve, reject) => {
			worker.once("message", resolve);
			worker.once("error", reject);
			worker.once("exit", (code) => reject(new Error(`HEIC decoder exited with code ${code}.`)));
		});
	} finally {
		signal?.removeEventListener("abort", stop);
		await worker.terminate();
	}
}
