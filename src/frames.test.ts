import { describe, expect, it } from 'vitest';
import {
	FRAME_MAX,
	FRAME_QUALITY_MAX,
	FRAME_QUALITY_MIN,
	frameCount,
	frameName,
	planFrames,
	tooManyFrames,
	type FrameRequest
} from './frames';

const req = (over: Partial<FrameRequest> = {}): FrameRequest => ({
	format: 'jpg',
	rate: 1,
	everyFrame: false,
	quality: 4,
	...over
});

describe('frameCount', () => {
	it('counts what the rate asks for, including the frame at zero', () => {
		expect(frameCount(req({ rate: 1 }), 10, 30)).toBe(11);
		expect(frameCount(req({ rate: 2 }), 10, 30)).toBe(21);
		expect(frameCount(req({ rate: 0.5 }), 60, 30)).toBe(31);
	});

	it('uses the clipimes own frame rate when every frame is asked for', () => {
		expect(frameCount(req({ everyFrame: true }), 10, 30)).toBe(301);
		expect(frameCount(req({ everyFrame: true }), 10, 60)).toBe(601);
	});

	it('falls back to a sane rate when the source will not say', () => {
		// A probe that could not read the frame rate must not make the count
		// come out as zero, which would read as "this will produce nothing".
		expect(frameCount(req({ everyFrame: true }), 10, null)).toBe(251);
	});

	it('is zero when there is no clip to count', () => {
		expect(frameCount(req(), null, 30)).toBe(0);
		expect(frameCount(req(), 0, 30)).toBe(0);
		expect(frameCount(req({ rate: 0 }), 10, 30)).toBe(0);
	});
});

describe('tooManyFrames', () => {
	it('draws the line where a browser stops coping', () => {
		expect(tooManyFrames(FRAME_MAX)).toBe(false);
		expect(tooManyFrames(FRAME_MAX + 1)).toBe(true);
		// The case the cap exists for: every frame of a two minute 60fps clip.
		expect(tooManyFrames(frameCount(req({ everyFrame: true }), 120, 60))).toBe(true);
	});
});

describe('planFrames', () => {
	it('writes a numbered pattern wide enough to sort as text', () => {
		const plan = planFrames(req(), 'input');
		expect(plan.pattern).toBe('frame_%05d.jpg');
		expect(plan.args).toContain('frame_%05d.jpg');
		expect(plan.args.slice(0, 2)).toEqual(['-i', 'input']);
	});

	it('puts the rate in an fps filter, and leaves it out for every frame', () => {
		expect(planFrames(req({ rate: 2 }), 'input').args.join(' ')).toContain('-vf fps=2');
		const all = planFrames(req({ everyFrame: true }), 'input');
		expect(all.args.join(' ')).not.toContain('fps=');
		expect(all.args.join(' ')).not.toContain('-vf');
	});

	it('never varies the frame rate on top of the filter', () => {
		// vsync/fps_mode would make the count depend on the source's own
		// timing, and the panel has already promised a number.
		const args = planFrames(req(), 'input').args.join(' ');
		expect(args).not.toContain('-vsync');
		expect(args).not.toContain('-fps_mode');
	});

	it('only asks for quality where quality means something', () => {
		expect(planFrames(req({ format: 'jpg' }), 'input').args).toContain('-q:v');
		expect(planFrames(req({ format: 'png' }), 'input').args).not.toContain('-q:v');
		expect(planFrames(req({ format: 'png' }), 'input').pattern).toBe('frame_%05d.png');
	});

	it('writes JPG with the standard tables, because the optimal ones crash the core', () => {
		// Measured, not guessed: an iPhone HEVC clip and an H.264 clip both
		// failed to give a single JPG with ffmpeg's default of optimal tables.
		const plan = planFrames(req({ format: 'jpg' }), 'input');
		const at = plan.args.indexOf('-huffman');
		expect(plan.args.slice(at, at + 2)).toEqual(['-huffman', 'default']);
		// An output option, so it has to come before the file it applies to.
		expect(at).toBeLessThan(plan.args.indexOf(plan.pattern));
		expect(planFrames(req({ format: 'png' }), 'input').args).not.toContain('-huffman');
	});

	it('clamps quality into the scale ffmpeg actually accepts', () => {
		const q = (quality: number) => {
			const args = planFrames(req({ quality }), 'input').args;
			return Number(args[args.indexOf('-q:v') + 1]);
		};
		expect(q(0)).toBe(FRAME_QUALITY_MIN);
		expect(q(99)).toBe(FRAME_QUALITY_MAX);
		expect(q(7)).toBe(7);
	});

	it('drops the audio, because a still has none', () => {
		expect(planFrames(req(), 'input').args).toContain('-an');
	});
});

describe('frameName', () => {
	it('numbers from one and pads, so a file manager sorts them', () => {
		expect(frameName('holiday', 0, '.jpg')).toBe('holiday-0001.jpg');
		expect(frameName('holiday', 9, '.jpg')).toBe('holiday-0010.jpg');
		expect(frameName('holiday', 999, '.png')).toBe('holiday-1000.png');
	});
});
