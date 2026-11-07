import { describe, expect, it } from 'vitest';
import { formatTimecode, parseTimecode } from './timecode';

describe('parseTimecode', () => {
	it('reads the shape a player shows', () => {
		expect(parseTimecode('2:32')).toBe(152);
		expect(parseTimecode('3:42')).toBe(222);
		expect(parseTimecode('1:02:03')).toBe(3723);
	});

	it('takes plain seconds, since that is what people type for a length', () => {
		expect(parseTimecode('1000')).toBe(1000);
		expect(parseTimecode('12.5')).toBe(12.5);
	});

	it('keeps the fraction on the seconds field', () => {
		expect(parseTimecode('2:32.4')).toBeCloseTo(152.4, 6);
		expect(parseTimecode('1:00:00.5')).toBeCloseTo(3600.5, 6);
	});

	it('is null for anything that is not a time, including an empty box', () => {
		for (const bad of ['', '  ', 'abc', '2:', ':30', '2:75', '1:2:3:4', '-5', '2,5']) {
			expect(parseTimecode(bad), bad).toBeNull();
		}
	});

	it('does not confuse an empty box with zero', () => {
		expect(parseTimecode('0')).toBe(0);
		expect(parseTimecode('')).toBeNull();
	});
});

describe('formatTimecode', () => {
	it('writes minutes and seconds, padded', () => {
		expect(formatTimecode(152.4)).toBe('2:32.4');
		expect(formatTimecode(5)).toBe('0:05.0');
		expect(formatTimecode(65)).toBe('1:05.0');
	});

	it('adds hours only once there are any', () => {
		expect(formatTimecode(3723)).toBe('1:02:03.0');
		expect(formatTimecode(3599.9)).toBe('59:59.9');
	});

	it('never shows a negative time', () => {
		expect(formatTimecode(-4)).toBe('0:00.0');
	});

	it('round trips through the parser, which is the whole point', () => {
		for (const seconds of [0, 0.5, 5, 65, 152.4, 999.9, 3723.5]) {
			expect(parseTimecode(formatTimecode(seconds)), String(seconds)).toBeCloseTo(seconds, 1);
		}
	});
});
