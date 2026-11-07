import type { ProbeResult } from './plan';

/**
 * Reading what is inside a video out of ffmpeg's own chatter.
 *
 * There is no ffprobe in the WebAssembly build, so the way to learn what a
 * file contains is to hand it to ffmpeg with no output file and read what it
 * complains about. It exits with an error every time, which is expected: the
 * error is "no output specified" and the useful part came first.
 *
 * Pure on purpose. Deciding whether a conversion can copy streams instead of
 * re-encoding rests entirely on getting the codec names right, and that is a
 * decision worth testing against real ffmpeg output rather than hoping.
 */

const DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const VIDEO_STREAM = /Stream #\d+:\d+.*?:\s*Video:\s*([a-z0-9_]+)/i;
const AUDIO_STREAM = /Stream #\d+:\d+.*?:\s*Audio:\s*([a-z0-9_]+)/i;
/** Dimensions appear after the pixel format, e.g. "yuv420p, 1280x720 [SAR..." */
const SIZE = /,\s*(\d{2,5})x(\d{2,5})\b/;
/**
 * The frame rate, e.g. ", 29.97 fps,". ffmpeg also prints tbr, tbn and tbc on
 * the same line, which are timebases rather than frame rates and are wrong
 * here often enough to matter, so only "fps" is read.
 */
const FPS = /,\s*(\d+(?:\.\d+)?)\s*fps\b/;
/**
 * The pixel format and what ffmpeg says about its colours, just before the
 * size: "yuv420p(tv, bt709, progressive), 920x2000" or "yuvj420p(pc), ...".
 * The colours are one name when matrix, primaries and transfer agree, and
 * three with slashes when they don't, matrix first.
 */
const PIXELS = /,\s*([a-z][a-z0-9]*)(?:\(([^)]*)\))?,\s*\d{2,5}x\d{2,5}\b/;
/** The matrix names ffmpeg prints, so a field order is never taken for one. */
const MATRICES = new Set([
	'gbr',
	'bt709',
	'unknown',
	'reserved',
	'fcc',
	'bt470bg',
	'smpte170m',
	'smpte240m',
	'ycgco',
	'bt2020nc',
	'bt2020c',
	'smpte2085',
	'chroma-derived-nc',
	'chroma-derived-c',
	'ictcp'
]);

/** A colour name that says nothing, which is the same as no name at all. */
function named(name: string | undefined): string | null {
	return !name || name === 'unknown' || name === 'reserved' ? null : name;
}

type Colour = Pick<ProbeResult, 'colourMatrix' | 'colourPrimaries' | 'colourTransfer' | 'fullRange'>;

/**
 * The colour half of a video stream line. Untagged comes back as null. One
 * name stands for all three, and "matrix/primaries/transfer" is how ffmpeg
 * prints them when they differ.
 */
function readColour(line: string): Colour {
	const pixels = PIXELS.exec(line);
	if (!pixels) return { colourMatrix: null, colourPrimaries: null, colourTransfer: null, fullRange: false };
	const details = (pixels[2] ?? '').split(',').map((part) => part.trim());
	const colours = details.find((part) => MATRICES.has(part.split('/')[0]))?.split('/') ?? [];
	const [matrix, primaries = matrix, transfer = matrix] = colours;
	return {
		colourMatrix: named(matrix),
		colourPrimaries: named(primaries),
		colourTransfer: named(transfer),
		fullRange: details.includes('pc') || pixels[1].startsWith('yuvj')
	};
}

export function parseProbe(lines: string[]): ProbeResult {
	const result: ProbeResult = {
		videoCodec: null,
		audioCodec: null,
		durationSeconds: null,
		width: null,
		height: null,
		fps: null,
		colourMatrix: null,
		colourPrimaries: null,
		colourTransfer: null,
		fullRange: false
	};

	for (const line of lines) {
		const duration = DURATION.exec(line);
		if (duration && result.durationSeconds === null) {
			result.durationSeconds =
				Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
		}

		const video = VIDEO_STREAM.exec(line);
		if (video && !result.videoCodec) {
			result.videoCodec = video[1].toLowerCase();
			const size = SIZE.exec(line);
			if (size) {
				result.width = Number(size[1]);
				result.height = Number(size[2]);
			}
			const fps = FPS.exec(line);
			if (fps) result.fps = Number(fps[1]);
			Object.assign(result, readColour(line));
		}

		const audio = AUDIO_STREAM.exec(line);
		if (audio && !result.audioCodec) result.audioCodec = audio[1].toLowerCase();
	}

	return result;
}

/** A duration of zero is not a duration, it is a file we could not read. */
export function looksReadable(probe: ProbeResult): boolean {
	return probe.videoCodec !== null || probe.audioCodec !== null;
}
