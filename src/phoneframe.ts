/**
 * A phone frame: a screenshot or a screen recording with its corners rounded
 * and a black border around it, so it reads as a phone.
 *
 * One module for both a still image and a video, so the two
 * can never disagree about what a phone looks like. It is pure apart from the
 * painter, and the painter only needs the handful of context methods listed in
 * `FrameContext`, so all of it runs under vitest.
 *
 * The API, in the order a caller uses it:
 *
 *   phoneFrameDefaults(w, h, opts)     { bezel, radius } in px, sized like a phone
 *   phoneFrameLimits(w, h, opts)       { bezelMax, radiusMax } for the sliders
 *   phoneFrame(w, h, settings)         PhoneFrame: output size, screen rect, radii
 *   evenPhoneFrame(w, h, settings)     the same on the grid video needs, for H.264
 *   paintPhoneFrame(ctx, frame, opts)  draws it onto a 2D context
 *   paintPhoneMask(ctx, frame)         white where the phone is, for see-through video
 *
 * Image tool: `phoneFrame`, then `paintPhoneFrame` with `screen` set to the
 * decoded picture and no `outside`, so the corners stay transparent.
 *
 * Video tool: `evenPhoneFrame`, then `paintPhoneFrame` with no `screen` and
 * `outside` set to the background colour, onto a canvas of `frame.width` by
 * `frame.height`. That gives one PNG which is opaque where the border and the
 * corners are and see-through exactly where the video goes. ffmpeg crops the
 * video to `frame.screen`'s size, pads it out to the frame's at
 * `frame.screen.x`, `frame.screen.y` and lays the PNG over it. A see-through
 * video leaves `outside` out and takes its alpha from `paintPhoneMask`.
 * `phoneFrameGraph` in `src/lib/video/edit.ts` builds the filter graph.
 *
 * The screenshot is never scaled. The output is the input plus the border on
 * every side, so every pixel of the screen is the one that was captured, and
 * the border and the radius are in the input's own pixels.
 */

/**
 * The screen's corner radius as a share of its width, from a current iPhone
 * Pro: 55 points of corner on a screen 393 points wide, about 14 percent.
 * Measured on the short side, so a landscape capture gets the same phone.
 */
export const SCREEN_RADIUS_RATIO = 55 / 393;

/**
 * The black border as a share of the screen's width, from the same phone:
 * 2.75 mm of border on a screen 65.1 mm wide, about 4.2 percent.
 */
export const BEZEL_RATIO = 2.75 / 65.1;

/**
 * Pure black, not the near black of a phone's body. The border round a lit
 * screen reads as black glass, and on an OLED phone a dark mode app's black is
 * a switched-off pixel that looks the same, so the two run together with no
 * line between them. Any lighter black would draw that line round every dark
 * screenshot, which is the one place a real phone never shows one.
 */
export const BEZEL_COLOUR = '#000000';

export interface PhoneFrameSettings {
	/** Whether there is a border at all. Off leaves only the rounded corners. */
	bezelOn: boolean;
	/** Border thickness in px of the input. Ignored while `bezelOn` is false. */
	bezel: number;
	/** The screen's corner radius in px, clamped to half its shorter side. */
	radius: number;
}

export interface PhoneFrame {
	/** The whole output, border included. */
	width: number;
	height: number;
	/**
	 * Where the input sits in the output, at its own size. In the even version
	 * it can be one pixel narrower or shorter than the input, which means crop.
	 */
	screen: { x: number; y: number; width: number; height: number };
	/** Border thickness on the left and the top, 0 when the border is off. */
	bezel: number;
	/** The screen's corner radius, after clamping. */
	innerRadius: number;
	/**
	 * The outside corner: the screen's radius plus the border, so the curve of
	 * the frame runs parallel to the curve of the screen and the two read as one
	 * piece. Equal to `innerRadius` when the border is off.
	 */
	outerRadius: number;
}

