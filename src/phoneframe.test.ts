import { describe, expect, it } from 'vitest';
import {
	BEZEL_COLOUR,
	evenPhoneFrame,
	paintPhoneFrame,
	paintPhoneMask,
	phoneFrame,
	phoneFrameDefaults,
	phoneFrameLimits,
	type FrameContext,
	type PhoneFrame
} from './phoneframe';

describe('phoneFrameDefaults', () => {
	it('sizes the corners and the border like a phone for the owner’s 920 × 2000 screenshots', () => {
		// 920 × 55/393 = 128.75, and 920 × 2.75/65.1 = 38.86
		expect(phoneFrameDefaults(920, 2000)).toEqual({ bezel: 39, radius: 129 });
	});

	it('gives an iPhone Pro screenshot at full size the phone’s own 55 point corners', () => {
		// 1179 is 393 points at 3x, so 55 points is exactly 165 px
		expect(phoneFrameDefaults(1179, 2556)).toEqual({ bezel: 50, radius: 165 });
	});

	it('measures a landscape capture on its short side, so it gets the same phone', () => {
		expect(phoneFrameDefaults(2000, 920)).toEqual(phoneFrameDefaults(920, 2000));
		expect(phoneFrameDefaults(2556, 1179)).toEqual({ bezel: 50, radius: 165 });
	});

	it('offers the video page the same phone in whole pixel pairs', () => {
		// 38.86 rounds to 39, and a video border has to be even, so 40
		expect(phoneFrameDefaults(920, 2000, { even: true })).toEqual({ bezel: 40, radius: 129 });
		expect(phoneFrameDefaults(1179, 2556, { even: true })).toEqual({ bezel: 50, radius: 165 });
		expect(phoneFrameDefaults(8, 8, { even: true }).bezel).toBe(2);
	});

	it('never suggests a border of nothing, even for a tiny image', () => {
		expect(phoneFrameDefaults(8, 8).bezel).toBe(1);
		expect(phoneFrameDefaults(0, 0)).toEqual({ bezel: 1, radius: 0 });
	});
});

describe('phoneFrameLimits', () => {
	it('lets the radius reach a full semicircle and the border a fifth of the short side', () => {
		expect(phoneFrameLimits(920, 2000)).toEqual({ bezelMax: 184, radiusMax: 460 });
		expect(phoneFrameLimits(2000, 921)).toEqual({ bezelMax: 184, radiusMax: 460 });
	});

	it('keeps the top of the video page’s border slider even and inside the range', () => {
		// a fifth of 927 is 185.4, so 185, and the even slider stops at 184
		expect(phoneFrameLimits(927, 2000)).toEqual({ bezelMax: 185, radiusMax: 463 });
		expect(phoneFrameLimits(927, 2000, { even: true })).toEqual({ bezelMax: 184, radiusMax: 463 });
		expect(phoneFrameLimits(920, 2000, { even: true }).bezelMax).toBe(184);
	});

	it('keeps some room for a border on a small image', () => {
		expect(phoneFrameLimits(40, 40).bezelMax).toBe(20);
	});

	it('always has room for the default', () => {
		for (const [w, h] of [
			[920, 2000],
			[1179, 2556],
			[2000, 920],
			[64, 64],
			[3, 5]
		]) {
			const d = phoneFrameDefaults(w, h);
			const l = phoneFrameLimits(w, h);
			expect(d.bezel, `${w}×${h}`).toBeLessThanOrEqual(l.bezelMax);
			expect(d.radius, `${w}×${h}`).toBeLessThanOrEqual(l.radiusMax);
		}
	});
});

