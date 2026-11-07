/**
 * The speed ramp: a drawn curve saying how fast the clip runs at each moment.
 *
 * The other half of the two retiming pages. Their simple mode marks a section
 * and gives it a length, which is one speed applied to one block. This one
 * takes a curve, so the footage can ease away from its own pace, hold there,
 * and ease back, which is the shape people actually mean when they talk about
 * a slow motion shot or a clip that races through the middle.
 *
 * A curve runs in one direction only, set by its `RampRange`: the slow motion
 * page draws 0.1 to 1 and the speed up page draws 1 to 4. See RampRange for
 * why that beats one axis crossing 1 in the middle.
 *
 * Pure and tested, like `edit.ts`, and for the same reason: this is where the
 * result is decided, and none of it needs a browser to check.
 *
 * ## How a curve becomes something ffmpeg can do
 *
 * `setpts` multiplies timestamps by a constant. There is no form of it that
 * takes a curve, and `atempo`, which keeps the sound in step, only takes a
 * constant too. So the curve is sampled into a run of short constant-speed
 * pieces that are concatenated back together, exactly the way the simple mode
 * already joins its three.
 *
 * That means the smoothness is a sampling decision rather than something
 * ffmpeg does for us, which is why `sampleRamp` is careful about where it
 * spends its pieces: fine where the speed is changing, one single piece across
 * a stretch where it is not. A clip with a ramp in the middle comes out as a
 * handful of pieces, not a hundred, and the parts of it nobody touched are
 * still one unretimed segment.
 */

/** One point on the curve: at `t` seconds the clip runs at `speed` times. */
export interface RampPoint {
	t: number;
	speed: number;
}

/** A stretch of clip that runs at one constant speed. */
export interface RampSegment {
	from: number;
	to: number;
	speed: number;
}

/**
 * How far a curve may go, and which way.
 *
 * One end is always 1, the original pace, because a page that could both slow
 * down and speed up would need an axis crossing 1 in the middle: half the
 * graph would be dead space for whichever thing you actually came to do, and
 * the point somebody drags would mean two different things either side of the
 * centre line. A page picks a direction and gets the whole axis for it.
 */
export interface RampRange {
	min: number;
	max: number;
	/** Where the stock shape parks, and what the keyboard's End key reaches. */
	peak: number;
	/** Gridlines and their labels, fastest first. */
	marks: number[];
}

/**
 * Down to ten times slower. Past that the frames are so far apart the result
 * is a slideshow, and the sound has been through four instances of atempo.
 */
export const SLOWER: RampRange = {
	min: 0.1,
	max: 1,
	peak: 0.25,
	marks: [1, 0.75, 0.5, 0.25, 0.1]
};

/**
 * Up to four times faster, the same ceiling the whole-clip speed page uses.
 * Beyond that a hand held shot stops reading as motion and starts reading as a
 * cut, and the sound is three chained atempo instances deep.
 */
export const FASTER: RampRange = {
	min: 1,
	max: 4,
	peak: 3,
	marks: [4, 3, 2, 1.5, 1]
};

/** More points than this is a shape nobody is drawing on purpose. */
export const RAMP_MAX_POINTS = 12;

/**
 * The shortest piece the sampler will cut.
 *
 * Not an arbitrary round number: the sound goes through `atempo`, which works
 * on a window of samples, and slicing below roughly this leaves it too little
 * to work with at the boundaries.
 */
export const RAMP_MIN_STEP = 0.2;

/**
 * How much the speed may step between one piece and the next, as a fraction of
 * the range. Proportional rather than absolute: a fixed 0.05 is right across
 * 0.1 to 1 and absurdly fine across 1 to 4, where it would spend sixty pieces
 * on a single sweep.
 */
const RAMP_SPEED_STEP_FRACTION = 0.05;

/**
 * The ceiling on pieces in one graph. Each one is two filter chains plus a
 * concat input, and a graph runs out of usefulness long before ffmpeg runs out
 * of patience with it.
 */
export const RAMP_MAX_SEGMENTS = 64;

