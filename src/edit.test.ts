import { describe, expect, it } from 'vitest';
import { VIDEO_FORMATS } from './formats';
import {
	escapeDrawText,
	evenSize,
	filterFor,
	needsFont,
	PHONE_FRAME_FILE,
	PHONE_MASK_FILE,
	phoneColour,
	phoneFrameGraph,
	phoneLayout,
	phoneOverlayOutside,
	planEdit,
	STILL_FILE,
	stillArgs,
	stillColour,
	stretchLayout,
	stretchedTotal,
	tempoChain,
	untaggedMatrix,
	type EditOp
} from './edit';
import type { ProbeResult } from './plan';
import { BEZEL_COLOUR } from './phoneframe';
import { defaultRamp, FASTER, sampleRamp, SLOWER, type RampPoint } from './ramp';

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

const argsOf = (op: EditOp, target = mp4, p = probe()) => planEdit(op, target, p, 'out.mp4').args;

describe('evenSize', () => {
	it('rounds down to an even number, because H.264 refuses odd ones', () => {
		expect(evenSize(101)).toBe(100);
		expect(evenSize(100)).toBe(100);
	});

	it('never goes below two', () => {
		expect(evenSize(1)).toBe(2);
		expect(evenSize(0)).toBe(2);
	});
});

describe('tempoChain', () => {
	it('leaves a factor atempo accepts alone', () => {
		expect(tempoChain(1.5)).toEqual([1.5]);
		expect(tempoChain(0.5)).toEqual([0.5]);
	});

	it('chains for a factor outside its range', () => {
		expect(tempoChain(4)).toEqual([2, 2]);
		expect(tempoChain(0.25)).toEqual([0.5, 0.5]);
	});

	it('multiplies back out to what was asked for', () => {
		for (const factor of [0.25, 0.4, 0.5, 1, 1.75, 2, 3, 4]) {
			const product = tempoChain(factor).reduce((a, b) => a * b, 1);
			expect(product, String(factor)).toBeCloseTo(factor, 5);
		}
	});

	it('keeps every step inside what atempo accepts', () => {
		for (const factor of [0.25, 0.3, 3, 4]) {
			for (const step of tempoChain(factor)) {
				expect(step, String(factor)).toBeGreaterThanOrEqual(0.5);
				expect(step, String(factor)).toBeLessThanOrEqual(2);
			}
		}
	});
});

describe('filters', () => {
	it('crops to even numbers at a whole pixel', () => {
		expect(filterFor({ kind: 'crop', x: 10.6, y: 4.2, width: 101, height: 51 })).toBe(
			'crop=100:50:11:4'
		);
	});

	it('keeps the aspect ratio with -2 rather than -1', () => {
		expect(filterFor({ kind: 'resize', width: 640, height: null })).toBe('scale=640:-2');
	});

	it('inverts the factor for speed, because PTS is time not rate', () => {
		expect(filterFor({ kind: 'speed', factor: 2 })).toBe('setpts=0.500000*PTS');
	});

	it('turns a quarter at a time', () => {
		const at = (turns: number) =>
			filterFor({ kind: 'rotate', quarterTurns: turns, flipHorizontal: false, flipVertical: false });
		expect(at(1)).toBe('transpose=1');
		expect(at(2)).toBe('transpose=1,transpose=1');
		expect(at(0)).toBeNull();
	});

	it('flips without turning', () => {
		expect(
			filterFor({ kind: 'rotate', quarterTurns: 0, flipHorizontal: true, flipVertical: false })
		).toBe('hflip');
	});

	it('puts a caption where it was asked for', () => {
		const filter = filterFor({
			kind: 'text',
			text: 'Hello',
			size: 40,
			colour: '#ffffff',
			position: 'bottom',
			box: true
		})!;
		expect(filter).toContain("text='Hello'");
		expect(filter).toContain('fontcolor=0xffffff');
		expect(filter).toContain('box=1');
		expect(filter).toContain('h*0.94-text_h');
	});
});

describe('escapeDrawText', () => {
	it('escapes the colon, which ends the option list even inside quotes', () => {
		expect(escapeDrawText('9:30')).toBe('9\\:30');
	});

	it('escapes the quote and the backslash', () => {
		expect(escapeDrawText("it's")).toBe("it\\'s");
		expect(escapeDrawText('a\\b')).toBe('a\\\\b');
	});

	it('leaves the percent alone, because escaping it breaks the filter', () => {
		// Escaping the percent made drawtext draw nothing at all and report
		// nothing either. Escaping the colon is required. Both verified one
		// character at a time in a browser against the real ffmpeg build.
		expect(escapeDrawText('50%')).toBe('50%');
	});

	it('flattens a line break rather than breaking the argument', () => {
		expect(escapeDrawText('one\ntwo')).toBe('one two');
	});

	it('turns off expansion so a percent is not a substitution', () => {
		const filter = filterFor({
			kind: 'text',
			text: '50%',
			size: 40,
			colour: '#ffffff',
			position: 'top',
			box: false
		})!;
		expect(filter).toContain('expansion=none');
	});
});