describe('phoneFrame', () => {
	it('adds the border on every side and never scales the screen', () => {
		const f = phoneFrame(920, 2000, { bezelOn: true, bezel: 39, radius: 129 });
		expect(f).toEqual({
			width: 998,
			height: 2078,
			screen: { x: 39, y: 39, width: 920, height: 2000 },
			bezel: 39,
			innerRadius: 129,
			outerRadius: 168
		});
	});

	it('makes the outside corner the screen’s radius plus the border', () => {
		for (const bezel of [1, 12, 39, 150]) {
			for (const radius of [0, 40, 129, 460]) {
				const f = phoneFrame(920, 2000, { bezelOn: true, bezel, radius });
				expect(f.outerRadius).toBe(f.innerRadius + bezel);
			}
		}
	});

	it('leaves only the rounded corners when the border is off', () => {
		const f = phoneFrame(920, 2000, { bezelOn: false, bezel: 39, radius: 129 });
		expect(f).toEqual({
			width: 920,
			height: 2000,
			screen: { x: 0, y: 0, width: 920, height: 2000 },
			bezel: 0,
			innerRadius: 129,
			outerRadius: 129
		});
	});

	it('clamps the radius to half the short side, and the outside corner follows', () => {
		const f = phoneFrame(920, 2000, { bezelOn: true, bezel: 39, radius: 5000 });
		expect(f.innerRadius).toBe(460);
		// which is exactly half the frame's own short side, so it stays a curve
		expect(f.outerRadius).toBe(499);
		expect(f.outerRadius).toBe(Math.min(f.width, f.height) / 2);
		expect(phoneFrame(2000, 920, { bezelOn: false, bezel: 0, radius: 999 }).innerRadius).toBe(460);
	});

	it('reads anything that is not a sensible number as nothing', () => {
		const f = phoneFrame(100, 200, { bezelOn: true, bezel: Number.NaN, radius: -12 });
		expect(f.bezel).toBe(0);
		expect(f.innerRadius).toBe(0);
		expect(f.width).toBe(100);
		expect(phoneFrame(100, 200, { bezelOn: true, bezel: 10.6, radius: 20.4 })).toMatchObject({
			bezel: 11,
			innerRadius: 20,
			width: 122
		});
	});

	it('keeps an odd size odd, since an image has no reason to change it', () => {
		const f = phoneFrame(921, 2001, { bezelOn: true, bezel: 39, radius: 129 });
		expect([f.width, f.height]).toEqual([999, 2079]);
	});
});

describe('evenPhoneFrame', () => {
	const on = { bezelOn: true, bezel: 40, radius: 129 };
	const off = { bezelOn: false, bezel: 40, radius: 129 };

	it('changes nothing for an even input with an even border', () => {
		expect(evenPhoneFrame(920, 2000, on)).toEqual(phoneFrame(920, 2000, on));
		expect(evenPhoneFrame(1080, 2340, off)).toEqual(phoneFrame(1080, 2340, off));
	});

	it('rounds an odd border up by one, because ffmpeg places a yuv420p picture on even pixels', () => {
		// pad and overlay both round the position down to an even number, so a
		// 19 px border put the video at 18 and left a 1 px line of background
		// down the right edge of the screen in a real encode
		const f = evenPhoneFrame(920, 2000, { bezelOn: true, bezel: 39, radius: 129 });
		expect(f.bezel).toBe(40);
		expect(f.screen).toEqual({ x: 40, y: 40, width: 920, height: 2000 });
		expect([f.width, f.height]).toEqual([1000, 2080]);
		expect(f.outerRadius).toBe(169);
		expect(evenPhoneFrame(100, 200, { bezelOn: true, bezel: 1, radius: 0 }).bezel).toBe(2);
	});

	it('gives up an odd recording’s last column and row, with the border on too', () => {
		// The first version kept the pixel and widened the right and bottom
		// border by one. ffmpeg's crop and pad round a yuv420p picture down to
		// even, so the recording went in a pixel short of its hole and the
		// hole's last column and row came out black. See phonepixels.test.ts.
		const f = evenPhoneFrame(921, 2001, on);
		expect([f.width, f.height]).toEqual([1000, 2080]);
		expect(f.screen).toEqual({ x: 40, y: 40, width: 920, height: 2000 });
		// the same border on every side
		expect(f.width - f.screen.x - f.screen.width).toBe(40);
		expect(f.height - f.screen.y - f.screen.height).toBe(40);
		expect(f.outerRadius).toBe(f.innerRadius + 40);
	});

	it('handles one odd side on its own', () => {
		const f = evenPhoneFrame(920, 2001, on);
		expect([f.width, f.height]).toEqual([1000, 2080]);
		expect(f.screen).toMatchObject({ width: 920, height: 2000 });
	});

	it('crops the screen by a pixel when there is no border as well', () => {
		const f = evenPhoneFrame(921, 2001, off);
		expect([f.width, f.height]).toEqual([920, 2000]);
		expect(f.screen).toEqual({ x: 0, y: 0, width: 920, height: 2000 });
	});

	it('always comes out even, with the screen on an even pixel and an even size', () => {
		for (const w of [99, 100, 921, 1179]) {
			for (const h of [99, 100, 2001, 2556]) {
				for (const settings of [on, off, { bezelOn: true, bezel: 7, radius: 0 }]) {
					const f = evenPhoneFrame(w, h, settings);
					expect(f.width % 2, `${w}×${h}`).toBe(0);
					expect(f.height % 2, `${w}×${h}`).toBe(0);
					expect(f.screen.x % 2, `${w}×${h}`).toBe(0);
					expect(f.screen.y % 2, `${w}×${h}`).toBe(0);
					// so crop and pad have nothing left to round off on their own
					expect(f.screen.width % 2, `${w}×${h}`).toBe(0);
					expect(f.screen.height % 2, `${w}×${h}`).toBe(0);
					// and never more than the one pixel the grid costs
					expect(w - f.screen.width, `${w}×${h}`).toBe(w % 2);
					expect(h - f.screen.height, `${w}×${h}`).toBe(h % 2);
					expect(f.width - f.screen.width, `${w}×${h}`).toBe(f.bezel * 2);
				}
			}
		}
	});
});

