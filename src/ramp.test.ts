import { describe, expect, it } from 'vitest';
import {
	defaultRamp,
	normaliseRamp,
	FASTER,
	RAMP_MAX_SEGMENTS,
	RAMP_MIN_STEP,
	rampIsFlat,
	rampPeak,
	rampTotal,
	sampleRamp,
	SLOWER,
	speedAt,
	type RampPoint
} from './ramp';

const ramp = (...pairs: [number, number][]): RampPoint[] =>
	pairs.map(([t, speed]) => ({ t, speed }));

describe('normaliseRamp', () => {
	it('sorts, clamps and spans the whole clip', () => {
		const out = normaliseRamp(ramp([6, 0.5], [2, 9], [4, -3]), 10);
		expect(out.map((p) => p.t)).toEqual([0, 2, 4, 6, 10]);
		expect(out.map((p) => p.speed)).toEqual([SLOWER.max, SLOWER.max, SLOWER.min, 0.5, 0.5]);
	});

	it('holds the outermost values rather than running off the ends', () => {
		// A ramp drawn in the middle must leave both ends alone without anybody
		// having to place a point at 0 and at the duration.
		const out = normaliseRamp(ramp([4, 0.25], [6, 0.25]), 10);
		expect(out[0]).toEqual({ t: 0, speed: 0.25 });
		expect(out[out.length - 1]).toEqual({ t: 10, speed: 0.25 });
	});

	it('collapses two points at the same instant, keeping the later one', () => {
		// Dragging one point onto another would otherwise leave the curve
		// vertical, and speedAt would have to pick between two answers. It also
		// means a step change is not expressible, which is deliberate: this mode
		// draws ramps, and the simple mode is the one that does square edges.
		const out = normaliseRamp(ramp([0, 1], [5, 0.8], [5.0001, 0.3], [10, 1]), 10);
		expect(out).toHaveLength(3);
		expect(out[1].speed).toBe(0.3);
	});

	it('survives an empty curve and a clip with no readable duration', () => {
		expect(normaliseRamp([], 10)).toEqual([
			{ t: 0, speed: 1 },
			{ t: 10, speed: 1 }
		]);
		const noDuration = normaliseRamp(ramp([0, 1], [4, 0.5]), null);
		expect(noDuration[noDuration.length - 1].t).toBe(4);
	});

	it('drops values that are not numbers', () => {
		const dirty = [{ t: Number.NaN, speed: 0.5 }, { t: 2, speed: Number.NaN }, ...ramp([3, 0.5])];
		expect(normaliseRamp(dirty, 6)).toEqual([
			{ t: 0, speed: 0.5 },
			{ t: 3, speed: 0.5 },
			{ t: 6, speed: 0.5 }
		]);
	});
});

describe('speedAt', () => {
	const curve = normaliseRamp(ramp([0, 1], [2, 1], [4, 0.25], [6, 0.25], [8, 1], [10, 1]), 10);

	it('holds flat sections exactly, so a hold is a hold', () => {
		expect(speedAt(curve, 0)).toBe(1);
		expect(speedAt(curve, 1)).toBe(1);
		expect(speedAt(curve, 5)).toBe(0.25);
		expect(speedAt(curve, 10)).toBe(1);
	});

	it('eases rather than running in a straight line', () => {
		// Smoothstep: the halfway point matches a straight line, but a quarter
		// of the way in the change has barely started. That is what stops a
		// ramp reading as a dropped frame.
		expect(speedAt(curve, 3)).toBeCloseTo(0.625, 6);
		const linearQuarter = 1 + (0.25 - 1) * 0.25;
		expect(speedAt(curve, 2.5)).toBeGreaterThan(linearQuarter);
	});

	it('holds its end values outside the curve', () => {
		expect(speedAt(curve, -5)).toBe(1);
		expect(speedAt(curve, 99)).toBe(1);
		expect(speedAt([], 3)).toBe(1);
	});
});

describe('sampleRamp', () => {
	it('spends no pieces on the parts nobody touched', () => {
		// The head and the tail are one segment each however long they run, and
		// at exactly 1 so they are passed through without being retimed.
		const segments = sampleRamp(ramp([0, 1], [20, 1], [22, 0.25], [24, 0.25], [26, 1], [60, 1]), 60);
		expect(segments[0]).toMatchObject({ from: 0, to: 20, speed: 1 });
		expect(segments[segments.length - 1]).toMatchObject({ to: 60, speed: 1 });
	});

	it('covers the clip end to end with no gaps and no overlaps', () => {
		const segments = sampleRamp(defaultRamp(12), 12);
		expect(segments[0].from).toBe(0);
		expect(segments[segments.length - 1].to).toBeCloseTo(12, 6);
		for (let i = 1; i < segments.length; i++) {
			expect(segments[i].from).toBeCloseTo(segments[i - 1].to, 9);
		}
	});

	it('cuts a changing section finely and a flat one not at all', () => {
		const changing = sampleRamp(ramp([0, 1], [10, 0.1]), 10);
		expect(changing.length).toBeGreaterThan(5);
		expect(sampleRamp(ramp([0, 0.5], [10, 0.5]), 10)).toHaveLength(1);
	});

	it('never cuts a piece shorter than atempo can work with', () => {
		// A steep ramp across a very short span asks for more pieces than there
		// is room for, and the room has to win.
		for (const segment of sampleRamp(ramp([0, 1], [1, 0.1]), 1)) {
			expect(segment.to - segment.from).toBeGreaterThanOrEqual(RAMP_MIN_STEP - 1e-9);
		}
	});

	it('stays inside the segment budget however busy the curve is', () => {
		const busy: RampPoint[] = [];
		for (let i = 0; i <= 10; i++) busy.push({ t: i * 30, speed: i % 2 ? 1 : 0.1 });
		const segments = sampleRamp(busy, 300);
		expect(segments.length).toBeLessThanOrEqual(RAMP_MAX_SEGMENTS);
		expect(segments.length).toBeGreaterThan(10);
	});

	it('merges neighbours that landed on the same speed', () => {
		// Without the merge a long hold in the middle of a ramp would come back
		// as a run of identical pieces, each one its own pair of filters.
		const held = sampleRamp(ramp([0, 1], [2, 0.25], [20, 0.25], [22, 1]), 22);
		const hold = held.filter((s) => Math.abs(s.speed - 0.25) < 1e-9);
		expect(hold).toHaveLength(1);
		expect(hold[0].to - hold[0].from).toBeGreaterThan(15);
	});

	it('gives nothing back before the clip has a readable length', () => {
		// The panel calls this while the preview is still loading its metadata,
		// where the duration reads as zero. A segment invented from nothing
		// would be an edit nobody asked for.
		expect(sampleRamp(ramp([0, 0.5]), 0)).toEqual([]);
		expect(sampleRamp(ramp([0, 0.5]), -1)).toEqual([]);
	});
});

