import { describe, expect, it } from 'vitest';
import { VIDEO_FORMATS } from './formats';
import {
	copyArgs,
	encodeArgs,
	fitFilter,
	inputName,
	joinLooksComplete,
	LIST_FILE,
	listFileContents,
	looksCopyable,
	outputSize,
	totalDuration
} from './merge';
import type { ProbeResult } from './plan';

const mp4 = VIDEO_FORMATS.mp4;
const webm = VIDEO_FORMATS.webm;

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
	videoCodec: 'h264',
	audioCodec: 'aac',
	durationSeconds: 10,
	width: 1280,
	height: 720,
	fps: 25,
	...over
});

const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

describe('the concat list', () => {
	it('names every input in order', () => {
		expect(listFileContents(3)).toBe("file 'merge-0'\nfile 'merge-1'\nfile 'merge-2'\n");
	});

	it('ends with a newline, which the demuxer needs on the last entry', () => {
		expect(listFileContents(2).endsWith('\n')).toBe(true);
	});

	it('agrees with the names the caller writes the files under', () => {
		expect(listFileContents(2)).toContain(inputName(0));
		expect(listFileContents(2)).toContain(inputName(1));
	});
});

describe('copyArgs', () => {
	it('reads the list and copies both streams', () => {
		const args = copyArgs('out.mp4');
		expect(args.join(' ')).toContain(`-f concat -safe 0 -i ${LIST_FILE}`);
		expect(args.join(' ')).toContain('-c copy');
	});

	it('needs -safe 0, or the demuxer refuses the plain names', () => {
		expect(copyArgs('out.mp4')).toContain('-safe');
	});
});

describe('outputSize', () => {
	it('lets the first clip decide, so reordering is the control', () => {
		expect(outputSize([probe({ width: 640, height: 480 }), probe()])).toEqual({
			width: 640,
			height: 480
		});
	});

	it('rounds to even numbers, since H.264 refuses odd ones', () => {
		expect(outputSize([probe({ width: 1081, height: 607 })])).toEqual({
			width: 1080,
			height: 606
		});
	});

	it('skips a clip whose size could not be read rather than using zero', () => {
		const unknown = probe({ width: null, height: null });
		expect(outputSize([unknown, probe({ width: 1920, height: 1080 })])).toEqual({
			width: 1920,
			height: 1080
		});
	});

	it('falls back to 720p when nothing reported a size at all', () => {
		expect(outputSize([probe({ width: null, height: null })])).toEqual({
			width: 1280,
			height: 720
		});
	});
});

describe('fitFilter', () => {
	it('letterboxes rather than stretching, so a vertical clip keeps its shape', () => {
		const filter = fitFilter(1280, 720);
		expect(filter).toContain('force_original_aspect_ratio=decrease');
		expect(filter).toContain('pad=1280:720');
	});

	it('sets the sample aspect ratio, which concat refuses to guess at', () => {
		expect(fitFilter(1280, 720)).toContain('setsar=1');
	});
});

describe('encodeArgs', () => {
	it('fits every clip to the frame and joins them in order', () => {
		const graph = graphOf(encodeArgs([probe(), probe()], mp4, 'out.mp4').args);
		expect(graph).toContain('[0:v]scale=1280:720');
		expect(graph).toContain('[1:v]scale=1280:720');
		expect(graph).toContain('concat=n=2:v=1:a=1[v][a]');
	});

	it('interleaves the streams per segment, which is the order concat wants', () => {
		const graph = graphOf(encodeArgs([probe(), probe()], mp4, 'out.mp4').args);
		expect(graph).toContain('[v0][a0][v1][a1]concat=');
	});

	it('drops audio entirely when not one clip has any', () => {
		const silent = probe({ audioCodec: null });
		const plan = encodeArgs([silent, silent], mp4, 'out.mp4');
		expect(graphOf(plan.args)).toContain('concat=n=2:v=1:a=0[v]');
		expect(plan.args).toContain('-an');
		expect(plan.silenceAdded).toBe(false);
	});

	it('gives a silent clip a generated track rather than muting the others', () => {
		// The usual version of this is a silent title card in front of a clip
		// somebody wants to hear. Dropping all the sound would be the easy
		// answer and would lose the thing they came for.
		const plan = encodeArgs([probe({ audioCodec: null }), probe()], mp4, 'out.mp4');
		expect(plan.silenceAdded).toBe(true);
		expect(plan.args.join(' ')).toContain('anullsrc=channel_layout=stereo:sample_rate=44100');
		expect(graphOf(plan.args)).toContain('concat=n=2:v=1:a=1[v][a]');
	});

	it('cuts the generated silence to that clip so the join does not drift', () => {
		const plan = encodeArgs(
			[probe({ audioCodec: null, durationSeconds: 4.5 }), probe()],
			mp4,
			'out.mp4'
		);
		const t = plan.args.indexOf('-t');
		expect(plan.args[t + 1]).toBe('4.500');
	});

	it('points the silent segment at the generated input, not at a track that is not there', () => {
		const graph = graphOf(encodeArgs([probe({ audioCodec: null }), probe()], mp4, 'out.mp4').args);
		// two real inputs, so the generated one is index 2
		expect(graph).toContain('[2:a]aformat');
		expect(graph).toContain('[1:a]aformat');
		expect(graph).not.toContain('[0:a]');
	});

	it('resamples every segment, since real files disagree about rate and layout', () => {
		const graph = graphOf(encodeArgs([probe(), probe()], mp4, 'out.mp4').args);
		expect(graph).toContain('aformat=sample_rates=44100:channel_layouts=stereo');
	});

	it('uses the measured VP8 settings when the target is WebM', () => {
		const args = encodeArgs([probe(), probe()], webm, 'out.webm').args;
		expect(args.join(' ')).toContain('-deadline realtime -cpu-used 8');
	});

	it('never claims the frames survived a re-encode', () => {
		expect(encodeArgs([probe(), probe()], mp4, 'out.mp4').framesIntact).toBe(false);
	});
});

