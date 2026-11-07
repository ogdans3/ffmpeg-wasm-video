import type { VideoFormat } from './formats';
import type { ProbeResult } from './plan';

/**
 * Joining several videos into one.
 *
 * The third planner, beside `plan.ts` for conversion and `edit.ts` for a
 * single-file edit. It needs its own because every function in those two takes
 * one probe and one input called `input`, and the whole question here is what
 * happens between several of them.
 *
 * Same performance story as the rest of the section, and the gap is just as
 * wide. ffmpeg can join clips two ways:
 *
 *   concat demuxer, streams copied   instant, every frame untouched
 *   concat filter, re-encoded        as slow as the clips are long
 *
 * The first only works when the clips already agree about everything: codec,
 * resolution, pixel format, timebase. Two exports from the same phone agree.
 * A phone clip and a screen recording do not. So the copy is attempted and the
 * re-encode is what runs when it fails, which is the same trying-and-falling-
 * back shape `plan.ts` uses, and for the same reason: a container is not
 * honest about what is inside it, and probing harder does not settle it.
 */

/** The names the inputs are given inside ffmpeg's own filesystem. */
export function inputName(index: number): string {
	return `merge-${index}`;
}

/** The concat demuxer reads its list from a file, which has to exist too. */
export const LIST_FILE = 'merge-list.txt';

/**
 * The list file the concat demuxer reads.
 *
 * `-safe 0` is what lets these be plain names. Quoting is single quotes with
 * the backslash escape ffmpeg's own parser wants, which matters less here than
 * it looks: the names are ours, not the visitor's, precisely so a file called
 * `holiday'2024.mp4` cannot reach this string.
 */
export function listFileContents(count: number): string {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) lines.push(`file '${inputName(i)}'`);
	return `${lines.join('\n')}\n`;
}

/**
 * The fast path: join without decoding anything.
 *
 * Every frame in the result is bit for bit a frame from one of the inputs, and
 * a two hour join finishes in about a second. It fails outright when the clips
 * disagree, which is why nothing here tries to predict whether it will.
 */
export function copyArgs(outName: string): string[] {
	return ['-f', 'concat', '-safe', '0', '-i', LIST_FILE, '-c', 'copy', '-y', outName];
}

/** Even numbers only: H.264 will not encode an odd width or height. */
function even(value: number): number {
	return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * The frame every clip is fitted into.
 *
 * The first clip decides, and that is a rule rather than a heuristic so the
 * page can say it in one sentence and the visitor can change it by reordering.
 * The alternatives are worse: the largest clip winning means five phone clips
 * get upscaled to match one 4K one, for a much bigger file and no more detail,
 * and picking the most common size is a rule nobody can predict from looking
 * at their own files.
 */
export function outputSize(probes: ProbeResult[]): { width: number; height: number } {
	const first = probes.find((p) => p.width && p.height);
	return {
		width: even(first?.width ?? 1280),
		height: even(first?.height ?? 720)
	};
}

/**
 * Fit a clip into the output frame without distorting it.
 *
 * `force_original_aspect_ratio=decrease` then `pad` is letterboxing: the
 * picture keeps its shape and the gap is filled with black. Scaling to the
 * frame directly would stretch a vertical phone clip across a landscape one,
 * which is the kind of result that looks like a bug rather than a choice.
 *
 * `setsar=1` is not decoration. Clips carry a pixel aspect ratio of their own,
 * and concat refuses inputs whose SAR disagrees, with an error that says
 * nothing useful about which file caused it.
 */
export function fitFilter(width: number, height: number): string {
	return [
		`scale=${width}:${height}:force_original_aspect_ratio=decrease`,
		`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
		'setsar=1'
	].join(',');
}

export interface MergePlan {
	args: string[];
	/** True when the result is bit for bit the input frames. */
	framesIntact: boolean;
	/** Whether any clip had to be given a silent track to line up with the rest. */
	silenceAdded: boolean;
}

/**
 * The slow path: decode everything, fit it to one frame, encode it once.
 *
 * The audio is the part that catches people out. The concat filter insists
 * every segment has the same streams, so joining a clip that has sound with
 * one that does not fails. Dropping the sound from all of them would be the
 * easy answer and the wrong one, because the usual version of this is a silent
 * title card in front of a clip somebody wants to hear. So the silent ones get
 * a generated silent track instead, and the caller is told it happened.
 */
export function encodeArgs(
	probes: ProbeResult[],
	target: VideoFormat,
	outName: string,
	quality = 23
): MergePlan {
	const { width, height } = outputSize(probes);
	const fit = fitFilter(width, height);

	const anyAudio = probes.some((p) => p.audioCodec);
	const silenceAdded = anyAudio && probes.some((p) => !p.audioCodec);

	const args: string[] = [];
	for (let i = 0; i < probes.length; i++) args.push('-i', inputName(i));

	// Silence is a generated input rather than a filter, because anullsrc is a
	// source. One per silent clip, each cut to that clip's own length so the
	// join does not drift.
	const silentIndex = new Map<number, number>();
	if (silenceAdded) {
		let next = probes.length;
		probes.forEach((probe, i) => {
			if (probe.audioCodec) return;
			const seconds = probe.durationSeconds ?? 0;
			args.push(
				'-f',
				'lavfi',
				'-t',
				seconds.toFixed(3),
				'-i',
				'anullsrc=channel_layout=stereo:sample_rate=44100'
			);
			silentIndex.set(i, next++);
		});
	}

	const parts: string[] = [];
	const labels: string[] = [];
	probes.forEach((probe, i) => {
		parts.push(`[${i}:v]${fit}[v${i}]`);
		labels.push(`[v${i}]`);
		if (!anyAudio) return;
		const source = probe.audioCodec ? `[${i}:a]` : `[${silentIndex.get(i)}:a]`;
		// Resampled so every segment agrees about rate and layout, which concat
		// requires and real files routinely disagree about.
		parts.push(`${source}aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
		labels.push(`[a${i}]`);
	});

	// concat wants the streams interleaved per segment: v0 a0 v1 a1, not all
	// the video followed by all the audio.
	const ordered: string[] = [];
	for (let i = 0; i < probes.length; i++) {
		ordered.push(`[v${i}]`);
		if (anyAudio) ordered.push(`[a${i}]`);
	}
	parts.push(
		`${ordered.join('')}concat=n=${probes.length}:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? '[a]' : ''}`
	);

	args.push('-filter_complex', parts.join(';'), '-map', '[v]');
	if (anyAudio) args.push('-map', '[a]');

	const codec = target.videoCodec ?? 'libx264';
	if (codec === 'libvpx') {
		args.push('-c:v', codec, '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8');
	} else {
		args.push('-c:v', codec, '-preset', 'veryfast', '-crf', String(quality), '-pix_fmt', 'yuv420p');
	}

	if (anyAudio) args.push('-c:a', target.audioCodec ?? 'aac');
	else args.push('-an');

	args.push('-y', outName);
	return { args, framesIntact: false, silenceAdded };
}