/** A non-negative whole number of pixels, whatever was typed. */
function px(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/**
 * A border of whole pixel pairs, rounded up so a 1 px border does not vanish.
 * See `evenPhoneFrame` for why video needs it.
 */
function evenBezel(value: number): number {
	const bezel = px(value);
	return bezel + (bezel % 2);
}

export interface SizeOptions {
	/**
	 * Borders in whole pixel pairs, for the video page. `evenPhoneFrame` would
	 * round an odd border up anyway, and asking for even numbers here is what
	 * keeps the number in the box the number in the file.
	 */
	even?: boolean;
}

/** Starting values for an input of this size, in its own pixels. */
export function phoneFrameDefaults(
	width: number,
	height: number,
	options: SizeOptions = {}
): { bezel: number; radius: number } {
	const short = Math.min(px(width), px(height));
	const bezel = Math.max(1, Math.round(short * BEZEL_RATIO));
	return {
		bezel: options.even ? evenBezel(bezel) : bezel,
		radius: Math.round(short * SCREEN_RADIUS_RATIO)
	};
}

/**
 * Slider ranges, shared so both pages offer the same ones. A radius past half
 * the short side has nothing left to round, and a border past a fifth of it
 * is a picture frame rather than a phone.
 */
export function phoneFrameLimits(
	width: number,
	height: number,
	options: SizeOptions = {}
): { bezelMax: number; radiusMax: number } {
	const short = Math.min(px(width), px(height));
	const bezelMax = Math.max(20, Math.round(short / 5));
	return {
		// Down rather than up, so the top of the slider is still inside the range.
		bezelMax: options.even ? bezelMax - (bezelMax % 2) : bezelMax,
		radiusMax: Math.floor(short / 2)
	};
}

/** The frame for an input of this size, with the screen at its own size. */
export function phoneFrame(width: number, height: number, settings: PhoneFrameSettings): PhoneFrame {
	return build(px(width), px(height), settings, false);
}

/**
 * The same frame on the grid a video needs, which is two things.
 *
 * An even width and height, which H.264 in yuv420p insists on. The border goes
 * on both sides, so it cannot change whether the total is odd: that is decided
 * by the input alone. So an odd input gives up its last column or its last
 * row, with the border on or off, and `screen.width` or `screen.height` comes
 * back one smaller than the input as the signal to crop. The border stays the
 * same on all four sides, and the output is the cropped screen plus twice the
 * border.
 *
 * The first version kept that pixel and put one extra pixel of border on the
 * right and at the bottom instead. ffmpeg can't place it there. Its crop and
 * pad both round a yuv420p picture down to even without saying so, so a
 * 461 × 1001 recording went in as 460 × 1000 and the frame's 461 × 1001 hole
 * showed the pad's black along its last column and row, read out of a real
 * encode as (15, 15, 15) where the screen should have been. Keeping the pixel
 * would take the whole video through 4:4:4 and back, and even then the kept
 * column would share its colour samples with the black border beside it.
 *
 * And an even border, rounded up by at most 1 px. yuv420p stores colour once
 * per 2 × 2 block, so ffmpeg's pad and overlay both round a position down to
 * an even number without saying so. With a 19 px border the video landed at
 * x = 18 while the painted frame left its hole at 19, and the last column of
 * the screen came out as a 1 px line of the background colour down the right
 * edge and along the bottom. Found by reading pixels out of a real encode.
 */
export function evenPhoneFrame(
	width: number,
	height: number,
	settings: PhoneFrameSettings
): PhoneFrame {
	return build(px(width), px(height), settings, true);
}

function build(w: number, h: number, settings: PhoneFrameSettings, even: boolean): PhoneFrame {
	const asked = settings.bezelOn ? px(settings.bezel) : 0;
	const bezel = even ? evenBezel(asked) : asked;
	// On the video grid an odd side loses its last pixel, border or not.
	const screenW = even ? w - (w % 2) : w;
	const screenH = even ? h - (h % 2) : h;
	const innerRadius = Math.min(px(settings.radius), Math.floor(Math.min(screenW, screenH) / 2));
	return {
		width: screenW + bezel * 2,
		height: screenH + bezel * 2,
		screen: { x: bezel, y: bezel, width: screenW, height: screenH },
		bezel,
		innerRadius,
		outerRadius: innerRadius + bezel
	};
}

/**
 * What `paintPhoneFrame` needs from a 2D context. Both the DOM and the
 * offscreen canvas contexts fit it, and so does a test's fake.
 */
export type FrameContext = Pick<
	CanvasRenderingContext2D,
	| 'save'
	| 'restore'
	| 'beginPath'
	| 'roundRect'
	| 'fill'
	| 'fillRect'
	| 'clearRect'
	| 'clip'
	| 'drawImage'
	| 'fillStyle'
	| 'globalCompositeOperation'
>;

export interface PaintOptions {
	/**
	 * The screenshot, drawn into the screen at its own size and clipped to its
	 * corners. Leave it out for the video overlay, and the screen is left
	 * see-through for the video underneath to show.
	 */
	screen?: CanvasImageSource;
	/**
	 * Colour for everything outside the frame's rounded outline. Leave it out
	 * to keep that transparent, which is what an image wants. A video passes
	 * its background colour, because MP4 has no transparency to keep.
	 */
	outside?: string;
	/** Defaults to `BEZEL_COLOUR`. */
	bezelColour?: string;
}

/**
 * Paint the frame onto `ctx`, which must already be `frame.width` by
 * `frame.height`.
 *
 * The border is painted as the whole rounded body rather than as a ring, and
 * the screen goes on top of it. Painting a ring and a screen that meet along
 * the same curve leaves both of them antialiased on that curve, and the pixels
 * they share end up partly see-through: a faint light seam around the inside
 * corners. On top of solid black, the screen's soft edge blends into black and
 * nothing shows through.
 */
export function paintPhoneFrame(ctx: FrameContext, frame: PhoneFrame, options: PaintOptions = {}): void {
	const { screen, outside, bezelColour = BEZEL_COLOUR } = options;
	const { width, height, innerRadius, outerRadius } = frame;
	const s = frame.screen;

	ctx.save();
	ctx.clearRect(0, 0, width, height);
	if (outside) {
		ctx.fillStyle = outside;
		ctx.fillRect(0, 0, width, height);
	}
	if (frame.bezel > 0) {
		ctx.fillStyle = bezelColour;
		ctx.beginPath();
		ctx.roundRect(0, 0, width, height, outerRadius);
		ctx.fill();
	}

	ctx.beginPath();
	ctx.roundRect(s.x, s.y, s.width, s.height, innerRadius);
	if (screen) {
		ctx.clip();
		ctx.drawImage(screen, 0, 0, s.width, s.height, s.x, s.y, s.width, s.height);
	} else {
		// Punch the screen out, so the overlay is see-through exactly where the
		// video goes and the video's own corners are covered by what is around.
		ctx.globalCompositeOperation = 'destination-out';
		ctx.fillStyle = '#000000';
		ctx.fill();
	}
	ctx.restore();
}

/**
 * White where the phone is and black everywhere else, for a video with
 * see-through corners.
 *
 * The overlay can only paint over the video, never make any of it transparent,
 * so with the border off nothing would cut the video's own corners away. This
 * is the shape ffmpeg's `alphamerge` takes the alpha channel from instead: the
 * whole rounded body, which is the screen alone when there is no border.
 */
export function paintPhoneMask(ctx: FrameContext, frame: PhoneFrame): void {
	ctx.save();
	ctx.globalCompositeOperation = 'source-over';
	ctx.fillStyle = '#000000';
	ctx.fillRect(0, 0, frame.width, frame.height);
	ctx.fillStyle = '#ffffff';
	ctx.beginPath();
	ctx.roundRect(0, 0, frame.width, frame.height, frame.outerRadius);
	ctx.fill();
	ctx.restore();
}
