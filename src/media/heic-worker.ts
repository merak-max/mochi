// One HEIC photo to JPEG, in a worker of its own: libheif's WebAssembly memory grows to hundreds of MB and never shrinks,
// so it lives only as long as this thread.
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import decode from "heic-decode";

const photon = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as typeof import("@silvia-odwyer/photon-node");

const { bytes, maxSide } = workerData as { bytes: Uint8Array; maxSide: number };
const { width, height, data } = await decode({ buffer: bytes });
let image = new photon.PhotonImage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width, height);
const scale = Math.min(1, maxSide / width, maxSide / height);
if (scale < 1) {
	const resized = photon.resize(image, Math.round(width * scale), Math.round(height * scale), photon.SamplingFilter.Triangle);
	image.free();
	image = resized;
}
parentPort!.postMessage(image.get_bytes_jpeg(85));
image.free();
