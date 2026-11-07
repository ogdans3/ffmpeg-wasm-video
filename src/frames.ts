/**
 * Pulling still images out of a video.
 *
 * The odd one out in the video section. Every other tool here takes one clip
 * and gives back one clip, which is the shape `edit.ts` is built around. This
 * one takes a clip and gives back a pile of images, so it gets its own plan,
 * its own runner and its own panel, the same split `merge.ts` needed for the
 * opposite reason.
 *
 * Pure and tested, like the rest of the planning code, because the arithmetic
 * that decides how many files land in somebody's browser memory is exactly the
 * part worth checking without a browser.
 */

/** What the frames are written as. Both are in every ffmpeg build. */
export type FrameFormat = 'jpg' | 'png';

export interface FrameFormatInfo {
	id: FrameFormat;
	label: string;
	extension: string;
	mime: string;
	/** Whether the quality control means anything for it. */
	lossy: boolean;
}

export const FRAME_FORMATS: Record<FrameFormat, FrameFormatInfo> = {
	jpg: { id: 'jpg', label: 'JPG', extension: '.jpg', mime: 'image/jpeg', lossy: true },
	png: { id: 'png', label: 'PNG', extension: '.png', mime: 'image/png', lossy: false }
};

/**
 * The ceiling on frames from one run.
 *
 * Not a guess. Each frame is held three times over before it reaches the
 * download: once in ffmpeg's filesystem, once as a blob, and once inside the
 * zip. A thousand stills off a 1080p clip is already a few hundred megabytes
 * of that, and the tab dies rather than degrading. So the count is shown
 * before anything runs and the run is refused past this.
 */
export const FRAME_MAX = 1000;

/** Past this it is slow enough to be worth saying so. */
export const FRAME_MANY = 250;

/** Slowest rate worth offering: one still every twenty seconds. */
export const FRAME_RATE_MIN = 0.05;

/** Quality for the lossy format, in ffmpeg's own scale where lower is better. */
export const FRAME_QUALITY_MIN = 2;
export const FRAME_QUALITY_MAX = 31;

export interface FrameRequest {
	format: FrameFormat;
	/** Stills per second of source. Ignored when `everyFrame` is set. */
	rate: number;
	/** Take every frame the clip actually holds, whatever its frame rate. */
	everyFrame: boolean;
	/** ffmpeg's q:v for JPG. Lower is better, 2 to 31. */
	quality: number;
}

/**
 * How many stills a request will produce.
 *
 * Deliberately the same arithmetic the panel shows and the runner trusts, so
 * the number somebody reads before pressing the button is the number they get
 * rather than an estimate that drifts from it.
 */
export function frameCount(
	request: Pick<FrameRequest, 'rate' | 'everyFrame'>,
	durationSeconds: number | null,
	sourceFps: number | null
): number {
	if (!durationSeconds || durationSeconds <= 0) return 0;
	const rate = request.everyFrame ? (sourceFps ?? 25) : request.rate;
	if (!rate || rate <= 0) return 0;
	// ffmpeg's fps filter emits a frame at t=0, so a 10s clip at 1/s is 10 or
	// 11 depending on where the last one lands. Floor plus one matches what it
	// actually writes closely enough to be worth showing.
	return Math.max(1, Math.floor(durationSeconds * rate) + 1);
}

/** True when the request is more than one run should try to hold. */
export function tooManyFrames(count: number): boolean {
	return count > FRAME_MAX;
}

export interface FramePlan {
	args: string[];
	/** The ffmpeg output pattern, and what the files will be called. */
	pattern: string;
	extension: string;
}

/**
 * The ffmpeg arguments for one extraction.
 *
 * `-vsync vfr` is deliberately absent. The fps filter already decides which
 * frames survive, and asking ffmpeg to vary the rate on top of that makes the
 * count depend on the source's own timing rather than on what was asked for,
 * which is the one thing this tool must not do: the panel promises a number
 * before the run.
 */
export function planFrames(request: FrameRequest, input: string): FramePlan {
	const info = FRAME_FORMATS[request.format];
	// Five digits, so a thousand frames still sort as text in every zip tool.
	const pattern = `frame_%05d${info.extension}`;
	const args = ['-i', input];

	if (!request.everyFrame) {
		args.push('-vf', `fps=${Number(request.rate.toFixed(4))}`);
	}

	if (info.lossy) {
		const q = Math.round(
			Math.min(FRAME_QUALITY_MAX, Math.max(FRAME_QUALITY_MIN, request.quality))
		);
		args.push('-q:v', String(q));
		// ffmpeg's JPG encoder builds an optimal Huffman table for every picture
		// unless told otherwise, and in this core that step fails on ordinary
		// footage with "memory access out of bounds". An iPhone's HEVC recording
		// stopped on its first frame with "Error submitting video frame to the
		// encoder", and an H.264 clip took the tab down on its third, while the
		// same picture as WebM went through. It depends on the picture, so a
		// passing clip proves nothing. The standard tables never failed, and
		// cost 14 to 19% in file size on the same frames.
		args.push('-huffman', 'default');
	}

	// No sound in a still, and asking for it makes ffmpeg complain rather than
	// simply ignore it.
	args.push('-an', pattern);
	return { args, pattern, extension: info.extension };
}

/**
 * What one still gets called inside the zip.
 *
 * Numbered from one and padded, so they open in order in a file manager, and
 * carrying the source name so a folder of frames from two clips stays sorted
 * into two groups.
 */
export function frameName(baseName: string, index: number, extension: string): string {
	return `${baseName}-${String(index + 1).padStart(4, '0')}${extension}`;
}