/**
 * A 2D context that fills whole pixels by their centres, for exactly the calls
 * the painter makes. No antialiasing and no canvas package: it answers "what
 * colour is this pixel", which is what the painter is responsible for, and the
 * rounded rectangles are tested against the same corner circles a browser
 * draws.
 */
type Box = { x: number; y: number; w: number; h: number; r: number };

function insideBox(px: number, py: number, b: Box): boolean {
	if (px < b.x || px > b.x + b.w || py < b.y || py > b.y + b.h) return false;
	const r = Math.min(b.r, b.w / 2, b.h / 2);
	const cx = Math.min(Math.max(px, b.x + r), b.x + b.w - r);
	const cy = Math.min(Math.max(py, b.y + r), b.y + b.h - r);
	return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

class FakeContext {
	pixels: string[];
	fillStyle = '#000000';
	globalCompositeOperation = 'source-over';
	private path: Box[] = [];
	private clipBox: Box | null = null;
	private stack: { fillStyle: string; op: string; clip: Box | null }[] = [];

	constructor(
		readonly width: number,
		readonly height: number
	) {
		this.pixels = new Array(width * height).fill('some leftover');
	}

	at(x: number, y: number): string {
		return this.pixels[y * this.width + x];
	}

	private paint(x0: number, y0: number, x1: number, y1: number, hit: (px: number, py: number) => boolean, colour: string) {
		for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.height, Math.ceil(y1)); y++) {
			for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.width, Math.ceil(x1)); x++) {
				const px = x + 0.5;
				const py = y + 0.5;
				if (!hit(px, py)) continue;
				if (this.clipBox && !insideBox(px, py, this.clipBox)) continue;
				this.pixels[y * this.width + x] =
					this.globalCompositeOperation === 'destination-out' ? 'transparent' : colour;
			}
		}
	}

	save() {
		this.stack.push({ fillStyle: this.fillStyle, op: this.globalCompositeOperation, clip: this.clipBox });
	}

	restore() {
		const top = this.stack.pop();
		if (!top) return;
		this.fillStyle = top.fillStyle;
		this.globalCompositeOperation = top.op;
		this.clipBox = top.clip;
	}

	beginPath() {
		this.path = [];
	}

	roundRect(x: number, y: number, w: number, h: number, r: number) {
		this.path.push({ x, y, w, h, r });
	}

	fill() {
		for (const box of this.path) {
			this.paint(box.x, box.y, box.x + box.w, box.y + box.h, (px, py) => insideBox(px, py, box), this.fillStyle);
		}
	}

	fillRect(x: number, y: number, w: number, h: number) {
		this.paint(x, y, x + w, y + h, () => true, this.fillStyle);
	}

	clearRect(x: number, y: number, w: number, h: number) {
		const op = this.globalCompositeOperation;
		this.globalCompositeOperation = 'destination-out';
		this.paint(x, y, x + w, y + h, () => true, 'transparent');
		this.globalCompositeOperation = op;
	}

	clip() {
		expect(this.path, 'clips to one shape').toHaveLength(1);
		this.clipBox = this.path[0];
	}

	drawImage(
		image: { colour: string },
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		dx: number,
		dy: number,
		dw: number,
		dh: number
	) {
		// the screen is drawn one to one, never scaled
		expect([sx, sy, sw, sh]).toEqual([0, 0, dw, dh]);
		this.paint(dx, dy, dx + dw, dy + dh, () => true, image.colour);
	}
}

const SCREEN = '#3355aa';