describe('looksCopyable', () => {
	it('is true when the clips agree about everything a probe can see', () => {
		expect(looksCopyable([probe(), probe()], mp4)).toBe(true);
	});

	it('is false as soon as one of them differs', () => {
		expect(looksCopyable([probe(), probe({ width: 1920 })], mp4)).toBe(false);
		expect(looksCopyable([probe(), probe({ videoCodec: 'hevc' })], mp4)).toBe(false);
		expect(looksCopyable([probe(), probe({ audioCodec: null })], mp4)).toBe(false);
	});

	it('is false when the container will not hold what the clips contain', () => {
		expect(looksCopyable([probe(), probe()], webm)).toBe(false);
	});

	it('needs at least two clips to be a join at all', () => {
		expect(looksCopyable([probe()], mp4)).toBe(false);
	});
});

describe('totalDuration', () => {
	it('adds the clips up', () => {
		expect(totalDuration([probe({ durationSeconds: 3 }), probe({ durationSeconds: 4.5 })])).toBe(
			7.5
		);
	});

	it('is null rather than wrong when one clip did not report a length', () => {
		expect(totalDuration([probe(), probe({ durationSeconds: null })])).toBeNull();
	});
});

describe('joinLooksComplete', () => {
	const clips = [probe({ durationSeconds: 3 }), probe({ durationSeconds: 3 })];
	const out = (over: Partial<ProbeResult> = {}) => probe({ durationSeconds: 6, ...over });

	it('accepts a join that is as long as the clips that went into it', () => {
		expect(joinLooksComplete(out(), clips)).toBe(true);
	});

	it('allows for container overhead and keyframe rounding', () => {
		expect(joinLooksComplete(out({ durationSeconds: 6.02 }), clips)).toBe(true);
		expect(joinLooksComplete(out({ durationSeconds: 5.6 }), clips)).toBe(true);
	});

	it('rejects the truncation an MP4 plus a WebM produces', () => {
		// The concat demuxer exits zero and writes only the first clip. Three
		// seconds out of six is not a near miss.
		expect(joinLooksComplete(out({ durationSeconds: 3 }), clips)).toBe(false);
	});

	it('rejects a join that lost the sound, which comes out the right length', () => {
		// A silent clip first means the output has no audio track and every
		// other clip's sound is dropped. Verified in a browser, where the
		// joined file decoded zero audio bytes.
		const mixed = [probe({ durationSeconds: 3, audioCodec: null }), probe({ durationSeconds: 3 })];
		expect(joinLooksComplete(out({ audioCodec: null }), mixed)).toBe(false);
	});

	it('does not demand sound that never went in', () => {
		const silent = [
			probe({ durationSeconds: 3, audioCodec: null }),
			probe({ durationSeconds: 3, audioCodec: null })
		];
		expect(joinLooksComplete(out({ audioCodec: null }), silent)).toBe(true);
	});

	it('rejects a join it cannot measure, rather than trusting it', () => {
		expect(joinLooksComplete(null, clips)).toBe(false);
		expect(joinLooksComplete(out({ durationSeconds: null }), clips)).toBe(false);
		expect(joinLooksComplete(out(), [probe(), probe({ durationSeconds: null })])).toBe(false);
	});

	it('scales the tolerance with length, so a long join is not judged on 0.5s', () => {
		const long = [probe({ durationSeconds: 600 }), probe({ durationSeconds: 600 })];
		expect(joinLooksComplete(out({ durationSeconds: 1215 }), long)).toBe(true);
		expect(joinLooksComplete(out({ durationSeconds: 900 }), long)).toBe(false);
	});
});
