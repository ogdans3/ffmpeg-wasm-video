/**
 * The colour tag an MP4 or MOV declares for its picture, read out of the file
 * itself, for the cases where ffmpeg loses it.
 *
 * ffmpeg's VP9 decoder replaces the container's matrix with the one in the
 * VP9 bitstream, and a recording from Chrome's MediaRecorder leaves that one
 * blank and says BT.601 in the MP4's `vpcC` box instead. It also writes that
 * box as version 0 laid out like version 1, which ffmpeg 5.1 skips outright.
 * So ffmpeg calls the recording untagged while every browser reads the box:
 * measured in Chrome 154, the same untagged VP9 played as BT.601 with the box
 * saying BT.601 and as BT.709 with the box saying BT.709.
 *
 * Only the phone frame needs this. It writes painted colours into the video
 * and has to write them the way a player will read the recording back, and
 * say so in the output's own tag when the decoder threw the original away.
 *
 * Pure apart from `read`, which the caller backs with `Blob.slice`, so only
 * the box headers on the way to the `moov` and the `moov` itself are loaded,
 * wherever in the file it is. Matroska is not read: its Colour element
 * reaches ffmpeg for VP8, and Chrome's WebM recordings carry none.
 */

/** Colour codes as ITU-T H.273 numbers them, which MP4 and ffmpeg share. */
export interface ColourTag {
	matrix: number;
	primaries: number;
	transfer: number;
}

/** Bytes from `offset`, up to `length` of them, fewer at the end of the file. */
export type ReadBytes = (offset: number, length: number) => Promise<Uint8Array>;

/** H.273's "unspecified" and "reserved", which say nothing. */
const UNSPECIFIED = new Set([2, 3]);
/** A moov bigger than this is not worth loading to learn one tag. */
const MOOV_MAX = 64 * 1024 * 1024;
/** Top level boxes to walk past before giving up on finding the moov. */
const TOP_LEVEL_MAX = 256;
/** A visual sample entry's own fields, before the boxes inside it start. */
const VISUAL_ENTRY_FIELDS = 78;

interface Box {
	type: string;
	/** Where the box's contents start and end, past its header. */
	start: number;
	end: number;
}

function u16(buf: Uint8Array, at: number): number {
	return (buf[at] << 8) | buf[at + 1];
}

function u32(buf: Uint8Array, at: number): number {
	return ((buf[at] << 24) >>> 0) + ((buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]);
}

function fourcc(buf: Uint8Array, at: number): string {
	return String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
}

/** A box type is four printable characters. Anything else is not an MP4. */
function isType(type: string): boolean {
	return /^[\x20-\x7e]{4}$/.test(type);
}

/** The boxes laid end to end between `from` and `to`, stopping at a bad one. */
function* boxes(buf: Uint8Array, from: number, to: number): Generator<Box> {
	let at = from;
	while (at + 8 <= to) {
		let size = u32(buf, at);
		const type = fourcc(buf, at + 4);
		let header = 8;
		if (size === 1) {
			if (at + 16 > to) return;
			size = u32(buf, at + 8) * 2 ** 32 + u32(buf, at + 12);
			header = 16;
		} else if (size === 0) {
			size = to - at;
		}
		if (!isType(type) || size < header || at + size > to) return;
		yield { type, start: at + header, end: at + size };
		at += size;
	}
}

function child(buf: Uint8Array, parent: Box, type: string): Box | undefined {
	for (const box of boxes(buf, parent.start, parent.end)) if (box.type === type) return box;
	return undefined;
}

function tag(matrix: number, primaries: number, transfer: number): ColourTag | null {
	return UNSPECIFIED.has(matrix) ? null : { matrix, primaries, transfer };
}

/**
 * The tag in a video sample entry's own boxes. `colr` is the standard place
 * and wins when both are there. `vpcC` is VP9's, and is read by its length
 * rather than its version number, since Chrome writes version 0 with version
 * 1's twelve bytes and the older version 0 layout is only ten.
 */
function tagInEntry(buf: Uint8Array, from: number, to: number): ColourTag | null {
	let vp: ColourTag | null = null;
	for (const box of boxes(buf, from, to)) {
		const length = box.end - box.start;
		if (box.type === 'colr' && length >= 10) {
			const kind = fourcc(buf, box.start);
			// nclx is ISO's, nclc QuickTime's: primaries, transfer, matrix
			if (kind === 'nclx' || kind === 'nclc') {
				return tag(u16(buf, box.start + 8), u16(buf, box.start + 4), u16(buf, box.start + 6));
			}
		}
		if (box.type === 'vpcC' && length >= 12 && buf[box.start] <= 1) {
			// version and flags, profile, level, bit depth and range, then the three
			vp = tag(buf[box.start + 9], buf[box.start + 7], buf[box.start + 8]);
		}
	}
	return vp;
}

/** The first video track's tag, from the bytes inside a `moov` box. */
export function tagInMoov(moov: Uint8Array): ColourTag | null {
	const whole: Box = { type: 'moov', start: 0, end: moov.length };
	for (const trak of boxes(moov, whole.start, whole.end)) {
		if (trak.type !== 'trak') continue;
		const mdia = child(moov, trak, 'mdia');
		const hdlr = mdia && child(moov, mdia, 'hdlr');
		// version and flags, then four bytes that are zero in an MP4 and "mhlr"
		// in a MOV, then the handler type, which is "vide" in both
		if (!mdia || !hdlr || hdlr.end - hdlr.start < 12 || fourcc(moov, hdlr.start + 8) !== 'vide') continue;
		const minf = child(moov, mdia, 'minf');
		const stbl = minf && child(moov, minf, 'stbl');
		const stsd = stbl && child(moov, stbl, 'stsd');
		if (!stsd) return null;
		// version and flags, the entry count, then the first sample entry
		const entry = boxes(moov, stsd.start + 8, stsd.end).next().value;
		if (!entry) return null;
		return tagInEntry(moov, entry.start + VISUAL_ENTRY_FIELDS, entry.end);
	}
	return null;
}

/**
 * The declared tag of an MP4 or MOV of `size` bytes, or null when it declares
 * none, or is not an MP4 or MOV at all, which is found out from its first
 * eight bytes.
 */
export async function readColourTag(read: ReadBytes, size: number): Promise<ColourTag | null> {
	let at = 0;
	for (let count = 0; count < TOP_LEVEL_MAX && at + 8 <= size; count++) {
		const head = await read(at, 16);
		if (head.length < 8) return null;
		const type = fourcc(head, 4);
		if (!isType(type)) return null;
		let boxSize = u32(head, 0);
		let header = 8;
		if (boxSize === 1) {
			if (head.length < 16) return null;
			boxSize = u32(head, 8) * 2 ** 32 + u32(head, 12);
			header = 16;
		} else if (boxSize === 0) {
			boxSize = size - at;
		}
		if (boxSize < header) return null;
		if (type === 'moov') {
			const length = Math.min(boxSize, size - at) - header;
			if (length > MOOV_MAX) return null;
			return tagInMoov(await read(at + header, length));
		}
		at += boxSize;
	}
	return null;
}

/** `readColourTag` for a file the browser holds. */
export function readFileColourTag(file: Blob): Promise<ColourTag | null> {
	return readColourTag(
		async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
		file.size
	);
}
