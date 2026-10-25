import assert from "node:assert/strict";
import { test } from "node:test";
import { cafOpusToOgg } from "./caf.ts";

function varint(value: number): number[] {
	const out = [value & 0x7f];
	for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) out.unshift((rest & 0x7f) | 0x80);
	return out;
}

function chunk(type: string, body: Uint8Array): Buffer {
	const head = Buffer.alloc(12);
	head.write(type, 0, "latin1");
	head.writeBigInt64BE(BigInt(body.length), 4);
	return Buffer.concat([head, body]);
}

/** A CAF file as Apple's spec lays it out: Opus at `rate`, variable packet sizes in the packet table. */
function opusCaf(packets: Uint8Array[], rate: number, framesPerPacket: number, priming: number): Buffer {
	const desc = Buffer.alloc(32);
	desc.writeDoubleBE(rate, 0);
	desc.write("opus", 8, "latin1");
	desc.writeUInt32BE(framesPerPacket, 20);
	desc.writeUInt32BE(1, 24);
	const head = Buffer.alloc(24);
	head.writeBigInt64BE(BigInt(packets.length), 0);
	head.writeInt32BE(priming, 16);
	const sizes: number[] = [];
	for (const packet of packets) sizes.push(...varint(packet.length));
	const pakt = Buffer.concat([head, Buffer.from(sizes)]);
	return Buffer.concat([Buffer.from("caff\0\x01\0\0", "latin1"), chunk("desc", desc), chunk("pakt", pakt), chunk("data", Buffer.concat([Buffer.alloc(4), ...packets]))]);
}

function crc(bytes: Uint8Array): number {
	let value = 0;
	for (const byte of bytes) {
		value ^= byte << 24;
		for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
		value >>>= 0;
	}
	return value;
}

type Page = { flags: number; granule: bigint; packets: Uint8Array[] };

function readOgg(ogg: Uint8Array): Page[] {
	const pages: Page[] = [];
	const view = new DataView(ogg.buffer, ogg.byteOffset, ogg.byteLength);
	let offset = 0;
	while (offset < ogg.length) {
		assert.equal(String.fromCharCode(...ogg.subarray(offset, offset + 4)), "OggS");
		const segments = ogg[offset + 26]!;
		const lacing = ogg.subarray(offset + 27, offset + 27 + segments);
		let length = 27 + segments;
		for (const size of lacing) length += size;
		const page = Uint8Array.from(ogg.subarray(offset, offset + length));
		const stored = view.getUint32(offset + 22, true);
		page.fill(0, 22, 26);
		assert.equal(crc(page), stored, "page CRC");
		const packets: Uint8Array[] = [];
		let body = offset + 27 + segments;
		let start = body;
		for (const size of lacing) {
			body += size;
			if (size < 255) {
				packets.push(ogg.subarray(start, body));
				start = body;
			}
		}
		pages.push({ flags: ogg[offset + 5]!, granule: view.getBigInt64(offset + 6, true), packets });
		offset += length;
	}
	return pages;
}

test("an Opus CAF becomes an Ogg Opus file with the same packets", () => {
	const packets: Uint8Array[] = [];
	for (let k = 0; k < 300; k++) packets.push(Uint8Array.from({ length: [3, 255, 510, 700][k % 4]! }, (_, i) => (i + k) % 256));
	const pages = readOgg(cafOpusToOgg(opusCaf(packets, 24000, 480, 156)));
	assert.equal(pages[0]!.flags, 2, "the first page starts the stream");
	assert.equal(pages.at(-1)!.flags, 4, "the last page ends it");
	const head = pages[0]!.packets[0]!;
	assert.equal(Buffer.from(head.subarray(0, 8)).toString(), "OpusHead");
	assert.equal(new DataView(head.buffer, head.byteOffset).getUint16(10, true), 312, "pre-skip in 48 kHz samples");
	assert.equal(Buffer.from(pages[1]!.packets[0]!.subarray(0, 8)).toString(), "OpusTags");
	const audio = pages.slice(2).flatMap((page) => page.packets);
	assert.deepEqual(audio.map((packet) => Buffer.from(packet)), packets.map((packet) => Buffer.from(packet)));
	assert.ok(pages.length > 3, "packets spill over more than one page");
	assert.equal(pages.at(-1)!.granule, BigInt(300 * 960), "granule counts 48 kHz samples");
});

test("a CAF of another codec throws", () => {
	const caf = opusCaf([Uint8Array.of(1)], 44100, 1024, 0);
	caf.write("aac ", 8 + 12 + 8, "latin1");
	assert.throws(() => cafOpusToOgg(caf), /'aac ' is not Opus/);
});
