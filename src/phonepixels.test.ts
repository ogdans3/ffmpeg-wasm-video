import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evenPhoneFrame, type PhoneFrame, type PhoneFrameSettings } from './phoneframe';
import {
	PHONE_FRAME_FILE,
	PHONE_MASK_FILE,
	phoneFrameGraph,
	phoneLayout,
	phoneOverlayOutside,
	planEdit,
	type EditOp,
	type PhoneColour
} from './edit';
import { VIDEO_FORMATS } from './formats';
import { parseProbe } from './probe';

/**
 * The phone frame run through the site's own ffmpeg core, the WebAssembly
 * build the browser downloads, and read back pixel by pixel.
 *
 * `edit.test.ts` checks the arguments, which is where the decisions are made.
 * Two bugs got past it because the arguments said exactly what was meant and
 * ffmpeg did something else with them, silently. Its crop and pad round an odd
 * yuv420p picture down to even, so an odd recording was placed a pixel short
 * of the frame's hole and the hole's last column and row came out black. And
 * its VP8 decoder labels a full range recording limited, so the framed copy of
 * a Chrome recording was tagged limited over full range pixels and every grey
 * came out stretched. Neither shows in a filter string, and both show here.
 *
 * About a second, most of it compiling the core. The core is built for a
 * browser worker and reads `self.location` when it starts, so the two are
 * lent to it for the length of this file.
 */

interface Core {
	FS: { writeFile(name: string, data: Uint8Array): void; readFile(name: string): Uint8Array };
	exec(...args: string[]): number;
	reset(): void;
	setLogger(logger: (entry: { message: string }) => void): void;
	ret: number;
}

let core: Core;
let said: string[] = [];
const lent: string[] = [];

beforeAll(async () => {
	const scope = globalThis as Record<string, unknown>;
	const js = createRequire(import.meta.url)
		.resolve('@ffmpeg/core')
		.replace(`${sep}umd${sep}`, `${sep}esm${sep}`);
	for (const [name, value] of [
		['self', globalThis],
		['location', { href: pathToFileURL(js).href }]
	] as const) {
		if (scope[name] === undefined) {
			scope[name] = value;
			lent.push(name);
		}
	}
	const url = pathToFileURL(js).href;
	const { default: create } = (await import(/* @vite-ignore */ url)) as {
		default: (options: { wasmBinary: Uint8Array }) => Promise<Core>;
	};
	core = await create({ wasmBinary: readFileSync(js.replace(/\.js$/, '.wasm')) });
	core.setLogger(({ message }) => said.push(message));
}, 60_000);

afterAll(() => {
	for (const name of lent) delete (globalThis as Record<string, unknown>)[name];
});

/** ffmpeg's exit code, with what it printed kept in `said`. */
function run(...args: string[]): number {
	said = [];
	core.exec(...args);
	const code = core.ret;
	core.reset();
	return code;
}

/* ---- pictures ----------------------------------------------------------- */

interface Planes {
	width: number;
	height: number;
	y: (x: number, y: number) => number;
	u: (cx: number, cy: number) => number;
	v: (cx: number, cy: number) => number;
}

/** yuv420p bytes for a picture of this size, chroma rounded up as ffmpeg does. */
function yuv(p: Planes): Uint8Array {
	const cw = Math.ceil(p.width / 2);
	const ch = Math.ceil(p.height / 2);
	const out = new Uint8Array(p.width * p.height + cw * ch * 2);
	for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) out[y * p.width + x] = p.y(x, y);
	const u = p.width * p.height;
	const v = u + cw * ch;
	for (let cy = 0; cy < ch; cy++) {
		for (let cx = 0; cx < cw; cx++) {
			out[u + cy * cw + cx] = p.u(cx, cy);
			out[v + cy * cw + cx] = p.v(cx, cy);
		}
	}
	return out;
}

