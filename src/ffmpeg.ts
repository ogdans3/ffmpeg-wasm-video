import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { VideoFormat } from './formats';
import {
	FONT_FILE,
	needsFont,
	PHONE_FRAME_FILE,
	PHONE_MASK_FILE,
	phoneLayout,
	phoneOverlayOutside,
	planEdit,
	STILL_FILE,
	stillArgs,
	stillColour,
	type EditOp,
	type EditOptions
} from './edit';
import { paintPhoneFrame, paintPhoneMask, type PhoneFrame } from './phoneframe';
import { readFileColourTag } from './colourtag';
import { fallbackPlan, planConversion, type PlanOptions, type ProbeResult } from './plan';
import {
	copyPlan,
	encodeArgs,
	inputName,
	joinLooksComplete,
	LIST_FILE,
	listFileContents
} from './merge';
import { looksReadable, parseProbe } from './probe';
import {
	FRAME_FORMATS,
	FRAME_MAX,
	frameCount,
	planFrames,
	tooManyFrames,
	type FrameRequest
} from './frames';

/**
 * The only part of the video section that touches a browser.
 *
 * ffmpeg is 32MB of WebAssembly, about 7MB over the wire once brotli has had
 * it, so it is never loaded until someone actually drops a video, and the
 * download is reported rather than hidden behind a spinner that looks broken.
 */

/**
 * Where the core lives. ffmpeg-core.js and ffmpeg-core.wasm from
 * `@ffmpeg/core`, served from your own origin: ffmpeg loads the core inside a
 * worker with importScripts, and a cross-origin or blob URL fails there with
 * "failed to import ffmpeg-core.js". Put the version in the path and the
 * files can be cached for a year instead of downloaded again after every
 * deploy.
 */
export interface CoreUrls {
	coreURL: string;
	wasmURL: string;
	/**
	 * A TrueType font for the `text` edit. Only fetched the first time a
	 * caption is drawn, and only needed if you offer captions at all.
	 */
	fontURL?: string;
}

/** The name the file has inside ffmpeg's own filesystem. */
const INPUT = 'input';

export interface LoadProgress {
	/** 0 to 1, or null while the size is still unknown. */
	ratio: number | null;
	loadedBytes: number;
	totalBytes: number | null;
}

let instance: FFmpeg | null = null;
let fontURL: string | undefined;
let loading: Promise<FFmpeg> | null = null;
let logLines: string[] = [];

/**
 * The tail of what ffmpeg last said.
 *
 * ffmpeg reports a refused filter or an unreadable font on its log and then
 * exits, so "ffmpeg could not apply that edit" throws away the only sentence
 * that would tell anybody what went wrong. This is what puts it back, both in
 * the message a visitor sees and in a browser test.
 */
export function lastFfmpegLines(count = 6): string[] {
	return logLines.slice(-count);
}

/** True once the core is in memory, so the UI can stop warning about the wait. */
export function isLoaded(): boolean {
	return instance !== null;
}

/**
 * Fetch the core ourselves rather than letting ffmpeg do it, purely so the
 * download can be reported. Seven megabytes with no feedback reads as a hang.
 */
async function fetchWithProgress(url: string, onProgress: (p: LoadProgress) => void): Promise<Blob> {
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`Could not load ${url}`);

	// Content-Length is the compressed size when the server is compressing, so
	// this is a progress bar, not an accountancy exercise.
	const header = response.headers.get('content-length');
	const totalBytes = header ? Number(header) : null;

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let loadedBytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loadedBytes += value.length;
		onProgress({
			ratio: totalBytes ? Math.min(1, loadedBytes / totalBytes) : null,
			loadedBytes,
			totalBytes
		});
	}
	return new Blob(chunks as BlobPart[]);
}

