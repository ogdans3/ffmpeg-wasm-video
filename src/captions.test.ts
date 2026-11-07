import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTION_FILE, captionFor, filterFor, FONT_FILE, type EditOp } from './edit.js';

/**
 * Captions drawn by the real ffmpeg.wasm core, the build a browser downloads,
 * and measured in the pixels that come out.
 *
 * `edit.test.ts` checks the filter string, and the bug this file exists for
 * got past a filter string twice. Escaped inside the filter, «It's» came out
 * as «Its» and «It's, ok» failed the whole filter, while the string looked
 * exactly as intended. So each awkward character is drawn here next to the
 * same caption without it, and must come out wider.
 *
 * The harness is the one `phonepixels.test.ts` uses. The core reads
 * `self.location` when it starts, so the two are lent to it for this file.
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

const WIDTH = 640;
const HEIGHT = 96;

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
	const { default: create } = (await import(/* @vite-ignore */ pathToFileURL(js).href)) as {
		default: (options: { wasmBinary: Uint8Array }) => Promise<Core>;
	};
	core = await create({ wasmBinary: readFileSync(js.replace(/\.js$/, '.wasm')) });
	core.setLogger(({ message }) => said.push(message));

	// The font a page would pass as fontURL, and one black frame to draw on.
	core.FS.writeFile(FONT_FILE, readFileSync(new URL('../fixtures/caption.ttf', import.meta.url)));
	const black = new Uint8Array(WIDTH * HEIGHT * 1.5);
	black.fill(16, 0, WIDTH * HEIGHT);
	black.fill(128, WIDTH * HEIGHT);
	core.FS.writeFile('input.yuv', black);
}, 60_000);

afterAll(() => {
	for (const name of lent) delete (globalThis as Record<string, unknown>)[name];
});

/**
 * Draws [text] the way `editVideo` does, with the caption written to its file
 * and the filter from `filterFor`, and returns the columns that came out lit.
 */
function draw(text: string): { code: number; left: number; right: number; lit: number } {
	const op: EditOp = { kind: 'text', text, size: 32, colour: '#ffffff', position: 'centre', box: false };
	core.FS.writeFile(CAPTION_FILE, new TextEncoder().encode(captionFor(op)!));
	said = [];
	core.exec(
		'-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${WIDTH}x${HEIGHT}`, '-i', 'input.yuv',
		'-vf', filterFor(op)!,
		'-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-y', 'out.yuv'
	);
	const code = core.ret;
	core.reset();
	if (code !== 0) return { code, left: -1, right: -1, lit: 0 };
	const out = core.FS.readFile('out.yuv');
	let left = WIDTH;
	let right = -1;
	let lit = 0;
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			if (out[y * WIDTH + x] > 128) {
				lit++;
				left = Math.min(left, x);
				right = Math.max(right, x);
			}
		}
	}
	return { code, left, right, lit };
}

const width = (r: { left: number; right: number }) => r.right - r.left;

describe('captions in the real core', () => {
	it('draws the apostrophe, which the old escaping dropped', () => {
		const withIt = draw("It's");
		const without = draw('Its');
		expect(withIt.code, said.join('\n')).toBe(0);
		expect(withIt.lit).toBeGreaterThan(without.lit);
	});

	it('takes a comma after an apostrophe, which used to fail the whole filter', () => {
		const result = draw("It's, ok");
		expect(result.code, said.join('\n')).toBe(0);
		expect(width(result)).toBeGreaterThan(width(draw("It's")));
	});

	it('draws a colon, a percent and a backslash as themselves', () => {
		for (const [hard, plain] of [
			['9:30', '930'],
			['50%', '50'],
			['a\\b', 'ab']
		]) {
			const result = draw(hard);
			expect(result.code, `${hard}\n${said.join('\n')}`).toBe(0);
			expect(result.lit, hard).toBeGreaterThan(draw(plain).lit);
		}
	});

	it('draws æøå, and a whole sentence of everything at once', () => {
		expect(draw('æøå').lit).toBeGreaterThan(0);
		const all = draw("It's 9:30, 50% done \\ æøå");
		expect(all.code, said.join('\n')).toBe(0);
		expect(width(all)).toBeGreaterThan(width(draw("It's 9")));
	});
});
