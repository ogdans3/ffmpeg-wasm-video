import { describe, expect, it } from 'vitest';
import { readColourTag, tagInMoov, type ReadBytes } from './colourtag';

/** Bytes, from numbers and four character codes. */
function bytes(...parts: (number[] | string | Uint8Array)[]): Uint8Array {
	const chunks = parts.map((part) =>
		typeof part === 'string' ? new TextEncoder().encode(part) : part instanceof Uint8Array ? part : Uint8Array.from(part)
	);
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];

function box(type: string, ...content: (number[] | string | Uint8Array)[]): Uint8Array {
	const body = bytes(...content);
	return bytes(be32(body.length + 8), type, body);
}

/** A visual sample entry: its 78 bytes of fields, then its own boxes. */
const entry = (codec: string, ...inner: Uint8Array[]) => box(codec, new Uint8Array(78), ...inner);

/** What Chrome's MediaRecorder writes: version 0, laid out like version 1. */
const chromeVpcc = (primaries: number, transfer: number, matrix: number, version = 0) =>
	box('vpcC', [version, 0, 0, 0, 0, 0, 0x80, primaries, transfer, matrix, 0, 0]);

const nclx = (primaries: number, transfer: number, matrix: number) =>
	box('colr', 'nclx', be16(primaries), be16(transfer), be16(matrix), [0]);

function trak(handler: string, sampleEntry: Uint8Array, quicktime = false): Uint8Array {
	const stsd = box('stsd', [0, 0, 0, 0], be32(1), sampleEntry);
	return box(
		'trak',
		box('tkhd', new Uint8Array(84)),
		box(
			'mdia',
			box('mdhd', new Uint8Array(24)),
			box('hdlr', [0, 0, 0, 0], quicktime ? 'mhlr' : [0, 0, 0, 0], handler, new Uint8Array(12)),
			box('minf', box('stbl', stsd, box('stts', new Uint8Array(8))))
		)
	);
}

const moov = (...traks: Uint8Array[]) => box('moov', box('mvhd', new Uint8Array(100)), ...traks);
const ftyp = box('ftyp', 'isom', be32(512), 'isomiso2');

/** A reader over bytes in memory, counting what it was asked for. */
function reader(file: Uint8Array): { read: ReadBytes; asked: number[] } {
	const asked: number[] = [];
	return {
		asked,
		read: async (offset, length) => {
			asked.push(length);
			return file.slice(offset, offset + length);
		}
	};
}

const tagOf = (file: Uint8Array) => readColourTag(reader(file).read, file.length);

describe('readColourTag', () => {
	it('reads the BT.601 that Chrome puts in a VP9 recording’s vpcC', async () => {
		const file = bytes(ftyp, moov(trak('vide', entry('vp09', chromeVpcc(6, 6, 6)))), box('mdat', new Uint8Array(64)));
		expect(await tagOf(file)).toEqual({ matrix: 6, primaries: 6, transfer: 6 });
	});

	it('reads version 1 of the box too, which ffmpeg does but its VP9 decoder then overrides', async () => {
		const file = bytes(ftyp, moov(trak('vide', entry('vp09', chromeVpcc(1, 1, 1, 1)))));
		expect(await tagOf(file)).toEqual({ matrix: 1, primaries: 1, transfer: 1 });
	});

	it('skips the old ten byte version 0 layout, whose colour field means something else', async () => {
		const old = box('vpcC', [0, 0, 0, 0, 0, 0, 0x80, 0x10, 0, 0]);
		expect(await tagOf(bytes(ftyp, moov(trak('vide', entry('vp09', old)))))).toBeNull();
	});

	it('reads a colr box, and prefers it to vpcC', async () => {
		const file = bytes(ftyp, moov(trak('vide', entry('av01', nclx(9, 16, 9)))));
		expect(await tagOf(file)).toEqual({ matrix: 9, primaries: 9, transfer: 16 });
		const both = bytes(ftyp, moov(trak('vide', entry('vp09', chromeVpcc(6, 6, 6), nclx(1, 1, 1)))));
		expect(await tagOf(both)).toEqual({ matrix: 1, primaries: 1, transfer: 1 });
	});

	it('reads QuickTime’s nclc and a MOV’s handler', async () => {
		const nclc = box('colr', 'nclc', be16(1), be16(1), be16(1));
		const file = bytes(box('ftyp', 'qt  ', be32(0), 'qt  '), moov(trak('vide', entry('avc1', nclc), true)));
		expect(await tagOf(file)).toEqual({ matrix: 1, primaries: 1, transfer: 1 });
	});

	it('finds the moov after the media data without loading the media data', async () => {
		const mdat = box('mdat', new Uint8Array(200_000));
		const file = bytes(ftyp, mdat, moov(trak('vide', entry('vp09', chromeVpcc(6, 6, 6)))));
		const { read, asked } = reader(file);
		expect(await readColourTag(read, file.length)).toEqual({ matrix: 6, primaries: 6, transfer: 6 });
		expect(Math.max(...asked)).toBeLessThan(2000);
	});

	it('follows a 64 bit box size', async () => {
		const payload = new Uint8Array(40);
		const large = bytes(be32(1), 'mdat', be32(0), be32(16 + payload.length), payload);
		const file = bytes(ftyp, large, moov(trak('vide', entry('vp09', chromeVpcc(6, 6, 6)))));
		expect(await tagOf(file)).toEqual({ matrix: 6, primaries: 6, transfer: 6 });
	});

	it('looks at the video track, not the sound', async () => {
		const sound = trak('soun', box('mp4a', new Uint8Array(28)));
		const file = bytes(ftyp, moov(sound, trak('vide', entry('vp09', chromeVpcc(1, 1, 1)))));
		expect(await tagOf(file)).toEqual({ matrix: 1, primaries: 1, transfer: 1 });
	});

	it('says nothing when nothing is declared', async () => {
		expect(await tagOf(bytes(ftyp, moov(trak('vide', entry('avc1', box('avcC', [1, 100, 0, 31]))))))).toBeNull();
		// unspecified is not a tag
		expect(await tagOf(bytes(ftyp, moov(trak('vide', entry('vp09', chromeVpcc(2, 2, 2))))))).toBeNull();
		expect(await tagOf(bytes(ftyp, moov(trak('soun', box('mp4a', new Uint8Array(28))))))).toBeNull();
	});

	it('gives up at once on a file that is not an MP4 or a MOV', async () => {
		const webm = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01], new Uint8Array(100));
		const { read, asked } = reader(webm);
		expect(await readColourTag(read, webm.length)).toBeNull();
		expect(asked).toHaveLength(1);
		const avi = bytes('RIFF', [0x10, 0, 0, 0], 'AVI LIST', new Uint8Array(100));
		expect(await tagOf(avi)).toBeNull();
	});

	it('survives a file cut short or a box that claims too much', async () => {
		const whole = bytes(ftyp, moov(trak('vide', entry('vp09', chromeVpcc(6, 6, 6)))));
		for (const cut of [4, 12, ftyp.length + 6, whole.length - 5]) {
			await expect(tagOf(whole.slice(0, cut))).resolves.toBeNull();
		}
		expect(tagInMoov(bytes(be32(9999), 'trak', new Uint8Array(20)))).toBeNull();
	});
});