export async function loadFfmpeg(
	urls: CoreUrls,
	onProgress: (p: LoadProgress) => void = () => {}
): Promise<FFmpeg> {
	fontURL = urls.fontURL;
	if (instance) return instance;
	if (loading) return loading;

	loading = (async () => {
		const { FFmpeg } = await import('@ffmpeg/ffmpeg');
		const ff = new FFmpeg();
		ff.on('log', ({ message }) => {
			logLines.push(message);
			// a conversion that ran long can leave thousands of lines behind
			if (logLines.length > 4000) logLines = logLines.slice(-2000);
		});

		// Fetch the wasm first purely so the download can be reported, then
		// hand ffmpeg the ordinary URLs and let it read them straight back out
		// of the browser cache.
		//
		// Not blob URLs, which is the obvious way to avoid fetching twice and
		// does not work: ffmpeg loads the core inside a worker with
		// importScripts, which refuses a blob and fails with "failed to import
		// ffmpeg-core.js". Serving both files from our own origin makes the
		// plain URLs the simpler answer anyway.
		await fetchWithProgress(urls.wasmURL, onProgress);

		await ff.load({ coreURL: urls.coreURL, wasmURL: urls.wasmURL });
		instance = ff;
		return ff;
	})();

	try {
		return await loading;
	} catch (error) {
		loading = null;
		throw error;
	}
}

/** Ask ffmpeg what is in the file by giving it nowhere to put the result. */
export async function probe(ff: FFmpeg, file: File): Promise<ProbeResult> {
	await ff.writeFile(INPUT, new Uint8Array(await file.arrayBuffer()));
	logLines = [];
	// exits non-zero every time with "at least one output file must be
	// specified", which is exactly what we want. The useful part came first.
	await ff.exec(['-i', INPUT]);
	const result = parseProbe(logLines);
	if (!looksReadable(result)) {
		throw new Error('That file does not look like a video this tool can read');
	}
	return result;
}

export interface ConvertResult {
	blob: Blob;
	/** True when the picture was copied, so every frame is untouched. */
	framesIntact: boolean;
	/** True when nothing at all was re-encoded. */
	fullCopy: boolean;
	probe: ProbeResult;
}

/**
 * One conversion, copying streams where the container allows it.
 *
 * A copy is attempted first and a re-encode runs only if it fails, because a
 * container will happily claim to hold something it does not and no amount of
 * probing settles that as well as trying.
 */
export async function convertVideo(
	ff: FFmpeg,
	file: File,
	target: VideoFormat,
	opts: PlanOptions & { onProgress?: (ratio: number) => void } = {}
): Promise<ConvertResult> {
	const info = await probe(ff, file);
	const outName = `output${target.extensions[0]}`;

	const report = ({ progress }: { progress: number }) => {
		// ffmpeg reports progress beyond 1 on some inputs, so clamp it rather
		// than showing a bar that runs off the end
		opts.onProgress?.(Math.max(0, Math.min(1, progress)));
	};
	ff.on('progress', report);

	try {
		const plan = planConversion(target, info, outName, opts);
		let code = await ff.exec(plan.args);
		let copy = plan.copy;

		if (code !== 0 && plan.copy !== 'none') {
			// The container refused what was inside after all, so pay the price.
			// This is not theoretical: H.264 inside an AVI will not remux into
			// Matroska even though Matroska accepts H.264, because the stream
			// needs a bitstream filter first. Trying and falling back handles
			// that without having to encode a table of such exceptions.
			const retry = fallbackPlan(target, outName, opts);
			code = await ff.exec(retry.args);
			copy = 'none';
		}
		if (code !== 0) throw new Error('ffmpeg could not convert that file');

		const data = await ff.readFile(outName);
		if (typeof data === 'string' || data.length === 0) {
			throw new Error('The conversion produced an empty file');
		}
		const bytes = new Uint8Array(data);
		return {
			blob: new Blob([bytes as unknown as ArrayBuffer], { type: target.mime }),
			framesIntact: copy === 'full' || copy === 'video',
			fullCopy: copy === 'full',
			probe: info
		};
	} finally {
		ff.off('progress', report);
		await ff.deleteFile(outName).catch(() => {});
	}
}

/**
 * The face `drawtext` writes with.
 *
 * There is no system font inside the wasm filesystem, so one has to be put
 * there before a caption can be drawn. Pick a bold face, because a caption
 * sits over a moving picture and a regular weight disappears into it. Fetched
 * only when somebody actually adds text, and kept once fetched: a font is
 * nothing beside the 7MB core, but it is not worth downloading on a page that
 * will not use it.
 */
let fontWritten = false;

async function ensureFont(ff: FFmpeg): Promise<void> {
	if (fontWritten) return;
	if (!fontURL) throw new Error('Text needs a font: pass fontURL to loadFfmpeg');
	const response = await fetch(fontURL);
	if (!response.ok) throw new Error('Could not load the font for captions');
	await ff.writeFile(FONT_FILE, new Uint8Array(await response.arrayBuffer()));
	fontWritten = true;
}

