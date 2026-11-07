import { describe, expect, it } from 'vitest';
import {
	canCopy,
	canCopyAudio,
	canCopyVideo,
	estimateSeconds,
	fallbackPlan,
	planConversion,
	type ProbeResult
} from './plan';
import { VIDEO_FORMATS } from './formats';

const h264: ProbeResult = {
	videoCodec: 'h264',
	audioCodec: 'aac',
	durationSeconds: 60,
	width: 1280,
	height: 720,
	fps: 25
};
const vp8: ProbeResult = { ...h264, videoCodec: 'vp8', audioCodec: 'vorbis' };
const prores: ProbeResult = { ...h264, videoCodec: 'prores', audioCodec: 'pcm_s16le' };
const silent: ProbeResult = { ...h264, audioCodec: null };

describe('canCopy', () => {
	it('says yes when the container already accepts what is inside', () => {
		// this is the iPhone case and the whole reason the fast path exists
		expect(canCopy(VIDEO_FORMATS.mp4, h264)).toBe(true);
		expect(canCopy(VIDEO_FORMATS.mov, h264)).toBe(true);
		expect(canCopy(VIDEO_FORMATS.mkv, h264)).toBe(true);
		expect(canCopy(VIDEO_FORMATS.mkv, vp8)).toBe(true);
	});

	it('says no when the container would refuse the codec', () => {
		expect(canCopy(VIDEO_FORMATS.webm, h264)).toBe(false); // WebM takes no H.264
		expect(canCopy(VIDEO_FORMATS.mp4, prores)).toBe(false); // ProRes is a MOV thing
	});

	it('is not put off by a file with no audio', () => {
		expect(canCopy(VIDEO_FORMATS.mp4, silent)).toBe(true);
	});

	it('refuses when only the audio is the problem', () => {
		expect(canCopy(VIDEO_FORMATS.mp4, { ...h264, audioCodec: 'vorbis' })).toBe(false);
	});

	it('never copies into a GIF or an audio file, since both throw a stream away', () => {
		expect(canCopy(VIDEO_FORMATS.gif, h264)).toBe(false);
		expect(canCopy(VIDEO_FORMATS.mp3, h264)).toBe(false);
	});
});

describe('planConversion', () => {
	it('copies streams when it can, which is the difference between 60ms and 9s', () => {
		const plan = planConversion(VIDEO_FORMATS.mp4, h264, 'out.mp4');
		expect(plan.copy).toBe('full');
		expect(plan.framesIntact).toBe(true);
		expect(plan.args).toEqual(['-i', 'input', '-c', 'copy', '-y', 'out.mp4']);
		expect(plan.expectation).toBe('instant');
	});

	it('re-encodes into WebM, because WebM cannot hold H.264', () => {
		const plan = planConversion(VIDEO_FORMATS.webm, h264, 'out.webm');
		expect(plan.copy).toBe('none');
		expect(plan.framesIntact).toBe(false);
		expect(plan.expectation).toBe('slow');
		expect(plan.args).toContain('libvpx');
		// measured: eight times faster than the default for the same size
		expect(plan.args).toContain('realtime');
		expect(plan.args.join(' ')).toContain('-cpu-used 8');
	});

	it('never reaches for VP9, which crashed the tab every time', () => {
		for (const target of Object.values(VIDEO_FORMATS)) {
			const plan = planConversion(target, h264, 'out');
			expect(plan.args, target.id).not.toContain('libvpx-vp9');
		}
	});

	it('encodes H.264 at veryfast, not ultrafast', () => {
		// ultrafast was three times quicker and produced a file bigger than the
		// source, which is the one outcome a converter must not have
		const plan = planConversion(VIDEO_FORMATS.mp4, vp8, 'out.mp4');
		expect(plan.args.join(' ')).toContain('-preset veryfast');
		expect(plan.args).toContain('yuv420p');
	});

	it('builds a palette for GIFs rather than accepting the default colours', () => {
		const plan = planConversion(VIDEO_FORMATS.gif, h264, 'out.gif', { gifWidth: 320, gifFps: 10 });
		const filter = plan.args[plan.args.indexOf('-vf') + 1];
		expect(filter).toContain('fps=10');
		expect(filter).toContain('scale=320:-1');
		expect(filter).toContain('palettegen');
		expect(plan.args).toContain('-loop');
		expect(plan.expectation).toBe('quick');
	});

	it('lifts audio out untouched when it is already the right codec', () => {
		const plan = planConversion(VIDEO_FORMATS.mp3, { ...h264, audioCodec: 'mp3' }, 'out.mp3');
		expect(plan.args).toContain('copy');
		expect(plan.args).toContain('-vn');
	});

	it('re-encodes audio only when it has to', () => {
		const plan = planConversion(VIDEO_FORMATS.mp3, h264, 'out.mp3');
		expect(plan.args).toContain('libmp3lame');
		expect(plan.args).not.toContain('copy');
	});

	it('always drops the video stream when the target is audio', () => {
		expect(planConversion(VIDEO_FORMATS.mp3, h264, 'out.mp3').args).toContain('-vn');
	});
});

