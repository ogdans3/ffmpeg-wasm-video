import { describe, expect, it } from 'vitest';
import {
	ALL_VIDEO_FORMATS,
	VIDEO_FORMATS,
	VIDEO_SOURCES,
	VIDEO_TARGETS,
	resolveVideoFormat,
	videoAcceptAttribute
} from './formats';

describe('video formats', () => {
	it('reads five containers and writes seven targets', () => {
		expect(VIDEO_SOURCES.map((f) => f.id)).toEqual(['mp4', 'mov', 'webm', 'mkv', 'avi']);
		expect(VIDEO_TARGETS.map((f) => f.id)).toEqual([
			'mp4',
			'mov',
			'webm',
			'mkv',
			'avi',
			'gif',
			'mp3'
		]);
	});

	it('resolves ids, aliases and extensions', () => {
		expect(resolveVideoFormat('mp4')?.id).toBe('mp4');
		expect(resolveVideoFormat('m4v')?.id).toBe('mp4');
		expect(resolveVideoFormat('.mov')?.id).toBe('mov');
		expect(resolveVideoFormat('MKV')?.id).toBe('mkv');
		expect(resolveVideoFormat('nope')).toBeNull();
	});

	it('gives every writable container something to encode with', () => {
		for (const format of VIDEO_TARGETS) {
			if (format.kind === 'video') {
				expect(format.videoCodec, format.id).toBeTruthy();
				expect(format.audioCodec, format.id).toBeTruthy();
			}
			if (format.kind === 'audio') expect(format.audioCodec, format.id).toBeTruthy();
		}
	});

	it('knows WebM will not hold H.264, which is the slow conversion', () => {
		expect(VIDEO_FORMATS.webm.copyableVideoCodecs).not.toContain('h264');
		// and Matroska will hold anything, which is why it is always instant
		for (const codec of ['h264', 'vp8', 'vp9', 'av1']) {
			expect(VIDEO_FORMATS.mkv.copyableVideoCodecs).toContain(codec);
		}
	});

	it('offers an accept list covering every readable container', () => {
		const accept = videoAcceptAttribute();
		for (const format of VIDEO_SOURCES) {
			expect(accept, format.id).toContain(format.extensions[0]);
			expect(accept, format.id).toContain(format.mime);
		}
		expect(accept).not.toContain('.gif');
	});

	it('respects the copy style in every blurb', () => {
		for (const format of ALL_VIDEO_FORMATS) {
			expect(format.blurb, format.id).not.toContain('—');
			expect(format.blurb, format.id).not.toContain(';');
			expect(format.blurb.length, format.id).toBeGreaterThan(40);
		}
	});
});