/** Reading yuv420p bytes back out, for an even size. */
function planes(bytes: Uint8Array, width: number, height: number) {
	const cw = width / 2;
	const u = width * height;
	const v = u + cw * (height / 2);
	return {
		y: (x: number, y: number) => bytes[y * width + x],
		u: (cx: number, cy: number) => bytes[u + cy * cw + cx],
		v: (cx: number, cy: number) => bytes[v + cy * cw + cx]
	};
}

function insideRound(px: number, py: number, x: number, y: number, w: number, h: number, r: number): boolean {
	if (px < x || px > x + w || py < y || py > y + h) return false;
	const cx = Math.min(Math.max(px, x + r), x + w - r);
	const cy = Math.min(Math.max(py, y + r), y + h - r);
	return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/**
 * What `paintPhoneFrame` draws for the video, decided at each pixel's centre
 * with no antialiasing, which is the model `phoneframe.test.ts` pins the
 * painter to. Hard edges keep every pixel either the frame's or the video's,
 * so both can be checked exactly.
 */
function frameRgba(frame: PhoneFrame, outside: string | undefined): Uint8Array {
	const out = outside ? [1, 3, 5].map((i) => parseInt(outside.slice(i, i + 2), 16)) : null;
	const rgba = new Uint8Array(frame.width * frame.height * 4);
	const s = frame.screen;
	for (let y = 0; y < frame.height; y++) {
		for (let x = 0; x < frame.width; x++) {
			const [px, py] = [x + 0.5, y + 0.5];
			let colour = out ? [...out, 255] : [0, 0, 0, 0];
			if (frame.bezel > 0 && insideRound(px, py, 0, 0, frame.width, frame.height, frame.outerRadius)) {
				colour = [0, 0, 0, 255];
			}
			if (insideRound(px, py, s.x, s.y, s.width, s.height, frame.innerRadius)) colour = [0, 0, 0, 0];
			rgba.set(colour, (y * frame.width + x) * 4);
		}
	}
	return rgba;
}

/** `paintPhoneMask`: white over the whole rounded body, black outside it. */
function maskRgba(frame: PhoneFrame): Uint8Array {
	const rgba = new Uint8Array(frame.width * frame.height * 4);
	for (let y = 0; y < frame.height; y++) {
		for (let x = 0; x < frame.width; x++) {
			const on = insideRound(x + 0.5, y + 0.5, 0, 0, frame.width, frame.height, frame.outerRadius) ? 255 : 0;
			rgba.set([on, on, on, 255], (y * frame.width + x) * 4);
		}
	}
	return rgba;
}

/** A PNG written into the core's filesystem by the core itself, as the page writes one. */
function writePng(name: string, width: number, height: number, rgba: Uint8Array) {
	core.FS.writeFile('paint.rgba', rgba);
	expect(run('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'paint.rgba', '-frames:v', '1', '-y', name)).toBe(0);
}

/** The first frame of a file as yuv420p bytes, exactly as stored. */
function firstFrame(name: string): Uint8Array {
	expect(run('-i', name, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-y', 'frame.yuv')).toBe(0);
	return core.FS.readFile('frame.yuv');
}

/** The Range element of a WebM's Colour, 1 for limited and 2 for full. */
function webmRange(bytes: Uint8Array): number | null {
	for (let i = 0; i + 3 < bytes.length; i++) {
		if (bytes[i] === 0x55 && bytes[i + 1] === 0xb9 && bytes[i + 2] === 0x81) return bytes[i + 3];
	}
	return null;
}

/* ---- odd sizes ---------------------------------------------------------- */

describe('an odd recording in the frame, through ffmpeg', () => {
	// Every column and row different, so a pixel out of place can't hide.
	const source: Planes = {
		width: 45,
		height: 99,
		y: (x, y) => 40 + ((x * 4 + y * 2) % 180),
		u: (cx) => 64 + ((cx * 5) % 120),
		v: (_, cy) => 64 + ((cy * 3) % 120)
	};
	const limited: PhoneColour = {
		matrix: 'bt709',
		range: 'tv',
		tag: { colorspace: 'unknown', primaries: 'unknown', transfer: 'unknown' }
	};

	for (const settings of [
		{ bezelOn: true, bezel: 4, radius: 6 },
		{ bezelOn: false, bezel: 4, radius: 6 }
	] satisfies PhoneFrameSettings[]) {
		it(`shows the recording in every pixel of the hole, border ${settings.bezelOn ? 'on' : 'off'}`, () => {
			const frame = evenPhoneFrame(source.width, source.height, settings);
			const rgba = frameRgba(frame, '#ffffff');
			core.FS.writeFile('input', yuv(source));
			writePng(PHONE_FRAME_FILE, frame.width, frame.height, rgba);
			const code = run(
				'-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${source.width}x${source.height}`, '-i', 'input',
				'-i', PHONE_FRAME_FILE,
				'-filter_complex', phoneFrameGraph(frame, false, limited),
				'-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-y', 'out.yuv'
			);
			expect(code, said.slice(-3).join('\n')).toBe(0);
			const out = planes(core.FS.readFile('out.yuv'), frame.width, frame.height);
			const s = frame.screen;
			const alpha = (x: number, y: number) => rgba[(y * frame.width + x) * 4 + 3];

			let holePixels = 0;
			for (let y = 0; y < frame.height; y++) {
				for (let x = 0; x < frame.width; x++) {
					if (alpha(x, y) === 0) {
						// The hole is the recording and nothing else. The first version
						// placed a 45 × 99 recording as 44 × 98 in a 45 × 99 hole, and
						// its last column and row came out as the pad's black here.
						holePixels++;
						expect(out.y(x, y), `luma at ${x},${y}`).toBe(source.y(x - s.x, y - s.y));
					} else {
						// the frame's own pixels, black border and white corners
						const white = rgba[(y * frame.width + x) * 4] === 255;
						expect(out.y(x, y), `frame at ${x},${y}`).toBe(white ? 235 : 16);
					}
				}
			}
			expect(holePixels).toBeGreaterThan(s.width * s.height * 0.95);
			// the last column and row the frame shows are the recording's own
			const [lastX, lastY] = [s.x + s.width - 1, s.y + s.height - 1];
			expect(out.y(lastX, s.y + 20)).toBe(source.y(s.width - 1, 20));
			expect(out.y(s.x + 20, lastY)).toBe(source.y(20, s.height - 1));

			// Colour too, wherever a 2 × 2 block is all recording.
			for (let cy = 0; cy < frame.height / 2; cy++) {
				for (let cx = 0; cx < frame.width / 2; cx++) {
					const [x, y] = [cx * 2, cy * 2];
					if (alpha(x, y) || alpha(x + 1, y) || alpha(x, y + 1) || alpha(x + 1, y + 1)) continue;
					expect(out.u(cx, cy), `u at ${cx},${cy}`).toBe(source.u(cx - s.x / 2, cy - s.y / 2));
					expect(out.v(cx, cy), `v at ${cx},${cy}`).toBe(source.v(cx - s.x / 2, cy - s.y / 2));
				}
			}
		});
	}
});

/* ---- range -------------------------------------------------------------- */

describe('a full range recording in the frame, through ffmpeg', () => {
	// Flat patches, which even a lossy encode keeps within a level or two:
	// a grey on top and a colour below, in the full range Chrome records in.
	const GREY = 176;
	const patches: Planes = {
		width: 46,
		height: 100,
		y: (_, y) => (y < 50 ? GREY : 90),
		u: (_, cy) => (cy < 25 ? 128 : 100),
		v: (_, cy) => (cy < 25 ? 128 : 200)
	};
	const near = (actual: number, expected: number, what: string) =>
		expect(Math.abs(actual - expected), `${what}: ${actual}, wanted ${expected}`).toBeLessThanOrEqual(3);

	/**
	 * The recording as a container file named the way the page names it. The
	 * bytes go in as they are: `pixels` is yuvj420p for a full range format, or
	 * ffmpeg would stretch them into it on the way.
	 */
	function record(encode: string[], pixels = 'yuv420p') {
		core.FS.writeFile('source.yuv', yuv(patches));
		const code = run(
			'-f', 'rawvideo', '-pix_fmt', pixels, '-s', `${patches.width}x${patches.height}`, '-r', '10',
			'-i', 'source.yuv', '-frames:v', '4', ...encode, '-y', 'input'
		);
		expect(code, said.slice(-3).join('\n')).toBe(0);
		run('-i', 'input');
		return parseProbe(said);
	}

	/** The phone edit exactly as the page plans it, frame and mask included. */
	function frameIt(probe: ReturnType<typeof parseProbe>, transparent: boolean) {
		const op: Extract<EditOp, { kind: 'phone' }> = {
			kind: 'phone',
			width: patches.width,
			height: patches.height,
			bezelOn: true,
			bezel: 4,
			radius: 8,
			background: '#ffffff',
			transparent
		};
		const frame = phoneLayout(op);
		writePng(PHONE_FRAME_FILE, frame.width, frame.height, frameRgba(frame, phoneOverlayOutside(op)));
		if (transparent) writePng(PHONE_MASK_FILE, frame.width, frame.height, maskRgba(frame));
		const plan = planEdit(op, VIDEO_FORMATS.webm, probe, 'output.webm');
		const code = run(...plan.args);
		expect(code, said.slice(-3).join('\n')).toBe(0);
		const bytes = core.FS.readFile('output.webm');
		return { frame, bytes, out: planes(firstFrame('output.webm'), frame.width, frame.height) };
	}

	// What Chrome's MediaRecorder writes: VP8 in a WebM whose Colour element
	// says full range, which ffmpeg's VP8 decoder then labels limited.
	const chromeVp8 = ['-c:v', 'libvpx', '-b:v', '2M', '-color_range', 'pc', '-colorspace', 'bt709',
		'-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-f', 'webm'];

	for (const transparent of [false, true]) {
		it(`keeps a Chrome WebM's full range, ${transparent ? 'see-through' : 'with coloured corners'}`, () => {
			const probe = record(chromeVp8);
			expect(probe.fullRange).toBe(true);
			const { frame, bytes, out } = frameIt(probe, transparent);
			// Tagged limited, a player stretched every grey: 176 was shown as 186.
			expect(webmRange(bytes)).toBe(2);
			const s = frame.screen;
			near(out.y(s.x + 23, s.y + 20), GREY, 'the grey');
			near(out.y(s.x + 23, s.y + 80), 90, 'the colour');
			near(out.v(s.x / 2 + 11, s.y / 2 + 40), 200, 'its red');
			near(out.y(1, frame.height / 2), 0, 'the border, true black in full range');
			if (!transparent) near(out.y(0, 0), 255, 'a white corner');
		});
	}

	it('keeps a yuvj H.264 full range on its way into a see-through WebM', () => {
		// Full range by its pixel format alone, and converted to yuva420p for
		// the alpha, where ffmpeg's own converter would have made it limited.
		const probe = record(['-c:v', 'libx264', '-pix_fmt', 'yuvj420p', '-color_range', 'pc', '-f', 'mp4'], 'yuvj420p');
		expect(probe.fullRange).toBe(true);
		const { frame, bytes, out } = frameIt(probe, true);
		expect(webmRange(bytes)).toBe(2);
		near(out.y(frame.screen.x + 23, frame.screen.y + 20), GREY, 'the grey');
		near(out.y(1, frame.height / 2), 0, 'the border');
	});

	it('leaves a limited recording limited', () => {
		const probe = record(['-c:v', 'libvpx', '-b:v', '2M', '-color_range', 'tv', '-f', 'webm']);
		expect(probe.fullRange).toBe(false);
		const { frame, bytes, out } = frameIt(probe, false);
		expect(webmRange(bytes)).toBe(1);
		near(out.y(frame.screen.x + 23, frame.screen.y + 20), GREY, 'the grey, untouched');
		near(out.y(1, frame.height / 2), 16, 'the border, black in limited range');
		near(out.y(0, 0), 235, 'a white corner');
	});
});