function painted(frame: PhoneFrame, options: { screen?: boolean; outside?: string } = {}) {
	const ctx = new FakeContext(frame.width, frame.height);
	paintPhoneFrame(ctx as unknown as FrameContext, frame, {
		screen: options.screen ? ({ colour: SCREEN } as unknown as CanvasImageSource) : undefined,
		outside: options.outside
	});
	return ctx;
}

describe('paintPhoneFrame', () => {
	// small enough to paint every pixel, shaped like a phone
	const frame = phoneFrame(46, 100, { bezelOn: true, bezel: 4, radius: 8 });

	it('paints a screenshot for the image tool: opaque border, transparent outside', () => {
		const ctx = painted(frame, { screen: true });
		expect(ctx.at(0, 0), 'outside the outer corner').toBe('transparent');
		expect(ctx.at(1, 1)).toBe('transparent');
		expect(ctx.at(frame.width - 1, frame.height - 1)).toBe('transparent');
		expect(ctx.at(1, 50), 'left border').toBe(BEZEL_COLOUR);
		expect(ctx.at(25, 1), 'top border').toBe(BEZEL_COLOUR);
		expect(ctx.at(frame.width - 2, 50), 'right border').toBe(BEZEL_COLOUR);
		expect(ctx.at(25, 50), 'middle of the screen').toBe(SCREEN);
		expect(ctx.at(4, 50), 'first column of the screen').toBe(SCREEN);
	});

	it('fills the screen’s cut corner with the border, the way a phone does', () => {
		const ctx = painted(frame, { screen: true });
		// inside the screen rectangle but outside its rounded corner
		expect(ctx.at(4, 4)).toBe(BEZEL_COLOUR);
		expect(ctx.at(frame.width - 5, frame.height - 5)).toBe(BEZEL_COLOUR);
		// and nothing is left over from before the paint anywhere
		expect(ctx.pixels.every((p) => p === 'transparent' || p === BEZEL_COLOUR || p === SCREEN)).toBe(true);
	});

	it('rounds the corners alone when the border is off', () => {
		const bare = phoneFrame(46, 100, { bezelOn: false, bezel: 4, radius: 8 });
		const ctx = painted(bare, { screen: true });
		expect(ctx.at(0, 0)).toBe('transparent');
		expect(ctx.at(bare.width - 1, 0)).toBe('transparent');
		expect(ctx.at(0, 50)).toBe(SCREEN);
		expect(ctx.at(23, 50)).toBe(SCREEN);
		expect(ctx.pixels).not.toContain(BEZEL_COLOUR);
	});

	it('paints the video overlay: see-through screen, border, background in the corners', () => {
		const ctx = painted(frame, { outside: '#ffffff' });
		expect(ctx.at(0, 0), 'outside the outer corner').toBe('#ffffff');
		expect(ctx.at(frame.width - 1, frame.height - 1)).toBe('#ffffff');
		expect(ctx.at(1, 50), 'left border').toBe(BEZEL_COLOUR);
		expect(ctx.at(25, 50), 'where the video shows').toBe('transparent');
		expect(ctx.at(4, 50)).toBe('transparent');
		expect(ctx.at(4, 4), 'the screen’s cut corner').toBe(BEZEL_COLOUR);
	});

	it('lets the video through nowhere but the screen when the outside is black', () => {
		// What a see-through video's frame is painted with. A radius this much
		// bigger than the border puts the screen's square corner past the outer
		// curve, so a frame clear outside the outline would let it through.
		const wide = evenPhoneFrame(46, 100, { bezelOn: true, bezel: 2, radius: 12 });
		const corner = Math.hypot(wide.screen.x - wide.outerRadius, wide.screen.y - wide.outerRadius);
		expect(corner).toBeGreaterThan(wide.outerRadius);
		expect(painted(wide).at(2, 2), 'clear outside, the corner shows').toBe('transparent');

		const ctx = painted(wide, { outside: BEZEL_COLOUR });
		expect(ctx.at(2, 2)).toBe(BEZEL_COLOUR);
		const hole = { x: wide.screen.x, y: wide.screen.y, w: wide.screen.width, h: wide.screen.height, r: wide.innerRadius };
		for (let y = 0; y < wide.height; y++) {
			for (let x = 0; x < wide.width; x++) {
				const p = ctx.at(x, y);
				expect(p === BEZEL_COLOUR || p === 'transparent', `${x},${y}`).toBe(true);
				expect(p === 'transparent', `${x},${y}`).toBe(insideBox(x + 0.5, y + 0.5, hole));
			}
		}
	});

	it('covers the video’s corners with the background when the border is off', () => {
		const bare = evenPhoneFrame(46, 100, { bezelOn: false, bezel: 4, radius: 8 });
		const ctx = painted(bare, { outside: '#ffffff' });
		expect(ctx.at(0, 0)).toBe('#ffffff');
		expect(ctx.at(bare.width - 1, bare.height - 1)).toBe('#ffffff');
		expect(ctx.at(23, 50)).toBe('transparent');
		expect(ctx.at(0, 50)).toBe('transparent');
		expect(ctx.pixels).not.toContain(BEZEL_COLOUR);
	});

	it('leaves a hole exactly the size of an odd video’s cropped screen', () => {
		const odd = evenPhoneFrame(45, 99, { bezelOn: true, bezel: 4, radius: 8 });
		const ctx = painted(odd, { outside: '#ffffff' });
		expect([odd.width, odd.height]).toEqual([52, 106]);
		// the screen is 44 wide from 4, so it ends at 48, and 48 to 51 is border
		expect(ctx.at(47, 50)).toBe('transparent');
		expect(ctx.at(48, 50)).toBe(BEZEL_COLOUR);
		expect(ctx.at(51, 50)).toBe(BEZEL_COLOUR);
		expect(ctx.at(25, 101)).toBe('transparent');
		expect(ctx.at(25, 102)).toBe(BEZEL_COLOUR);
	});

	it('hands the context back the way it found it', () => {
		const ctx = new FakeContext(frame.width, frame.height);
		ctx.fillStyle = '#123456';
		paintPhoneFrame(ctx as unknown as FrameContext, frame, { outside: '#ffffff' });
		expect(ctx.fillStyle).toBe('#123456');
		expect(ctx.globalCompositeOperation).toBe('source-over');
	});
});