describe('fallbackPlan', () => {
	it('re-encodes, for when a copy was attempted and refused', () => {
		const plan = fallbackPlan(VIDEO_FORMATS.mp4, 'out.mp4');
		expect(plan.copy).toBe('none');
		expect(plan.args).not.toContain('copy');
		expect(plan.args).toContain('libx264');
	});
});

describe('keeping the picture when only the sound is wrong', () => {
	// Measured: treating this as all or nothing made MP4 to AVI take 2.5s on a
	// three second clip, when the picture never needed touching at all.
	it('copies the video into an AVI and only re-encodes the AAC', () => {
		expect(canCopyVideo(VIDEO_FORMATS.avi, h264)).toBe(true);
		expect(canCopyAudio(VIDEO_FORMATS.avi, h264)).toBe(false);
		const plan = planConversion(VIDEO_FORMATS.avi, h264, 'out.avi');
		expect(plan.copy).toBe('video');
		expect(plan.framesIntact).toBe(true);
		expect(plan.expectation).toBe('instant');
		expect(plan.args.join(' ')).toContain('-c:v copy');
		expect(plan.args.join(' ')).toContain('-c:a libmp3lame');
		expect(plan.args).not.toContain('libx264');
	});

	it('still calls that a copy of the frames, because it is', () => {
		const plan = planConversion(VIDEO_FORMATS.avi, h264, 'out.avi');
		expect(plan.framesIntact).toBe(true);
		// but not a full copy, since the audio really did change
		expect(plan.copy).not.toBe('full');
	});

	it('keeps audio untouched when only the picture has to change', () => {
		// MP3 audio is fine in an MP4, VP8 video is not
		const vp8mp3 = { ...vp8, audioCodec: 'mp3' };
		const plan = planConversion(VIDEO_FORMATS.mp4, vp8mp3, 'out.mp4');
		expect(plan.copy).toBe('audio');
		expect(plan.framesIntact).toBe(false);
		expect(plan.args.join(' ')).toContain('-c:a copy');
		expect(plan.args).toContain('libx264');
	});

	it('re-encodes both when neither fits', () => {
		const plan = planConversion(VIDEO_FORMATS.webm, h264, 'out.webm');
		expect(plan.copy).toBe('none');
		expect(plan.args.join(' ')).not.toContain('copy');
	});

	it('a silent file never blocks a copy', () => {
		expect(canCopyAudio(VIDEO_FORMATS.avi, silent)).toBe(true);
		expect(planConversion(VIDEO_FORMATS.avi, silent, 'out.avi').copy).toBe('full');
	});
});

describe('estimateSeconds', () => {
	const est = (t: keyof typeof VIDEO_FORMATS, p: ProbeResult) =>
		estimateSeconds(planConversion(VIDEO_FORMATS[t], p, 'out'), p);

	it('says a copy is over before you notice', () => {
		expect(est('mp4', h264)).toBe(1);
	});

	it('scales with length and with pixel count', () => {
		const short = { ...h264, durationSeconds: 10 };
		const long = { ...h264, durationSeconds: 60 };
		expect(est('webm', long)!).toBeGreaterThan(est('webm', short)!);
		const hd = { ...long, width: 1920, height: 1080 };
		expect(est('webm', hd)!).toBeGreaterThan(est('webm', long)!);
	});

	it('admits it has no idea when the duration is unknown', () => {
		expect(est('webm', { ...h264, durationSeconds: null })).toBeNull();
	});
});