/** Below this two times, or two speeds, are the same time or speed. */
const EPSILON = 1e-3;

function clampSpeed(speed: number, range: RampRange): number {
	return Math.min(range.max, Math.max(range.min, speed));
}

/**
 * The curve, cleaned up: sorted, clamped, deduplicated, and defined across the
 * whole clip.
 *
 * Outside the outermost points the curve holds their value rather than running
 * off, which is what lets a ramp drawn in the middle of a clip leave both ends
 * at their own pace without anybody having to place a point there.
 */
export function normaliseRamp(
	points: RampPoint[],
	duration: number | null,
	range: RampRange = SLOWER
): RampPoint[] {
	const usable = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.speed));
	const span =
		duration !== null && Number.isFinite(duration) && duration > 0
			? duration
			: // No duration to work from means trusting the curve about its own
				// extent, which is what the panel would have drawn it against.
				Math.max(RAMP_MIN_STEP, ...usable.map((p) => p.t));

	const sorted = usable
		.map((p) => ({ t: Math.min(Math.max(0, p.t), span), speed: clampSpeed(p.speed, range) }))
		.sort((a, b) => a.t - b.t);

	const out: RampPoint[] = [];
	for (const point of sorted) {
		const last = out[out.length - 1];
		// Two points at the same instant would make the curve vertical. The
		// later one wins, because it is the one being dragged onto the other.
		if (last && point.t - last.t < EPSILON) out[out.length - 1] = point;
		else out.push(point);
	}

	if (out.length === 0) {
		return [
			{ t: 0, speed: 1 },
			{ t: span, speed: 1 }
		];
	}

	if (out[0].t > EPSILON) out.unshift({ t: 0, speed: out[0].speed });
	else out[0] = { t: 0, speed: out[0].speed };

	const last = out[out.length - 1];
	if (last.t < span - EPSILON) out.push({ t: span, speed: last.speed });
	else out[out.length - 1] = { t: span, speed: last.speed };

	return out;
}

/**
 * The speed at one instant, eased between the points either side of it.
 *
 * Smoothstep rather than a straight line. A speed that starts and stops
 * changing abruptly reads as a glitch even when the numbers are right, and
 * easing in and out of the change is the whole difference between a ramp that
 * looks deliberate and one that looks like a dropped frame. Between two points
 * at the same speed it is flat either way, so a hold stays a hold.
 */
export function speedAt(points: RampPoint[], t: number): number {
	if (points.length === 0) return 1;
	if (t <= points[0].t) return points[0].speed;
	const last = points[points.length - 1];
	if (t >= last.t) return last.speed;

	for (let i = 1; i < points.length; i++) {
		const b = points[i];
		if (t > b.t) continue;
		const a = points[i - 1];
		const span = b.t - a.t;
		if (span <= 0) return b.speed;
		const u = (t - a.t) / span;
		return a.speed + (b.speed - a.speed) * (u * u * (3 - 2 * u));
	}
	return last.speed;
}

/**
 * The furthest the curve gets from the original pace, for the readout. The
 * slowest point on a slow curve and the fastest on a fast one, which is the
 * same question asked once rather than twice.
 */
export function rampPeak(points: RampPoint[]): number {
	return points.reduce((far, p) => (Math.abs(p.speed - 1) > Math.abs(far - 1) ? p.speed : far), 1);
}

/**
 * The curve, cut into constant-speed pieces.
 *
 * Pieces are spent where the speed is moving and saved where it is not, so the
 * untouched head and tail of a clip come back as one segment each however long
 * they are. That matters for more than graph size: a segment at exactly 1 gets
 * no `setpts` multiplier and no `atempo` at all, so the parts nobody asked to
 * change are passed through with their own timing.
 */