describe('planEdit', () => {
	it('copies both streams for a trim on a keyframe', () => {
		const plan = planEdit(
			{ kind: 'trim', startSeconds: 2, endSeconds: 5, exact: false },
			mp4,
			probe(),
			'out.mp4'
		);
		expect(plan.copy).toBe('full');
		expect(plan.expectation).toBe('instant');
		expect(plan.framesIntact).toBe(true);
		expect(plan.args).toContain('copy');
	});

	it('seeks before the input, so the cost does not grow with the start time', () => {
		const args = argsOf({ kind: 'trim', startSeconds: 30, endSeconds: null, exact: false });
		expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
	});

	it('re-encodes for an exact trim', () => {
		const plan = planEdit(
			{ kind: 'trim', startSeconds: 2, endSeconds: 5, exact: true },
			mp4,
			probe(),
			'out.mp4'
		);
		expect(plan.copy).toBe('none');
		expect(plan.framesIntact).toBe(false);
	});

	it('leaves every frame alone when only the sound is dropped', () => {
		const plan = planEdit({ kind: 'mute' }, mp4, probe(), 'out.mp4');
		expect(plan.copy).toBe('video');
		expect(plan.expectation).toBe('instant');
		expect(plan.args).toContain('-an');
	});

	it('copies sound the container already accepts', () => {
		const args = argsOf({ kind: 'crop', x: 0, y: 0, width: 640, height: 480 });
		expect(args.join(' ')).toContain('-c:a copy');
	});

	it('re-encodes sound whose timing changed', () => {
		const args = argsOf({ kind: 'speed', factor: 2 });
		expect(args.join(' ')).not.toContain('-c:a copy');
		expect(args).toContain('-af');
	});

	it('re-encodes sound the target container will not take', () => {
		// WebM will not carry AAC, so a cropped MP4 going out as WebM needs a
		// new audio track even though the edit never touched the sound.
		const args = argsOf({ kind: 'crop', x: 0, y: 0, width: 640, height: 480 }, webm);
		expect(args.join(' ')).not.toContain('-c:a copy');
	});

	it('asks for no audio track when the source had none', () => {
		const args = argsOf({ kind: 'blur', strength: 8 }, mp4, probe({ audioCodec: null }));
		expect(args).toContain('-an');
	});

	it('does not add an audio filter to a silent clip', () => {
		const args = argsOf({ kind: 'speed', factor: 2 }, mp4, probe({ audioCodec: null }));
		expect(args).not.toContain('-af');
	});

	it('uses the VP8 settings that were measured, not the defaults', () => {
		const args = argsOf({ kind: 'blur', strength: 5 }, webm);
		expect(args).toContain('-deadline');
		expect(args).toContain('realtime');
		expect(args).not.toContain('-crf');
	});

	it('carries the quality through for compression', () => {
		const args = planEdit({ kind: 'compress', quality: 32 }, mp4, probe(), 'out.mp4').args;
		expect(args[args.indexOf('-crf') + 1]).toBe('32');
	});

	it('only wants the font for text', () => {
		expect(needsFont({ kind: 'text', text: 'a', size: 40, colour: '#fff', position: 'top', box: false })).toBe(true);
		expect(needsFont({ kind: 'blur', strength: 4 })).toBe(false);
	});
});

describe('stretchLayout', () => {
	const op = (over: Partial<Extract<EditOp, { kind: 'stretch' }>> = {}) =>
		({ kind: 'stretch', startSeconds: 2, endSeconds: 6, targetSeconds: 20, ...over }) as const;

	it('works out how much longer the section becomes', () => {
		expect(stretchLayout(op(), 10).stretch).toBe(5);
		// the case this page was built for: 2:32 to 3:42 stretched to 1000s
		const long = stretchLayout(op({ startSeconds: 152, endSeconds: 222, targetSeconds: 1000 }), 300);
		expect(long.stretch).toBeCloseTo(1000 / 70, 6);
	});

	it('knows when there is nothing either side of the section', () => {
		expect(stretchLayout(op({ startSeconds: 0 }), 10).head).toBe(false);
		expect(stretchLayout(op({ endSeconds: 10 }), 10).tail).toBe(false);
		expect(stretchLayout(op(), 10)).toMatchObject({ head: true, tail: true });
	});

	it('assumes there is a tail when the duration could not be read', () => {
		expect(stretchLayout(op({ endSeconds: 10 }), null).tail).toBe(true);
	});

	it('clamps a section and a target that would divide by nothing', () => {
		const layout = stretchLayout(op({ startSeconds: 4, endSeconds: 4, targetSeconds: 0 }), 10);
		expect(layout.endSeconds).toBeGreaterThan(layout.startSeconds);
		expect(layout.targetSeconds).toBeGreaterThan(0);
		expect(Number.isFinite(layout.stretch)).toBe(true);
	});

	it('refuses to produce more than an hour from one section', () => {
		expect(stretchLayout(op({ targetSeconds: 99999 }), 10).targetSeconds).toBe(3600);
	});

	it('adds up what the whole clip will run to', () => {
		expect(stretchedTotal(stretchLayout(op(), 10), 10)).toBe(26);
		const long = stretchLayout(op({ startSeconds: 152, endSeconds: 222, targetSeconds: 1000 }), 300);
		expect(stretchedTotal(long, 300)).toBeCloseTo(1230, 6);
	});
});