/** The fast path as a plan, so both paths have the same shape. */
export function copyPlan(outName: string): MergePlan {
	return { args: copyArgs(outName), framesIntact: true, silenceAdded: false };
}

/**
 * Whether the clips look alike enough for the copy to have a chance.
 *
 * Only ever used to set expectations before the work starts. The copy is
 * attempted regardless of what this says, because agreeing on the four things
 * a probe can see is necessary and not sufficient, and the only way to find
 * out is to try.
 */
export function looksCopyable(probes: ProbeResult[], target: VideoFormat): boolean {
	if (probes.length < 2) return false;
	const [first, ...rest] = probes;
	if (!first.videoCodec) return false;
	if (!target.copyableVideoCodecs.includes(first.videoCodec)) return false;
	return rest.every(
		(p) =>
			p.videoCodec === first.videoCodec &&
			p.audioCodec === first.audioCodec &&
			p.width === first.width &&
			p.height === first.height
	);
}

/**
 * Did the join actually contain every clip, with everything they had in them?
 *
 * This exists because of two real, silent failures, and both exit zero.
 *
 * Joining an MP4 and a WebM with the concat demuxer writes a file containing
 * only the first clip: ffmpeg logs "Non-monotonous DTS in output stream" and
 * carries on. Three seconds out of six, presented as "every frame is identical
 * to the original".
 *
 * Joining a silent clip and one with sound is worse, because the length comes
 * out right. The demuxer takes its stream layout from the first file, so a
 * silent clip in front means the output has no audio track at all and the
 * second clip's sound is dropped. Verified in a browser: the joined file
 * decoded zero audio bytes and the page said nothing was wrong.
 *
 * So a successful exit proves nothing. The output is probed and checked
 * against what went in, and anything short or missing a stream is thrown away
 * and re-encoded, which is the path that handles both cases properly.
 *
 * A join that cannot be measured counts as unverified and is re-encoded too.
 * That costs time on a file we could not read, and the alternative is shipping
 * the truncation whenever a probe comes back thin.
 */
export function joinLooksComplete(out: ProbeResult | null, probes: ProbeResult[]): boolean {
	if (!out) return false;

	const expected = totalDuration(probes);
	if (expected === null || out.durationSeconds === null) return false;
	// Container overhead and keyframe rounding move the total a little, so the
	// tolerance is generous. Truncation is not a near miss, it is half.
	const slack = Math.max(0.5, expected * 0.02);
	if (Math.abs(out.durationSeconds - expected) > slack) return false;

	// If any clip brought sound, the result has to have somewhere to put it.
	if (probes.some((p) => p.audioCodec) && !out.audioCodec) return false;
	if (probes.some((p) => p.videoCodec) && !out.videoCodec) return false;

	return true;
}

/** Total running time of the result, when every clip reported one. */
export function totalDuration(probes: ProbeResult[]): number | null {
	if (probes.some((p) => p.durationSeconds === null)) return null;
	return probes.reduce((sum, p) => sum + (p.durationSeconds ?? 0), 0);
}