/** A canvas painted by `paint` as PNG bytes, for writing into ffmpeg's filesystem. */
async function paintedPng(
	frame: PhoneFrame,
	paint: (ctx: CanvasRenderingContext2D) => void
): Promise<Uint8Array> {
	const canvas = document.createElement('canvas');
	canvas.width = frame.width;
	canvas.height = frame.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('This browser cannot draw the phone frame');
	paint(ctx);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
	if (!blob) throw new Error('This browser cannot draw the phone frame');
	return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The frame a phone edit lays over the video, painted once as a PNG by the
 * same function the image tool and the panel's preview use, and the mask for a
 * see-through result. Returns the names written, so they can be cleaned up.
 *
 * For see-through corners this PNG is not the preview's canvas: the preview
 * leaves the outside clear for the checkerboard, and this one is black there
 * so the soft edge of the outline can't show the recording. See
 * `phoneOverlayOutside`.
 */
async function writePhoneFrame(ff: FFmpeg, op: Extract<EditOp, { kind: 'phone' }>): Promise<string[]> {
	const frame = phoneLayout(op);
	await ff.writeFile(
		PHONE_FRAME_FILE,
		await paintedPng(frame, (ctx) =>
			paintPhoneFrame(ctx, frame, { outside: phoneOverlayOutside(op) })
		)
	);
	if (!op.transparent) return [PHONE_FRAME_FILE];
	await ff.writeFile(PHONE_MASK_FILE, await paintedPng(frame, (ctx) => paintPhoneMask(ctx, frame)));
	return [PHONE_FRAME_FILE, PHONE_MASK_FILE];
}

/**
 * The first frame of a recording as a PNG, for a phone frame whose preview
 * the browser can't play. See `stillArgs`. The file stays in ffmpeg's
 * filesystem afterwards, where the edit writes it again anyway.
 */
export async function readStill(ff: FFmpeg, file: File): Promise<{ blob: Blob; probe: ProbeResult }> {
	const info = await probe(ff, file);
	// The same second look for a tag that `editVideo` takes, so the still is
	// converted with the colours the framed copy will have.
	if (!info.colourMatrix) {
		info.declaredColour = await readFileColourTag(file).catch(() => null);
	}
	logLines = [];
	try {
		const code = await ff.exec(stillArgs(INPUT, stillColour(info)));
		if (code !== 0) throw new Error('ffmpeg could not read a frame out of that file');
		const data = await ff.readFile(STILL_FILE);
		if (typeof data === 'string' || data.length === 0) {
			throw new Error('ffmpeg could not read a frame out of that file');
		}
		const bytes = new Uint8Array(data);
		return { blob: new Blob([bytes as unknown as ArrayBuffer], { type: 'image/png' }), probe: info };
	} finally {
		await ff.deleteFile(STILL_FILE).catch(() => {});
	}
}

/**
 * One edit, keeping the file in the container it arrived in.
 *
 * The shape is deliberately the same as `convertVideo`: probe, plan, run,
 * read back. What differs is that there is no fallback to try, because an edit
 * either has a filter or it does not, and a filter cannot be copied around.
 * The two operations that do copy (a keyframe trim, and dropping the sound)
 * fail loudly rather than silently re-encoding, since a visitor who was
 * promised "instant, every frame untouched" should not quietly get the other
 * thing.
 */
export async function editVideo(
	ff: FFmpeg,
	file: File,
	op: EditOp,
	target: VideoFormat,
	opts: EditOptions & { onProgress?: (ratio: number) => void } = {}
): Promise<ConvertResult> {
	const info = await probe(ff, file);
	const outName = `output${target.extensions[0]}`;

	// A tag ffmpeg lost on the way in, which the phone frame has to write back
	// out. Read from the file's own boxes, so it costs a few small reads.
	if (op.kind === 'phone' && !info.colourMatrix) {
		info.declaredColour = await readFileColourTag(file).catch(() => null);
	}
	if (needsFont(op)) await ensureFont(ff);
	// Planned before anything is painted, so an impossible request fails before
	// two full size PNGs are drawn for it.
	const plan = planEdit(op, target, info, outName, opts);
	const extras = op.kind === 'phone' ? await writePhoneFrame(ff, op) : [];

	const report = ({ progress }: { progress: number }) => {
		opts.onProgress?.(Math.max(0, Math.min(1, progress)));
	};
	ff.on('progress', report);

	try {
		logLines = [];
		const code = await ff.exec(plan.args);
		if (code !== 0) {
			const said = lastFfmpegLines(3)
				.filter((line) => /error|invalid|no such|could not|unable/i.test(line))
				.join(' ');
			throw new Error(said || 'ffmpeg could not apply that edit');
		}

		const data = await ff.readFile(outName);
		if (typeof data === 'string' || data.length === 0) {
			throw new Error('The edit produced an empty file');
		}
		const bytes = new Uint8Array(data);
		return {
			blob: new Blob([bytes as unknown as ArrayBuffer], { type: target.mime }),
			framesIntact: plan.framesIntact,
			fullCopy: plan.copy === 'full',
			probe: info
		};
	} finally {
		ff.off('progress', report);
		await ff.deleteFile(outName).catch(() => {});
		for (const name of extras) await ff.deleteFile(name).catch(() => {});
	}
}

export interface FrameResult {
	frames: { name: string; data: Uint8Array; blob: Blob }[];
	probe: ProbeResult;
}

/**
 * Stills out of a clip, read back one at a time.
 *
 * The odd shape in this file: every other runner here reads a single output
 * back by name, and this one does not know exactly how many files it made.
 * ffmpeg's fps filter decides that from the source's real timing, so the
 * planned count is close but not a promise.
 *
 * So the frames are read by walking the numbered pattern until one is missing,
 * rather than by trusting the estimate or by listing the filesystem. Missing is
 * the reliable signal: `readFile` on a name ffmpeg never wrote fails, and that
 * is the end of the run. A hard stop sits past the cap as well, so a pattern
 * that somehow kept matching cannot spin forever.
 */
export async function extractFrames(
	ff: FFmpeg,
	file: File,
	request: FrameRequest,
	opts: { onProgress?: (ratio: number) => void; onFrame?: (count: number) => void } = {}
): Promise<FrameResult> {
	const info = await probe(ff, file);

	// Now that the real frame rate is known, check the count against it rather
	// than against the panel's estimate. "Every frame" of a 60fps clip is more
	// than twice what a 25fps stand-in predicted, and the difference is the
	// gap between refusing a run and truncating one silently at the ceiling.
	const count = frameCount(request, info.durationSeconds, info.fps);
	if (tooManyFrames(count)) {
		throw new Error(
			`That comes to about ${count.toLocaleString()} frames, past the limit of ` +
				`${FRAME_MAX.toLocaleString()}. Lower the rate, or trim the clip first.`
		);
	}

	const plan = planFrames(request, INPUT);
	const mime = FRAME_FORMATS[request.format].mime;

	const report = ({ progress }: { progress: number }) => {
		opts.onProgress?.(Math.max(0, Math.min(1, progress)));
	};
	ff.on('progress', report);

	const written: string[] = [];
	try {
		logLines = [];
		const code = await ff.exec(plan.args);
		if (code !== 0) {
			const said = lastFfmpegLines(3)
				.filter((line) => /error|invalid|no such|could not|unable/i.test(line))
				.join(' ');
			throw new Error(said || 'ffmpeg could not read frames out of that file');
		}

		const frames: FrameResult['frames'] = [];
		for (let i = 1; i <= FRAME_MAX + 1; i++) {
			const name = plan.pattern.replace('%05d', String(i).padStart(5, '0'));
			let data: Uint8Array;
			try {
				const read = await ff.readFile(name);
				if (typeof read === 'string' || read.length === 0) break;
				data = new Uint8Array(read);
			} catch {
				break;
			}
			written.push(name);
			frames.push({
				name,
				data,
				blob: new Blob([data as unknown as ArrayBuffer], { type: mime })
			});
			opts.onFrame?.(frames.length);
		}

		if (frames.length === 0) throw new Error('That clip produced no frames');
		// Belt and braces against the one failure that would look like success:
		// more files on disk than the loop agreed to read. Better to say so than
		// to hand back a folder that quietly stops partway through the clip.
		if (frames.length > FRAME_MAX) {
			throw new Error(
				`That clip holds more than ${FRAME_MAX.toLocaleString()} frames at this rate. ` +
					'Lower the rate, or trim the clip first.'
			);
		}
		return { frames, probe: info };
	} finally {
		ff.off('progress', report);
		// Leaving a thousand stills in the wasm filesystem would make the next
		// run start from a full disk, and they are the largest thing this tool
		// ever puts there.
		for (const name of written) await ff.deleteFile(name).catch(() => {});
	}
}

/** Ask ffmpeg what is in a file already written under a name of our choosing. */
async function probeNamed(ff: FFmpeg, name: string): Promise<ProbeResult> {
	logLines = [];
	await ff.exec(['-i', name]);
	const result = parseProbe(logLines);
	if (!looksReadable(result)) {
		throw new Error(`${name} does not look like a video this tool can read`);
	}
	return result;
}

export interface MergeResult extends ConvertResult {
	/** True when a silent clip was given a generated track to line up. */
	silenceAdded: boolean;
	/** What each input turned out to contain, in the order they were joined. */
	probes: ProbeResult[];
}

/**
 * Several clips into one file, copying the streams when the clips allow it.
 *
 * The copy is tried first and the re-encode runs only if it fails, which is
 * the same shape `convertVideo` uses and is here for the same reason: whether
 * a set of clips can be concatenated without decoding depends on more than a
 * probe can see, and the only way to settle it is to try. When it works the
 * difference is a second against several minutes, so it is worth the failed
 * attempt, which costs almost nothing because ffmpeg gives up immediately.
 */
export async function mergeVideos(
	ff: FFmpeg,
	files: File[],
	target: VideoFormat,
	opts: { quality?: number; onProgress?: (ratio: number) => void } = {}
): Promise<MergeResult> {
	if (files.length < 2) throw new Error('Two or more videos are needed to join anything');

	const names = files.map((_, i) => inputName(i));
	const outName = `output${target.extensions[0]}`;

	for (const [i, file] of files.entries()) {
		await ff.writeFile(names[i], new Uint8Array(await file.arrayBuffer()));
	}
	const probes: ProbeResult[] = [];
	for (const name of names) probes.push(await probeNamed(ff, name));

	await ff.writeFile(LIST_FILE, new TextEncoder().encode(listFileContents(files.length)));

	const report = ({ progress }: { progress: number }) => {
		opts.onProgress?.(Math.max(0, Math.min(1, progress)));
	};
	ff.on('progress', report);

	try {
		let plan = copyPlan(outName);
		logLines = [];
		let code = await ff.exec(plan.args);

		// Exiting zero is not the same as having joined anything. The concat
		// demuxer given an MP4 and a WebM writes only the first clip, and given
		// a silent clip first it drops the sound from all the others while
		// getting the length right. Both exit successfully, so the copy is
		// measured before it is believed. See `joinLooksComplete`.
		if (code === 0) {
			const joined = await probeNamed(ff, outName).catch(() => null);
			if (!joinLooksComplete(joined, probes)) code = -1;
		}

		if (code !== 0) {
			// The clips disagreed about something, which is the common case for
			// files from different sources. Pay for the decode.
			plan = encodeArgs(probes, target, outName, opts.quality);
			logLines = [];
			code = await ff.exec(plan.args);
		}
		if (code !== 0) {
			const said = lastFfmpegLines(3)
				.filter((line) => /error|invalid|no such|could not|unable/i.test(line))
				.join(' ');
			throw new Error(said || 'ffmpeg could not join those videos');
		}

		const data = await ff.readFile(outName);
		if (typeof data === 'string' || data.length === 0) {
			throw new Error('The join produced an empty file');
		}
		const bytes = new Uint8Array(data);
		return {
			blob: new Blob([bytes as unknown as ArrayBuffer], { type: target.mime }),
			framesIntact: plan.framesIntact,
			fullCopy: plan.framesIntact,
			silenceAdded: plan.silenceAdded,
			probe: probes[0],
			probes
		};
	} finally {
		ff.off('progress', report);
		await ff.deleteFile(outName).catch(() => {});
		await ff.deleteFile(LIST_FILE).catch(() => {});
		// 32MB of core is one thing, but several videos held in the wasm heap
		// is what actually runs a tab out of memory.
		for (const name of names) await ff.deleteFile(name).catch(() => {});
	}
}

/**
 * Ends the worker ffmpeg runs in, which is also the only way to stop a run:
 * ffmpeg.wasm has no interrupt. Every video panel's Cancel button calls this.
 * Whatever was waiting on the run rejects, the files in its filesystem go with
 * it, and the next `loadFfmpeg` starts a fresh one out of the browser's cache,
 * which is why the font has to be written again.
 */
export function resetFfmpeg(): void {
	instance?.terminate();
	instance = null;
	loading = null;
	logLines = [];
	fontWritten = false;
}