describe('rampTotal', () => {
	it('adds up what the curve does to the running time', () => {
		// Ten seconds at half speed is twenty, plus ten untouched.
		const segments = [
			{ from: 0, to: 10, speed: 1 },
			{ from: 10, to: 20, speed: 0.5 }
		];
		expect(rampTotal(segments)).toBe(30);
	});

	/**
	 * The invariant that matters about sampling. Cutting a curve into
	 * constant-speed blocks is an approximation, and one that drifted would
	 * quietly make every ramped clip come out the wrong length. Checked against
	 * a fine numerical integral of 1/speed rather than a hand-written number,
	 * so it holds for any shape rather than for the one that got written down.
	 */
	it('neither gains nor loses time against the curve it came from', () => {
		const shapes: RampPoint[][] = [
			defaultRamp(10),
			ramp([0, 1], [3, 0.2], [7, 0.2], [10, 1]),
			ramp([0, 0.4], [10, 1]),
			ramp([0, 1], [1, 0.1], [2, 1], [9, 1], [9.5, 0.3], [10, 1])
		];
		for (const shape of shapes) {
			const curve = normaliseRamp(shape, 10);
			const steps = 20000;
			let exact = 0;
			for (let i = 0; i < steps; i++) exact += 10 / steps / speedAt(curve, ((i + 0.5) * 10) / steps);
			expect(rampTotal(sampleRamp(shape, 10)), JSON.stringify(shape)).toBeCloseTo(exact, 0);
		}
	});
});

describe('defaultRamp', () => {
	it('is the shape people mean by slow motion: down, hold, back', () => {
		const curve = defaultRamp(10);
		expect(curve[0]).toEqual({ t: 0, speed: 1 });
		expect(curve[curve.length - 1].speed).toBe(1);
		expect(rampPeak(curve)).toBe(0.25);
		expect(rampIsFlat(curve)).toBe(false);
	});

	it('holds together on a clip too short for the shape it wants', () => {
		const curve = defaultRamp(0.4);
		expect(curve.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < curve.length; i++) expect(curve[i].t).toBeGreaterThan(curve[i - 1].t);
		expect(sampleRamp(curve, 0.4).length).toBeGreaterThanOrEqual(1);
	});
});

describe('rampIsFlat', () => {
	it('knows when the curve is asking for nothing', () => {
		expect(rampIsFlat(defaultRamp(10))).toBe(false);
		expect(rampIsFlat(ramp([0, 1], [10, 1]))).toBe(true);
	});
});

describe('a curve that runs the other way', () => {
	it('clamps to its own range rather than to the slow one', () => {
		const out = normaliseRamp(ramp([0, 1], [5, 9], [10, 0.2]), 10, FASTER);
		expect(out.map((p) => p.speed)).toEqual([FASTER.min, FASTER.max, FASTER.min]);
	});

	it('opens on a shape that speeds up rather than slows down', () => {
		const curve = defaultRamp(10, FASTER);
		expect(curve[0].speed).toBe(1);
		expect(rampPeak(curve)).toBe(FASTER.peak);
		expect(rampIsFlat(curve)).toBe(false);
	});

	it('makes the clip shorter, where the slow range makes it longer', () => {
		const quick = rampTotal(sampleRamp(defaultRamp(10, FASTER), 10, FASTER));
		const slow = rampTotal(sampleRamp(defaultRamp(10, SLOWER), 10, SLOWER));
		expect(quick).toBeLessThan(10);
		expect(slow).toBeGreaterThan(10);
	});

	it('spends its pieces in proportion to the range, not a fixed step', () => {
		// A fixed 0.05 step is right across 0.1 to 1 and absurd across 1 to 4,
		// where a single sweep would eat sixty pieces of the budget.
		const sweep = sampleRamp([{ t: 0, speed: 1 }, { t: 10, speed: 4 }], 10, FASTER);
		expect(sweep.length).toBeLessThanOrEqual(RAMP_MAX_SEGMENTS);
		expect(sweep.length).toBeGreaterThan(5);
		expect(sweep.length).toBeLessThan(30);
	});

	it('still neither gains nor loses time against its curve', () => {
		const curve = normaliseRamp(defaultRamp(10, FASTER), 10, FASTER);
		const steps = 20000;
		let exact = 0;
		for (let i = 0; i < steps; i++) exact += 10 / steps / speedAt(curve, ((i + 0.5) * 10) / steps);
		expect(rampTotal(sampleRamp(defaultRamp(10, FASTER), 10, FASTER))).toBeCloseTo(exact, 0);
	});
});