export function sampleRamp(
	points: RampPoint[],
	duration: number | null,
	range: RampRange = SLOWER,
	maxSegments: number = RAMP_MAX_SEGMENTS
): RampSegment[] {
	// A clip whose length reads as zero has not loaded its metadata yet. Null
	// means "unknown, trust the curve", which is not the same thing, and
	// inventing a segment from a duration of nothing would be an edit nobody
	// asked for.
	if (duration !== null && !(duration > 0)) return [];

	const curve = normaliseRamp(points, duration, range);
	const span = curve[curve.length - 1].t;
	if (span <= EPSILON) return [];

	const intervals: { from: number; length: number; pieces: number }[] = [];
	for (let i = 1; i < curve.length; i++) {
		const a = curve[i - 1];
		const b = curve[i];
		const length = b.t - a.t;
		if (length <= EPSILON) continue;
		const delta = Math.abs(b.speed - a.speed);
		// A flat interval is one piece however long it runs. A changing one is
		// cut fine enough that the step between pieces stays small, but never
		// so fine that a piece drops below what atempo can work with.
		const step = Math.max(0.02, (range.max - range.min) * RAMP_SPEED_STEP_FRACTION);
		const wanted = delta < EPSILON ? 1 : Math.ceil(delta / step);
		const room = Math.max(1, Math.floor(length / RAMP_MIN_STEP));
		intervals.push({ from: a.t, length, pieces: Math.max(1, Math.min(wanted, room)) });
	}
	if (intervals.length === 0) return [];

	// Shave the greediest interval until the whole graph fits. Taking it off
	// the largest rather than scaling everything down keeps a short sharp ramp
	// detailed when it shares a clip with a long gentle one.
	let total = intervals.reduce((n, iv) => n + iv.pieces, 0);
	const cap = Math.max(intervals.length, maxSegments);
	while (total > cap) {
		const worst = intervals.reduce((m, iv) => (iv.pieces > m.pieces ? iv : m));
		if (worst.pieces <= 1) break;
		worst.pieces--;
		total--;
	}

	const raw: RampSegment[] = [];
	for (const iv of intervals) {
		for (let k = 0; k < iv.pieces; k++) {
			const from = iv.from + (iv.length * k) / iv.pieces;
			const to = iv.from + (iv.length * (k + 1)) / iv.pieces;
			raw.push({
				from,
				to,
				// Rounded, so two pieces that are the same speed to any degree
				// that matters compare equal and get merged below.
				speed: Number(speedAt(curve, (from + to) / 2).toFixed(4))
			});
		}
	}

	const merged: RampSegment[] = [];
	for (const segment of raw) {
		const last = merged[merged.length - 1];
		if (last && Math.abs(last.speed - segment.speed) < EPSILON) last.to = segment.to;
		else merged.push({ ...segment });
	}
	return merged;
}

/** How long the clip runs once the curve has been applied. */
export function rampTotal(segments: RampSegment[]): number {
	return segments.reduce((sum, s) => sum + (s.to - s.from) / s.speed, 0);
}

/**
 * The curve a clip opens with: normal, ease away, hold, ease back, normal.
 *
 * The shape somebody is describing when they say they want slow motion, or a
 * clip that speeds through the middle, ready to be dragged rather than built
 * from a flat line. `range.peak` is how far it goes: far enough to read as an
 * effect, not so far that ordinary footage falls apart.
 */
export function defaultRamp(duration: number, range: RampRange = SLOWER): RampPoint[] {
	const span = Math.max(duration, RAMP_MIN_STEP * 5);
	const middle = span / 2;
	const ease = Math.min(span * 0.18, 1.5);
	const hold = Math.min(span * 0.24, 2);
	return normaliseRamp(
		[
			{ t: 0, speed: 1 },
			{ t: middle - hold / 2 - ease, speed: 1 },
			{ t: middle - hold / 2, speed: range.peak },
			{ t: middle + hold / 2, speed: range.peak },
			{ t: middle + hold / 2 + ease, speed: 1 },
			{ t: span, speed: 1 }
		],
		span,
		range
	);
}

/** True when the curve asks for nothing, so there is no edit to run. */
export function rampIsFlat(points: RampPoint[]): boolean {
	return points.every((p) => Math.abs(p.speed - 1) < EPSILON);
}