describe('paintPhoneMask', () => {
	const maskOf = (frame: PhoneFrame) => {
		const ctx = new FakeContext(frame.width, frame.height);
		ctx.globalCompositeOperation = 'destination-out';
		paintPhoneMask(ctx as unknown as FrameContext, frame);
		return ctx;
	};

	it('is white over the whole phone and black outside its corners', () => {
		const frame = evenPhoneFrame(46, 100, { bezelOn: true, bezel: 4, radius: 8 });
		const ctx = maskOf(frame);
		expect(ctx.at(0, 0)).toBe('#000000');
		expect(ctx.at(frame.width - 1, frame.height - 1)).toBe('#000000');
		expect(ctx.at(1, 50), 'the border is part of the phone').toBe('#ffffff');
		expect(ctx.at(4, 4), 'so is the screen’s cut corner').toBe('#ffffff');
		expect(ctx.at(25, 50)).toBe('#ffffff');
		expect(ctx.pixels.every((p) => p === '#000000' || p === '#ffffff')).toBe(true);
	});

	it('cuts the screen’s own corners away when the border is off', () => {
		// the overlay cannot make the video transparent, so this is the only
		// thing that rounds a see-through video with no border
		const bare = evenPhoneFrame(46, 100, { bezelOn: false, bezel: 4, radius: 8 });
		const ctx = maskOf(bare);
		expect(ctx.at(0, 0)).toBe('#000000');
		expect(ctx.at(bare.width - 1, 0)).toBe('#000000');
		expect(ctx.at(0, 50)).toBe('#ffffff');
		expect(ctx.at(23, 50)).toBe('#ffffff');
	});

	it('matches the painted frame’s outline pixel for pixel', () => {
		for (const settings of [
			{ bezelOn: true, bezel: 4, radius: 8 },
			{ bezelOn: false, bezel: 4, radius: 12 }
		]) {
			const frame = evenPhoneFrame(45, 99, settings);
			const mask = maskOf(frame);
			const picture = painted(frame, { screen: true });
			for (let i = 0; i < mask.pixels.length; i++) {
				expect(mask.pixels[i] === '#ffffff', `pixel ${i}`).toBe(picture.pixels[i] !== 'transparent');
			}
		}
	});

	it('hands the context back the way it found it', () => {
		const frame = evenPhoneFrame(46, 100, { bezelOn: true, bezel: 4, radius: 8 });
		const ctx = maskOf(frame);
		expect(ctx.globalCompositeOperation).toBe('destination-out');
	});
});
