import { describe, expect, it } from 'vitest';
import { looksReadable, parseProbe } from './probe';
import { canCopy } from './plan';
import { VIDEO_FORMATS } from './formats';

/** Copied verbatim out of ffmpeg.wasm in a browser, not written by hand. */
const MP4 = [
	`Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input':`,
	'  Duration: 00:00:05.00, start: 0.000000, bitrate: 2762 kb/s',
	'  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 2682 kb/s, 30 fps, 30 tbr, 15360 tbn (default)',
	'  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)',
	'At least one output file must be specified'
];

const WEBM = [
	`Input #0, matroska,webm, from 'input':`,
	'  Duration: 00:01:23.45, start: 0.000000, bitrate: 812 kb/s',
	'  Stream #0:0: Video: vp8, yuv420p(progressive), 1920x1080, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 1k tbn',
	'  Stream #0:1: Audio: vorbis, 48000 Hz, stereo, fltp'
];

const SILENT_MOV = [
	`Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input':`,
	'  Duration: 00:00:12.34, start: 0.000000, bitrate: 9000 kb/s',
	'  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuvj420p(pc), 3840x2160, 8900 kb/s, 30 fps'
];

describe('parseProbe', () => {
	it('reads the colour tags the phone frame has to match', () => {
		// Stream lines copied out of the site's own ffmpeg core (5.1.4).
		const line = (pixels: string) => [
			`  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), ${pixels}, 460x1000 [SAR 1:1 DAR 23:50], 12 kb/s, 30 fps, 30 tbr, 15360 tbn (default)`
		];
		expect(parseProbe(line('yuv420p(tv, bt709, progressive)'))).toMatchObject({ colourMatrix: 'bt709', fullRange: false });
		expect(parseProbe(line('yuvj420p(pc, bt709, progressive)'))).toMatchObject({ colourMatrix: 'bt709', fullRange: true });
		expect(parseProbe(line('yuv420p(tv, smpte170m, progressive)'))).toMatchObject({ colourMatrix: 'smpte170m' });
		expect(parseProbe(line('yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67)'))).toMatchObject({
			colourMatrix: 'bt2020nc',
			colourPrimaries: 'bt2020',
			colourTransfer: 'arib-std-b67'
		});
		// one name is all three
		expect(parseProbe(line('yuv420p(tv, bt709, progressive)'))).toMatchObject({
			colourPrimaries: 'bt709',
			colourTransfer: 'bt709'
		});
		// Chrome's own H.264 recordings, full range and sRGB transfer
		expect(parseProbe(line('yuvj420p(pc, bt709/bt709/iec61966-2-1, progressive)'))).toMatchObject({
			colourMatrix: 'bt709',
			colourPrimaries: 'bt709',
			colourTransfer: 'iec61966-2-1',
			fullRange: true
		});
		// a VP9 in an MP4 whose box says BT.709: the decoder wiped the matrix only
		expect(parseProbe(line('yuv420p(tv, unknown/bt709/bt709, progressive)'))).toMatchObject({
			colourMatrix: null,
			colourPrimaries: 'bt709',
			colourTransfer: 'bt709'
		});
		// untagged, and tagged as unknown, are the same thing
		expect(parseProbe(line('yuv420p(progressive)'))).toMatchObject({
			colourMatrix: null,
			colourPrimaries: null,
			colourTransfer: null,
			fullRange: false
		});
		expect(parseProbe(line('yuv420p(tv, unknown/bt709/unknown, progressive)')).colourMatrix).toBeNull();
		expect(parseProbe(MP4)).toMatchObject({ colourMatrix: null, fullRange: false });
		expect(parseProbe(WEBM)).toMatchObject({ colourMatrix: null, fullRange: false });
		// a yuvj format is full range even when the parentheses don't say so
		expect(parseProbe(SILENT_MOV)).toMatchObject({ colourMatrix: null, fullRange: true });
		expect(
			parseProbe(['  Stream #0:0: Video: vp8, yuv420p(tv, bt470bg/unknown/unknown, progressive), 500x1040, SAR 1:1 DAR 25:52, 30 fps'])
		).toMatchObject({ colourMatrix: 'bt470bg', fullRange: false });
	});

	it('reads an MP4 the way ffmpeg actually prints it', () => {
		const probe = parseProbe(MP4);
		expect(probe.videoCodec).toBe('h264');
		expect(probe.audioCodec).toBe('aac');
		expect(probe.durationSeconds).toBe(5);
		expect(probe.width).toBe(1280);
		expect(probe.height).toBe(720);
	});

	it('is not fooled by the codec profile in brackets', () => {
		// "h264 (High)" must not become "h264 (high)" or "high"
		expect(parseProbe(MP4).videoCodec).toBe('h264');
		expect(parseProbe(SILENT_MOV).videoCodec).toBe('hevc');
	});

	it('handles minutes and a fractional second in the duration', () => {
		expect(parseProbe(WEBM).durationSeconds).toBeCloseTo(83.45, 2);
	});

	it('reads a stream with no audio without inventing one', () => {
		const probe = parseProbe(SILENT_MOV);
		expect(probe.audioCodec).toBeNull();
		expect(probe.width).toBe(3840);
		expect(probe.height).toBe(2160);
	});

	it('takes the first stream when a file has several', () => {
		const probe = parseProbe([
			...MP4,
			'  Stream #0:2: Video: mjpeg, yuvj420p, 320x240, 90k tbr' // cover art
		]);
		expect(probe.videoCodec).toBe('h264');
		expect(probe.width).toBe(1280);
	});

	it('returns nothing at all for output that is not a media file', () => {
		const probe = parseProbe(['input: Invalid data found when processing input']);
		expect(probe.videoCodec).toBeNull();
		expect(probe.audioCodec).toBeNull();
		expect(probe.durationSeconds).toBeNull();
		expect(looksReadable(probe)).toBe(false);
	});

	it('feeds the copy decision correctly, which is the point of all this', () => {
		// an MP4 of H.264 goes into MOV and MKV untouched, but never into WebM
		const mp4 = parseProbe(MP4);
		expect(canCopy(VIDEO_FORMATS.mov, mp4)).toBe(true);
		expect(canCopy(VIDEO_FORMATS.mkv, mp4)).toBe(true);
		expect(canCopy(VIDEO_FORMATS.webm, mp4)).toBe(false);
		// and a WebM of VP8 goes into MKV untouched but never into MP4
		const webm = parseProbe(WEBM);
		expect(canCopy(VIDEO_FORMATS.mkv, webm)).toBe(true);
		expect(canCopy(VIDEO_FORMATS.mp4, webm)).toBe(false);
	});

	it('knows a file it could read from one it could not', () => {
		expect(looksReadable(parseProbe(MP4))).toBe(true);
		expect(looksReadable(parseProbe(SILENT_MOV))).toBe(true);
		expect(looksReadable(parseProbe([]))).toBe(false);
	});
});
