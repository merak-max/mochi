// An iMessage voice note is Opus packets in a CAF container, which no transcription API takes. This moves the same
// packets into an Ogg Opus file (RFC 7845) without decoding them. CAF layout: Apple's Core Audio Format Specification.

type Description = { sampleRate: number; formatId: string; bytesPerPacket: number; framesPerPacket: number; channels: number };
type Packets = { sizes: number[]; frames: number[]; priming: number };

function readVarint(bytes: Uint8Array, at: { offset: number }): number {
	let value = 0;
	for (;;) {
		const byte = bytes[at.offset++]!;
		value = value * 128 + (byte & 0x7f);
		if ((byte & 0x80) === 0) return value;
	}
}

/** The CAF chunks this needs: the stream description, the packet table and the audio data. */
function readCaf(bytes: Uint8Array): { description: Description; packets: Packets; data: Uint8Array } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (text(0) !== "caff") throw new Error("Not a CAF file.");
	let description: Description | undefined;
	let table: Uint8Array | undefined;
	let data: Uint8Array | undefined;
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const type = text(offset);
		const declared = Number(view.getBigInt64(offset + 4, false));
		const start = offset + 12;
		const end = declared === -1 ? bytes.length : start + declared;
		if (type === "desc") {
			description = {
				sampleRate: view.getFloat64(start, false),
				formatId: text(start + 8),
				bytesPerPacket: view.getUint32(start + 16, false),
				framesPerPacket: view.getUint32(start + 20, false),
				channels: view.getUint32(start + 24, false),
			};
		}
		if (type === "pakt") table = bytes.subarray(start, end);
		if (type === "data") data = bytes.subarray(start + 4, end);
		offset = end;
	}
	if (description === undefined || data === undefined) throw new Error("CAF file has no desc or data chunk.");
	const packets: Packets = { sizes: [], frames: [], priming: 0 };
	if (table === undefined) {
		if (description.bytesPerPacket === 0) throw new Error("CAF file with variable packets has no packet table.");
		const count = Math.floor(data.length / description.bytesPerPacket);
		for (let k = 0; k < count; k++) {
			packets.sizes.push(description.bytesPerPacket);
			packets.frames.push(description.framesPerPacket);
		}
		return { description, packets, data };
	}
	const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
	const count = Number(tableView.getBigInt64(0, false));
	packets.priming = tableView.getInt32(16, false);
	const at = { offset: 24 };
	for (let k = 0; k < count; k++) {
		packets.sizes.push(description.bytesPerPacket === 0 ? readVarint(table, at) : description.bytesPerPacket);
		packets.frames.push(description.framesPerPacket === 0 ? readVarint(table, at) : description.framesPerPacket);
	}
	return { description, packets, data };
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let crc = n << 24;
	for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
	CRC_TABLE[n] = crc >>> 0;
}

function oggCrc(bytes: Uint8Array): number {
	let crc = 0;
	for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
	return crc;
}

/** One Ogg page holding whole packets. flags: 2 starts the stream, 4 ends it. */
function oggPage(packets: Uint8Array[], granule: bigint, sequence: number, flags: number): Uint8Array {
	const lacing: number[] = [];
	for (const packet of packets) {
		let left = packet.length;
		while (left >= 255) {
			lacing.push(255);
			left -= 255;
		}
		lacing.push(left);
	}
	let bodyLength = 0;
	for (const packet of packets) bodyLength += packet.length;
	const page = new Uint8Array(27 + lacing.length + bodyLength);
	const view = new DataView(page.buffer);
	page.set([0x4f, 0x67, 0x67, 0x53], 0);
	page[5] = flags;
	view.setBigInt64(6, granule, true);
	view.setUint32(14, 1, true);
	view.setUint32(18, sequence, true);
	page[26] = lacing.length;
	page.set(lacing, 27);
	let offset = 27 + lacing.length;
	for (const packet of packets) {
		page.set(packet, offset);
		offset += packet.length;
	}
	view.setUint32(22, oggCrc(page), true);
	return page;
}

/** A CAF file of Opus packets as an Ogg Opus file with the same packets. Any other codec throws. */
export function cafOpusToOgg(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const { description, packets, data } = readCaf(bytes);
	if (description.formatId !== "opus") throw new Error(`CAF codec '${description.formatId}' is not Opus.`);
	const toGranule = 48000 / description.sampleRate;
	const head = new Uint8Array(19);
	const headView = new DataView(head.buffer);
	head.set(new TextEncoder().encode("OpusHead"), 0);
	head[8] = 1;
	head[9] = description.channels;
	headView.setUint16(10, Math.round(packets.priming * toGranule), true);
	headView.setUint32(12, description.sampleRate, true);
	const vendor = new TextEncoder().encode("mochi");
	const tags = new Uint8Array(8 + 4 + vendor.length + 4);
	tags.set(new TextEncoder().encode("OpusTags"), 0);
	new DataView(tags.buffer).setUint32(8, vendor.length, true);
	tags.set(vendor, 12);
	const pages = [oggPage([head], 0n, 0, 2), oggPage([tags], 0n, 1, 0)];
	let granule = 0n;
	let offset = 0;
	let batch: Uint8Array[] = [];
	let segments = 0;
	for (let k = 0; k < packets.sizes.length; k++) {
		const size = packets.sizes[k]!;
		const needed = Math.floor(size / 255) + 1;
		if (segments + needed > 255) {
			pages.push(oggPage(batch, granule, pages.length, 0));
			batch = [];
			segments = 0;
		}
		batch.push(data.subarray(offset, offset + size));
		offset += size;
		segments += needed;
		granule += BigInt(Math.round(packets.frames[k]! * toGranule));
	}
	pages.push(oggPage(batch, granule, pages.length, 4));
	let total = 0;
	for (const page of pages) total += page.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const page of pages) {
		out.set(page, at);
		at += page.length;
	}
	return out;
}
