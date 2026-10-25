// An iMessage voice note is Opus packets in a CAF container. No transcription API takes CAF, and no speech API writes it.
// These move the same packets between CAF and Ogg Opus (RFC 7845) without decoding them. CAF layout: Apple's Core Audio
// Format Specification.

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
	return concat(pages);
}

/** The packets of an Ogg stream, a packet that spans pages joined, and the stream's channel count and pre-skip. */
function readOggOpus(ogg: Uint8Array): { packets: Uint8Array[]; channels: number; preSkip: number } {
	const packets: Uint8Array[] = [];
	let partial: Uint8Array[] = [];
	let offset = 0;
	while (offset + 27 <= ogg.length) {
		if (String.fromCharCode(...ogg.subarray(offset, offset + 4)) !== "OggS") throw new Error("Not an Ogg file.");
		const segments = ogg[offset + 26]!;
		let body = offset + 27 + segments;
		for (let k = 0; k < segments; k++) {
			const size = ogg[offset + 27 + k]!;
			partial.push(ogg.subarray(body, body + size));
			body += size;
			if (size < 255) {
				packets.push(concat(partial));
				partial = [];
			}
		}
		offset = body;
	}
	const head = packets[0];
	if (head === undefined || String.fromCharCode(...head.subarray(0, 8)) !== "OpusHead") throw new Error("Ogg stream is not Opus.");
	return { packets: packets.slice(2), channels: head[9]!, preSkip: new DataView(head.buffer, head.byteOffset).getUint16(10, true) };
}

/** A packet's length in 48 kHz samples, from its TOC byte (RFC 6716, section 3.1). */
function opusSamples(packet: Uint8Array): number {
	const toc = packet[0]!;
	const config = toc >> 3;
	let tenths: number;
	if (config < 12) tenths = [100, 200, 400, 600][config % 4]!;
	else if (config < 16) tenths = [100, 200][config % 2]!;
	else tenths = [25, 50, 100, 200][config % 4]!;
	const code = toc & 3;
	let frames = 1;
	if (code === 1 || code === 2) frames = 2;
	if (code === 3) frames = packet[1]! & 0x3f;
	return (tenths * 48 * frames) / 10;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function writeVarint(value: number, out: number[]): void {
	const bytes = [value & 0x7f];
	for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7f) | 0x80);
	out.push(...bytes);
}

function cafChunk(type: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
	const head = new Uint8Array(12);
	for (let k = 0; k < 4; k++) head[k] = type.charCodeAt(k);
	new DataView(head.buffer).setBigInt64(4, BigInt(body.length), false);
	return concat([head, body]);
}

/** An Ogg Opus file as a CAF file with the same packets, the format of an iMessage voice note. */
export function oggOpusToCaf(ogg: Uint8Array): Uint8Array<ArrayBuffer> {
	const { packets, channels, preSkip } = readOggOpus(ogg);
	const frames: number[] = [];
	let total = 0;
	for (const packet of packets) {
		const samples = opusSamples(packet);
		frames.push(samples);
		total += samples;
	}
	let constant = frames.length > 0 ? frames[0]! : 0;
	for (const samples of frames) if (samples !== constant) constant = 0;
	const desc = new Uint8Array(32);
	const descView = new DataView(desc.buffer);
	descView.setFloat64(0, 48000, false);
	for (let k = 0; k < 4; k++) desc[8 + k] = "opus".charCodeAt(k);
	descView.setUint32(20, constant, false);
	descView.setUint32(24, channels, false);
	const table: number[] = [];
	for (let k = 0; k < packets.length; k++) {
		writeVarint(packets[k]!.length, table);
		if (constant === 0) writeVarint(frames[k]!, table);
	}
	const paktHead = new Uint8Array(24);
	const paktView = new DataView(paktHead.buffer);
	paktView.setBigInt64(0, BigInt(packets.length), false);
	paktView.setBigInt64(8, BigInt(Math.max(total - preSkip, 0)), false);
	paktView.setInt32(16, preSkip, false);
	const fileHead = Uint8Array.of(0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0);
	return concat([
		fileHead,
		cafChunk("desc", desc),
		cafChunk("pakt", concat([paktHead, Uint8Array.from(table)])),
		cafChunk("data", concat([new Uint8Array(4), ...packets])),
	]);
}