describe('planEdit for a slowed section', () => {
	const stretch = (over: Partial<Extract<EditOp, { kind: 'stretch' }>> = {}): EditOp => ({
		kind: 'stretch',
		startSeconds: 2,
		endSeconds: 6,
		targetSeconds: 20,
		...over
	});

	const graphOf = (op: EditOp, p = probe()) => {
		const args = argsOf(op, mp4, p);
		return args[args.indexOf('-filter_complex') + 1];
	};

	it('cuts the clip into three, retimes the middle and joins it back up', () => {
		const graph = graphOf(stretch());
		expect(graph).toContain('[0:v]trim=start=0.000:end=2.000,setpts=PTS-STARTPTS[v0]');
		expect(graph).toContain('[0:v]trim=start=2.000:end=6.000,setpts=5.000000*(PTS-STARTPTS)[v1]');
		// no end on the last one, so it runs to whatever the file has left
		expect(graph).toContain('[0:v]trim=start=6.000,setpts=PTS-STARTPTS[v2]');
		expect(graph).toContain('concat=n=3:v=1:a=1[v][a]');
	});

	it('leaves out a segment there is no footage for', () => {
		expect(graphOf(stretch({ startSeconds: 0 }))).toContain('concat=n=2');
		expect(graphOf(stretch({ endSeconds: 10 }))).toContain('concat=n=2');
	});

	it('takes the sound with it, chaining atempo the way the speed tool does', () => {
		const graph = graphOf(stretch());
		expect(graph).toContain('[0:a]atrim=start=2.000:end=6.000,asetpts=PTS-STARTPTS,');
		const chain = /atrim=start=2\.000:end=6\.000,asetpts=PTS-STARTPTS,([^[]+)\[a1\]/.exec(graph);
		const steps = chain![1].split(',').map((step) => Number(step.replace('atempo=', '')));
		expect(steps.reduce((a, b) => a * b, 1)).toBeCloseTo(0.2, 5);
		for (const step of steps) expect(step).toBeGreaterThanOrEqual(0.5);
	});

	it('never mentions audio for a file that has none', () => {
		const silent = probe({ audioCodec: null });
		const graph = graphOf(stretch(), silent);
		expect(graph).not.toContain('atrim');
		expect(graph).toContain('concat=n=3:v=1:a=0[v]');
		expect(argsOf(stretch(), mp4, silent)).toContain('-an');
	});

	it('maps the joined streams and re-encodes both, since a filter cannot be copied', () => {
		const args = argsOf(stretch());
		expect(args.join(' ')).toContain('-map [v] -map [a]');
		expect(args).toContain('libx264');
		expect(args).toContain('aac');
		expect(planEdit(stretch(), mp4, probe(), 'out.mp4').framesIntact).toBe(false);
	});

	it('passes the frames through rather than repeating them to fill the time', () => {
		// Without this ffmpeg makes the output constant rate, which for a five
		// times stretch is five times as many frames to encode for the same
		// picture. No fps filter in the graph for the same reason.
		expect(argsOf(stretch()).join(' ')).toContain('-fps_mode vfr');
		expect(graphOf(stretch())).not.toContain('fps=');
	});

	it('falls back to the plain speed filter when the section is the whole clip', () => {
		const args = argsOf(stretch({ startSeconds: 0, endSeconds: 10, targetSeconds: 20 }));
		expect(args).not.toContain('-filter_complex');
		expect(args).toContain('-vf');
		expect(args[args.indexOf('-vf') + 1]).toBe('setpts=2.000000*PTS');
	});

	it('builds the graph the page was asked for, 2:32 to 3:42 over 1000 seconds', () => {
		const graph = graphOf(
			stretch({ startSeconds: 152, endSeconds: 222, targetSeconds: 1000 }),
			probe({ durationSeconds: 300 })
		);
		expect(graph).toContain('[0:v]trim=start=152.000:end=222.000,setpts=14.285714*(PTS-STARTPTS)[v1]');
		expect(graph).toContain('concat=n=3:v=1:a=1[v][a]');
	});
});

describe('planEdit for a drawn speed curve', () => {
	const graphOf = (op: EditOp, p = probe()) => {
		const args = argsOf(op, mp4, p);
		return args[args.indexOf('-filter_complex') + 1];
	};
	const ramp = (points: RampPoint[], range = SLOWER): EditOp => ({ kind: 'ramp', points, range });

	it('builds one slice per constant-speed piece and joins them', () => {
		const points = defaultRamp(10);
		const graph = graphOf(ramp(points));
		const pieces = sampleRamp(points, 10, SLOWER).length;
		expect(graph).toContain(`concat=n=${pieces}:v=1:a=1[v][a]`);
		expect(graph.match(/\[0:v\]trim=/g)).toHaveLength(pieces);
	});

	it('leaves the untouched head and tail unretimed', () => {
		// Not cosmetic. A segment at exactly 1 gets no setpts multiplier and no
		// atempo at all, so the parts of the clip nobody asked to change keep
		// their own timing rather than being resampled to the same value.
		const graph = graphOf(ramp(defaultRamp(10)));
		expect(graph).toContain('[0:v]trim=start=0.000:end=');
		expect(graph).toMatch(/\[0:v\]trim=start=0\.000:end=[\d.]+,setpts=PTS-STARTPTS\[v0\]/);
		// and the last slice has no end, so it runs to whatever the file has left
		expect(graph).toMatch(/\[0:v\]trim=start=[\d.]+,setpts=PTS-STARTPTS\[v\d+\]/);
	});

	it('slows the picture down by multiplying timestamps up', () => {
		// Quarter speed is a four times multiplier, and that is the only
		// direction this mode goes.
		const graph = graphOf(ramp([{ t: 0, speed: 0.25 }, { t: 5, speed: 0.25 }, { t: 10, speed: 1 }]));
		expect(graph).toContain('setpts=4.000000*(PTS-STARTPTS)');
		expect(graph).not.toMatch(/setpts=0\.\d+\*/);
	});

	it('takes the sound with it, and drops the audio half when there is none', () => {
		const graph = graphOf(ramp(defaultRamp(10)));
		expect(graph).toContain('atempo=');
		const silent = probe({ audioCodec: null });
		expect(graphOf(ramp(defaultRamp(10)), silent)).not.toContain('[0:a]');
		expect(argsOf(ramp(defaultRamp(10)), mp4, silent)).toContain('-an');
	});

	it('keeps the frames it has rather than repeating them', () => {
		const args = argsOf(ramp(defaultRamp(10)));
		expect(args).toContain('-fps_mode');
		expect(args[args.indexOf('-fps_mode') + 1]).toBe('vfr');
		expect(args.join(' ')).not.toContain('fps=');
		expect(planEdit(ramp(defaultRamp(10)), mp4, probe(), 'out.mp4').framesIntact).toBe(false);
	});

	it('hands a curve that never changes to the plain speed path', () => {
		// A concat of one is a filter graph doing what a single -vf already
		// does, which is the same call the stretch mode makes when its section
		// turns out to be the whole clip.
		const flat = argsOf(ramp([{ t: 0, speed: 0.5 }, { t: 10, speed: 0.5 }]));
		expect(flat).not.toContain('-filter_complex');
		expect(flat.join(' ')).toContain('setpts=2');
	});

	it('does nothing surprising with a curve for a clip of no length', () => {
		// The panel gates on this, but a zero duration reaching here must come
		// out as a plain re-encode rather than a graph built from nothing.
		const args = argsOf(ramp(defaultRamp(10)), mp4, probe({ durationSeconds: 0 }));
		expect(args).not.toContain('-filter_complex');
	});
});

describe('planEdit for a curve that speeds a clip up', () => {
	const graphOf = (op: EditOp, p = probe()) => {
		const args = argsOf(op, mp4, p);
		return args[args.indexOf('-filter_complex') + 1];
	};
	const fast = (points: RampPoint[]): EditOp => ({ kind: 'ramp', points, range: FASTER });

	it('keeps the points above 1 instead of flattening them', () => {
		// The whole reason the op carries its range. Planned against the slow
		// range every point would be clamped back down to 1 and the graph would
		// encode a clip that does nothing, which looks exactly like success.
		const graph = graphOf(fast(defaultRamp(10, FASTER)));
		expect(graph).toMatch(/setpts=0\.\d+\*/);
		expect(graph).toContain('concat=');
	});

	it('multiplies timestamps down, which is what running faster is', () => {
		// Triple speed is a one third multiplier.
		const graph = graphOf(
			fast([
				{ t: 0, speed: 3 },
				{ t: 5, speed: 3 },
				{ t: 10, speed: 1 }
			])
		);
		expect(graph).toContain('setpts=0.333333*(PTS-STARTPTS)');
	});

	it('comes out shorter than it went in', () => {
		const segments = sampleRamp(defaultRamp(10, FASTER), 10, FASTER);
		const total = segments.reduce((sum, seg) => sum + (seg.to - seg.from) / seg.speed, 0);
		expect(total).toBeLessThan(10);
		expect(total).toBeGreaterThan(3);
	});

	it('takes the sound with it', () => {
		expect(graphOf(fast(defaultRamp(10, FASTER)))).toContain('atempo=');
	});
});

describe('planEdit for a phone frame', () => {
	const mov = VIDEO_FORMATS.mov;
	const phone = (over: Partial<Extract<EditOp, { kind: 'phone' }>> = {}) =>
		({
			kind: 'phone',
			width: 920,
			height: 2000,
			bezelOn: true,
			bezel: 40,
			radius: 129,
			background: '#ffffff',
			transparent: false,
			...over
		}) as Extract<EditOp, { kind: 'phone' }>;
	const recording = probe({ width: 920, height: 2000 });
	/** What an iPhone screen recording says about itself. */
	const tagged = probe({
		width: 920,
		height: 2000,
		colourMatrix: 'bt709',
		colourPrimaries: 'bt709',
		colourTransfer: 'bt709'
	});
	const planOf = (op: EditOp, target = mp4, p = recording) => planEdit(op, target, p, 'out.mp4');
	const graphOf = (op: EditOp, target = mp4, p = recording) => {
		const args = planOf(op, target, p).args;
		return args[args.indexOf('-filter_complex') + 1];
	};

	it('pads the video out by the border and lays the frame over it', () => {
		expect(graphOf(phone(), mp4, tagged)).toBe(
			'[0:v]scale=in_range=tv:out_range=tv,format=yuv420p,crop=920:2000:0:0,pad=1000:2080:40:40:color=black[padded];' +
				'[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[frame];' +
				'[padded][frame]overlay=0:0,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v]'
		);
		const args = planOf(phone()).args;
		expect(args.slice(0, 4)).toEqual(['-i', 'input', '-i', PHONE_FRAME_FILE]);
		expect(args.join(' ')).toContain('-map [v]');
	});

	it('draws the frame from the same geometry the image tool uses', () => {
		expect(phoneLayout(phone())).toMatchObject({
			width: 1000,
			height: 2080,
			screen: { x: 40, y: 40, width: 920, height: 2000 },
			innerRadius: 129,
			outerRadius: 169
		});
	});

	it('never puts the video on an odd pixel, where ffmpeg would quietly shift it', () => {
		// pad and overlay round a yuv420p position down to even, so a 39 px
		// border would put the video at 38 and leave a 1 px line down the side
		const graph = graphOf(phone({ bezel: 39 }));
		expect(graph).toContain('pad=1000:2080:40:40');
		for (const bezel of [1, 7, 19, 39, 55]) {
			const [x, y] = /pad=\d+:\d+:(\d+):(\d+)/.exec(graphOf(phone({ bezel })))!.slice(1).map(Number);
			expect(x % 2, String(bezel)).toBe(0);
			expect(y % 2, String(bezel)).toBe(0);
		}
	});

	it('comes out even for H.264 whatever size the recording is', () => {
		for (const [width, height] of [
			[921, 2001],
			[886, 1920],
			[1179, 2556],
			[2556, 1179]
		]) {
			for (const bezelOn of [true, false]) {
				const [w, h] = /pad=(\d+):(\d+)/.exec(graphOf(phone({ width, height, bezelOn })))!.slice(1).map(Number);
				expect(w % 2, `${width}×${height}`).toBe(0);
				expect(h % 2, `${width}×${height}`).toBe(0);
			}
		}
	});

	it('crops a pixel off an odd recording when there is no border', () => {
		const graph = graphOf(phone({ width: 921, height: 2001, bezelOn: false }), mp4, probe({ width: 921, height: 2001 }));
		expect(graph).toContain(',crop=920:2000:0:0,pad=920:2000:0:0:color=black[padded];');
	});

	it('crops an odd recording’s extra pixel with the border on too, rather than leave it to ffmpeg', () => {
		// The first version kept it, as crop=921:2001 into a 1002 × 2082 pad.
		// ffmpeg rounds both down to even in yuv420p, so the recording landed a
		// pixel short of the frame's hole and the hole's last column and row were
		// black. phonepixels.test.ts reads that out of a real run.
		const graph = graphOf(phone({ width: 921, height: 2001 }), mp4, probe({ width: 921, height: 2001 }));
		expect(graph).toContain(',crop=920:2000:0:0,pad=1000:2080:40:40:color=black[padded];');
	});

	it('always cuts the video to the hole it goes in, whatever size ffmpeg finds', () => {
		// the frame is sized from what the browser reported, and Chromium
		// reported a 461 × 999 WebM as 460 × 998. Padding the extra pixel into
		// a 460 pixel hole fails, so the crop is there even when it is a no-op.
		for (const bezelOn of [true, false]) {
			const graph = graphOf(phone({ width: 460, height: 998, bezelOn }));
			expect(graph, String(bezelOn)).toMatch(/^\[0:v\]scale=[^,]*,format=yuv420p,crop=460:998:0:0,pad=/);
		}
	});

	it('copies sound the container takes, and asks for it by name', () => {
		const args = planOf(phone()).args;
		// a mapped graph output turns off ffmpeg's own stream choice, so without
		// this the sound would be silently left out
		expect(args.join(' ')).toContain('-map 0:a:0');
		expect(args.join(' ')).toContain('-c:a copy');
	});

	it('asks for no sound when the recording has none', () => {
		const args = planOf(phone(), mp4, probe({ width: 920, height: 2000, audioCodec: null })).args;
		expect(args).not.toContain('0:a:0');
		expect(args).toContain('-an');
	});

	it('encodes the picture the way the other tools do, in the container it came in', () => {
		const args = planOf(phone(), mov).args;
		expect(args).toContain('libx264');
		expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
		expect(args).toContain('veryfast');
		expect(planOf(phone()).framesIntact).toBe(false);
		expect(planOf(phone()).expectation).toBe('slow');
	});

	it('keeps each frame at the time it arrived, since screen recordings are variable rate', () => {
		const args = planOf(phone()).args;
		expect(args[args.indexOf('-fps_mode') + 1]).toBe('vfr');
		expect(graphOf(phone())).not.toContain('fps=');
	});

	it('uses the measured VP8 settings for a WebM that keeps its background', () => {
		const args = planOf(phone(), webm, probe({ width: 920, height: 2000, audioCodec: 'opus', videoCodec: 'vp8' })).args;
		expect(args[args.indexOf('-c:v') + 1]).toBe('libvpx');
		expect(args).toContain('realtime');
		expect(args).not.toContain('yuva420p');
		expect(args.join(' ')).toContain('-c:a copy');
	});

	describe('with see-through corners', () => {
		const clear = phone({ transparent: true });

		it('takes the alpha from the mask, since an overlay cannot make anything transparent', () => {
			expect(graphOf(clear, webm)).toBe(
				'[0:v]scale=in_range=tv:out_range=tv,format=yuva420p,crop=920:2000:0:0,pad=1000:2080:40:40:color=black[padded];' +
					'[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[frame];' +
					'[padded][frame]overlay=0:0[framed];[framed][2:v]alphamerge' +
					',setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown:range=tv[v]'
			);
			const args = planOf(clear, webm).args;
			expect(args.slice(0, 6)).toEqual(['-i', 'input', '-i', PHONE_FRAME_FILE, '-i', PHONE_MASK_FILE]);
		});

		it('rounds the corners with the mask even when the border is off', () => {
			expect(graphOf(phone({ transparent: true, bezelOn: false }), webm)).toContain('alphamerge');
		});

		it('encodes VP8 with an alpha channel, never VP9', () => {
			const args = planOf(clear, webm).args;
			expect(args[args.indexOf('-c:v') + 1]).toBe('libvpx');
			expect(args).not.toContain('libvpx-vp9');
			expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuva420p');
			expect(args[args.indexOf('-auto-alt-ref') + 1]).toBe('0');
			expect(args).toContain('realtime');
		});

		it('re-encodes AAC for the WebM, which will not carry it', () => {
			const args = planOf(clear, webm).args;
			expect(args.join(' ')).not.toContain('-c:a copy');
			expect(args[args.indexOf('-c:a') + 1]).toBe('libvorbis');
		});

		it('fills the frame black outside the outline, so its soft edge can’t show the recording', () => {
			// The mask's edge is partly opaque, and those pixels show whatever the
			// frame put there. Left clear, that was the recording, whose square
			// corner reaches past the outer curve at the phone defaults. Measured
			// over a black page, the outline came out up to 71 levels bright.
			const f = phoneLayout(clear);
			const corner = Math.hypot(f.screen.x - f.outerRadius, f.screen.y - f.outerRadius);
			expect(corner).toBeGreaterThan(f.outerRadius);
			expect(phoneOverlayOutside(clear)).toBe(BEZEL_COLOUR);
			// whatever the border, as long as there is one
			expect(phoneOverlayOutside(phone({ transparent: true, bezel: 2, radius: 0 }))).toBe(BEZEL_COLOUR);
		});

		it('leaves it clear with no border, where the outline is the recording’s own edge', () => {
			expect(phoneOverlayOutside(phone({ transparent: true, bezelOn: false }))).toBeUndefined();
		});

		it('refuses any container that cannot hold the alpha, rather than dropping it', () => {
			expect(() => planOf(clear, mp4)).toThrow(/WebM/);
			expect(() => planOf(clear, mov)).toThrow(/WebM/);
		});
	});

	it('fills the corners of an opaque video with the colour that was picked', () => {
		expect(phoneOverlayOutside(phone())).toBe('#ffffff');
		expect(phoneOverlayOutside(phone({ background: '#52a152', bezelOn: false }))).toBe('#52a152');
	});

	it('reads one still of the picture for a recording the browser can’t play', () => {
		const args = stillArgs('input');
		expect(args.slice(0, 2)).toEqual(['-i', 'input']);
		expect(args[args.indexOf('-map') + 1]).toBe('0:v:0');
		expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
		expect(args).toContain('-an');
		expect(args.at(-1)).toBe(STILL_FILE);
		expect(STILL_FILE).toMatch(/\.png$/);
		// and never under a name an edit writes, so neither can clobber the other
		expect([PHONE_FRAME_FILE, PHONE_MASK_FILE, 'input']).not.toContain(STILL_FILE);
	});

	it('converts the still with the colours the framed copy will play back with', () => {
		// untagged and 720 lines or more plays as BT.709, and ffmpeg's own
		// default would have read it as BT.601
		const untaggedTall = probe({ width: 460, height: 1000, videoCodec: 'mpeg4', audioCodec: 'aac' });
		expect(stillColour(untaggedTall)).toEqual({ matrix: 'bt709', range: 'tv' });
		expect(stillArgs('input', stillColour(untaggedTall))).toContain('scale=in_color_matrix=bt709:in_range=tv');
		expect(stillColour(probe({ width: 640, height: 480, videoCodec: 'mpeg4' }))).toEqual({ matrix: 'bt601', range: 'tv' });
		// a tag wins, and so does full range
		expect(stillColour(tagged)).toEqual({ matrix: 'bt709', range: 'tv' });
		expect(stillColour(probe({ width: 320, height: 240, colourMatrix: 'bt709', fullRange: true }))).toEqual({
			matrix: 'bt709',
			range: 'pc'
		});
		// and it agrees with the edit, whatever the border
		for (const p of [untaggedTall, tagged, probe({ width: 1280, height: 700 })]) {
			const op = phone({ width: p.width!, height: p.height! });
			const { matrix, range } = phoneColour(op, p);
			expect(stillColour(p), `${p.width}×${p.height}`).toEqual({ matrix, range });
		}
		// the filter goes after the frame count and before the output
		const args = stillArgs('input', { matrix: 'bt601', range: 'pc' });
		expect(args.indexOf('-vf')).toBeGreaterThan(args.indexOf('-frames:v'));
		expect(args.indexOf('-vf')).toBeLessThan(args.indexOf(STILL_FILE));
	});

	it('names the mask only when there is one', () => {
		expect(phoneFrameGraph(phoneLayout(phone()), false, phoneColour(phone(), tagged))).not.toContain('[2:v]');
		expect(planOf(phone()).args).not.toContain(PHONE_MASK_FILE);
	});

	describe('colours', () => {
		const untagged = { colorspace: 'unknown', primaries: 'unknown', transfer: 'unknown' };
		const as601 = { colorspace: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m' };
		const as709 = { colorspace: 'bt709', primaries: 'bt709', transfer: 'bt709' };

		// Measured in the site's core: left to ffmpeg, the frame is converted
		// with BT.601 limited whatever the video is, so on a BT.709 recording
		// #52A152 played back as (76, 148, 79), and on a full range one the
		// black border came back as (16, 16, 16).
		it('converts the frame with the matrix the recording is tagged with', () => {
			expect(phoneColour(phone(), tagged)).toEqual({ matrix: 'bt709', range: 'tv', tag: as709 });
			expect(phoneColour(phone(), probe({ colourMatrix: 'smpte170m' }))).toMatchObject({ matrix: 'bt601' });
			expect(phoneColour(phone(), probe({ colourMatrix: 'bt470bg' }))).toMatchObject({ matrix: 'bt601' });
			expect(phoneColour(phone(), probe({ colourMatrix: 'bt2020nc' }))).toMatchObject({ matrix: 'bt2020' });
			expect(graphOf(phone(), mp4, tagged)).toContain('[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[frame]');
		});

		it('keeps black black on a full range recording', () => {
			const full = probe({ ...tagged, colourTransfer: 'iec61966-2-1', fullRange: true });
			expect(phoneColour(phone(), full)).toEqual({
				matrix: 'bt709',
				range: 'pc',
				tag: { colorspace: 'bt709', primaries: 'bt709', transfer: 'iec61966-2-1' }
			});
			expect(graphOf(phone(), mp4, full)).toContain('out_range=pc');
		});

		it('writes the range out with the rest of the tag, since the frames can’t be trusted with it either', () => {
			// Chrome records VP8 in full range and says so in the WebM, and
			// ffmpeg's VP8 decoder labels every frame limited anyway. Left to the
			// frames, the framed copy was tagged limited over full range pixels,
			// and Chrome showed a grey of 176 as 186.
			const chrome = probe({ ...tagged, colourTransfer: 'iec61966-2-1', videoCodec: 'vp8', audioCodec: 'opus', fullRange: true });
			expect(graphOf(phone(), webm, chrome)).toMatch(
				/setparams=colorspace=bt709:color_primaries=bt709:color_trc=iec61966-2-1:range=pc\[v\]$/
			);
			expect(graphOf(phone({ transparent: true }), webm, chrome)).toMatch(/alphamerge,setparams=[^[]*:range=pc\[v\]$/);
			expect(graphOf(phone(), mp4, tagged)).toMatch(/:range=tv\[v\]$/);
			expect(graphOf(phone(), mp4, recording)).toMatch(/:range=tv\[v\]$/);
		});

		it('holds the pixels in the recording’s range before anything can convert them', () => {
			// Stated both ways, so the change of pixel format the encoder needs
			// happens here and moves nothing. Left to ffmpeg's own converter, the
			// range was decided by the decoder's label: a see-through copy of a
			// full range MP4 came out limited, and of a full range WebM, full.
			const full = probe({ ...tagged, fullRange: true });
			expect(graphOf(phone(), mp4, full)).toMatch(/^\[0:v\]scale=in_range=pc:out_range=pc,format=yuv420p,crop=/);
			expect(graphOf(phone({ transparent: true }), webm, full)).toMatch(
				/^\[0:v\]scale=in_range=pc:out_range=pc,format=yuva420p,crop=/
			);
			expect(graphOf(phone(), mp4, tagged)).toMatch(/^\[0:v\]scale=in_range=tv:out_range=tv,format=yuv420p,crop=/);
			// and the painted frame goes in the same range as the recording
			for (const p of [full, tagged]) {
				const range = p.fullRange ? 'pc' : 'tv';
				const graph = graphOf(phone(), mp4, p);
				expect(graph).toContain(`[1:v]scale=out_color_matrix=bt709:out_range=${range},`);
				expect(graph).toMatch(new RegExp(`:range=${range}\\[v\\]$`));
			}
		});

		it('writes the recording’s own tag back out, since the frames can’t be trusted to carry it', () => {
			// ffmpeg's VP8 decoder labels every frame BT.601, even in a WebM that
			// says BT.709, so a tag left to ride through came out as BT.601
			const vp8 = probe({ ...tagged, videoCodec: 'vp8', audioCodec: 'opus' });
			expect(graphOf(phone(), webm, vp8)).toMatch(
				/overlay=0:0,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv\[v\]$/
			);
			// a part ffmpeg printed as unknown, or has no setparams name for, stays unknown
			const partial = probe({ colourMatrix: 'bt709', colourPrimaries: null, colourTransfer: 'reserved' });
			expect(phoneColour(phone(), partial).tag).toEqual({ colorspace: 'bt709', primaries: 'unknown', transfer: 'unknown' });
		});

		it('guesses the way Chrome does for a recording with no tag at all', () => {
			// H.264 and VP8 by height, 720 lines and up being BT.709, width aside
			expect(untaggedMatrix('h264', 2000)).toBe('bt709');
			expect(untaggedMatrix('vp8', 1000)).toBe('bt709');
			expect(untaggedMatrix('h264', 720)).toBe('bt709');
			expect(untaggedMatrix('h264', 718)).toBe('bt601');
			expect(untaggedMatrix('vp8', 240)).toBe('bt601');
			// and VP9 as BT.601 whatever its size
			expect(untaggedMatrix('vp9', 1000)).toBe('bt601');
			expect(untaggedMatrix('vp9', 2556)).toBe('bt601');
		});

		it('leaves an untagged recording untagged, so the screen is read the way the original was', () => {
			// The first version tagged this BT.601. Chrome showed the source as
			// BT.709 and the framed copy as BT.601, a red up to 18 levels off.
			// Untagged is written out too, or VP8's own BT.601 label would stick.
			const vp8 = probe({ width: 460, height: 1000, videoCodec: 'vp8', audioCodec: 'opus' });
			const op = phone({ width: 460, height: 1000, bezel: 20, radius: 64 });
			expect(phoneColour(op, vp8)).toEqual({ matrix: 'bt709', range: 'tv', tag: untagged });
			expect(graphOf(op, webm, vp8)).toMatch(/overlay=0:0,setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown:range=tv\[v\]$/);
			expect(graphOf(op, webm, vp8)).toContain('out_color_matrix=bt709');
			expect(phoneColour(phone(), recording)).toEqual({ matrix: 'bt709', range: 'tv', tag: untagged });
			expect(phoneColour(phone({ transparent: true }), recording)).toMatchObject({ matrix: 'bt709', tag: untagged });
			// small enough to be read as BT.601, before and after the border
			const small = phone({ width: 320, height: 240, bezel: 14 });
			expect(phoneColour(small, probe({ width: 320, height: 240 }))).toEqual({ matrix: 'bt601', range: 'tv', tag: untagged });
		});

		it('writes the guess down only where the output would be guessed differently', () => {
			// untagged VP9 is BT.601 in Chrome, but the H.264 or VP8 it becomes
			// would be read as BT.709 at this height
			const vp9 = probe({ width: 460, height: 1000, videoCodec: 'vp9', audioCodec: 'opus' });
			const op = phone({ width: 460, height: 1000, bezel: 20, radius: 64 });
			expect(phoneColour(op, vp9)).toEqual({ matrix: 'bt601', range: 'tv', tag: as601 });
			expect(graphOf(op, mp4, vp9)).toMatch(
				/overlay=0:0,setparams=colorspace=smpte170m:color_primaries=smpte170m:color_trc=smpte170m:range=tv\[v\]$/
			);
			// 700 lines is BT.601, and the border takes it to 740, which is not
			const landscape = phone({ width: 1280, height: 700, bezel: 20, radius: 60 });
			expect(phoneColour(landscape, probe({ width: 1280, height: 700 }))).toEqual({ matrix: 'bt601', range: 'tv', tag: as601 });
		});

		it('writes back a tag the container declared and ffmpeg lost', () => {
			// Chrome's MP4 recordings: VP9 with no tag in the stream and BT.601
			// in the vpcC box, which ffmpeg's VP9 decoder throws away
			const chrome = probe({
				width: 460,
				height: 1000,
				videoCodec: 'vp9',
				audioCodec: 'opus',
				declaredColour: { matrix: 6, primaries: 6, transfer: 6 }
			});
			const op = phone({ width: 460, height: 1000, bezel: 20, radius: 64 });
			expect(phoneColour(op, chrome)).toEqual({ matrix: 'bt601', range: 'tv', tag: as601 });
			// and a box saying BT.709 is BT.709, which Chrome honours over its VP9 guess
			const hd = probe({ ...chrome, declaredColour: { matrix: 1, primaries: 1, transfer: 1 } });
			expect(phoneColour(op, hd)).toEqual({ matrix: 'bt709', range: 'tv', tag: as709 });
			expect(graphOf(op, mp4, hd)).toMatch(/setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv\[v\]$/);
		});

		it('writes the parts of a declared tag it has no name for as unknown', () => {
			const odd = probe({ width: 920, height: 2000, videoCodec: 'vp9', declaredColour: { matrix: 9, primaries: 2, transfer: 16 } });
			expect(phoneColour(phone(), odd)).toEqual({
				matrix: 'bt2020',
				range: 'tv',
				tag: { colorspace: 'bt2020nc', primaries: 'unknown', transfer: 'smpte2084' }
			});
		});

		it('trusts ffmpeg’s own tag over what the container declares', () => {
			const both = probe({ ...tagged, declaredColour: { matrix: 6, primaries: 6, transfer: 6 } });
			expect(phoneColour(phone(), both)).toEqual({ matrix: 'bt709', range: 'tv', tag: as709 });
		});

		it('treats a tag it has no matrix for as no tag', () => {
			expect(phoneColour(phone(), probe({ width: 920, height: 2000, colourMatrix: 'gbr' }))).toEqual({
				matrix: 'bt709',
				range: 'tv',
				tag: untagged
			});
			const declaredRgb = probe({ width: 920, height: 2000, declaredColour: { matrix: 0, primaries: 1, transfer: 13 } });
			expect(phoneColour(phone(), declaredRgb)).toMatchObject({ matrix: 'bt709', tag: untagged });
		});
	});
});
