import type { ColourTag } from './colourtag';
import type { VideoFormat } from './formats';

/**
 * Turning a conversion into ffmpeg arguments.
 *
 * This is the whole performance story of the video section, so it is pure and
 * tested rather than buried in a component. Measured in a browser on a five
 * second 720p clip:
 *
 *   copy into another container      15 to 60 ms
 *   audio out as MP3                     80 ms
 *   video out as GIF                    1.2 s
 *   re-encode to WebM (VP8)             4.0 s
 *   re-encode to H.264                  9.3 s
 *
 * The gap between the first line and the last is three orders of magnitude,
 * and it is entirely about whether the video stream has to be decoded and
 * encoded again or can simply be moved into a different box. So: copy
 * whenever the target container will accept what is already there.
 *
 * Two settings below are load bearing and were arrived at by measuring.
 * VP8 with a realtime deadline is eight times faster than the default for the
 * same file size, and VP9 is not offered at all because it reliably crashed
 * the tab. See CLAUDE.md before changing either.
 */

export interface ProbeResult {
	/** Codec name as ffmpeg reports it, e.g. "h264". */
	videoCodec: string | null;
	audioCodec: string | null;
	durationSeconds: number | null;
	width: number | null;
	height: number | null;
	/**
	 * Frames a second, as ffmpeg reports it on the stream line.
	 *
	 * Only the frame extraction page needs it, and it needs it badly: without
	 * it, "every frame" has to guess, and a guess low enough to pass the cap
	 * would let a run start that gets silently truncated at the ceiling.
	 */
	fps: number | null;
	/**
	 * The Y'CbCr matrix the picture is tagged with, as ffmpeg names it
	 * ("bt709", "smpte170m", "bt2020nc"), or null when it carries no tag.
	 * Only the phone frame needs it, to write its painted colours into the
	 * video the way a player will read them back out. Optional, because
	 * nothing else looks at it.
	 */
	colourMatrix?: string | null;
	/**
	 * The primaries and transfer beside the matrix, as ffmpeg names them, so
	 * the phone frame can write the whole tag back out. ffmpeg's VP8 decoder
	 * labels every frame BT.601 whatever the file said, so leaving the tag to
	 * ride through on the frames is not enough.
	 */
	colourPrimaries?: string | null;
	colourTransfer?: string | null;
	/** Full range ("pc", or a yuvj format), where black is 0 rather than 16. */
	fullRange?: boolean;
	/**
	 * The tag the MP4 or MOV itself declares, read by `readColourTag` rather
	 * than by ffmpeg, whose VP9 decoder throws it away. Filled in only for the
	 * phone frame, and only when `colourMatrix` came back empty.
	 */
	declaredColour?: ColourTag | null;
}

/**
 * How much of the file survives untouched.
 *
 * "video" is worth separating from "full" because it is nearly as fast and
 * far more common than it first looks. AVI takes H.264 happily but will not
 * take AAC, so an MP4 going into an AVI needs a new audio track and nothing
 * else. Re-encoding the picture as well, which is what treating this as all
 * or nothing does, turns a second into a minute for no reason at all.
 */
export type CopyLevel = 'full' | 'video' | 'audio' | 'none';

export interface ConvertPlan {
	args: string[];
	copy: CopyLevel;
	/** True when the picture is untouched, so every frame is identical. */
	get framesIntact(): boolean;
	/** Shown to the visitor before they commit to waiting. */
	expectation: 'instant' | 'quick' | 'slow';
}

function makePlan(args: string[], copy: CopyLevel, expectation: ConvertPlan['expectation']): ConvertPlan {
	return {
		args,
		copy,
		expectation,
		get framesIntact() {
			return copy === 'full' || copy === 'video';
		}
	};
}

export interface PlanOptions {
	/** GIF width in pixels. Height follows the source. */
	gifWidth?: number;
	gifFps?: number;
	/** Constant rate factor for H.264, lower is better quality. */
	crf?: number;
}

const IN = 'input';

/** Will the target container take the picture as it is? */
export function canCopyVideo(target: VideoFormat, probe: ProbeResult): boolean {
	if (target.kind !== 'video') return false;
	if (!probe.videoCodec) return false;
	return target.copyableVideoCodecs.includes(probe.videoCodec);
}

/** And the sound? No audio at all counts, since there is nothing to refuse. */
export function canCopyAudio(target: VideoFormat, probe: ProbeResult): boolean {
	if (target.kind === 'animation') return false;
	if (!probe.audioCodec) return true;
	return target.copyableAudioCodecs.includes(probe.audioCodec);
}

/** Both streams, which means the file is only rewrapped. */
export function canCopy(target: VideoFormat, probe: ProbeResult): boolean {
	return canCopyVideo(target, probe) && canCopyAudio(target, probe);
}

function gifArgs(outName: string, opts: PlanOptions): string[] {
	const width = opts.gifWidth ?? 480;
	const fps = opts.gifFps ?? 12;
	// One pass with a generated palette looks far better than the default 216
	// colour web palette, and costs almost nothing at these sizes.
	return [
		'-i',
		IN,
		'-vf',
		`fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
		'-loop',
		'0',
		'-y',
		outName
	];
}

function audioArgs(target: VideoFormat, outName: string, probe: ProbeResult): string[] {
	// Audio already in the right codec is copied out untouched, which keeps
	// the original quality instead of putting it through MP3 a second time.
	if (probe.audioCodec && target.copyableAudioCodecs.includes(probe.audioCodec)) {
		return ['-i', IN, '-vn', '-c:a', 'copy', '-y', outName];
	}
	return ['-i', IN, '-vn', '-c:a', target.audioCodec ?? 'libmp3lame', '-q:a', '2', '-y', outName];
}

/** Video arguments only, either a copy or a real encode. */
function videoArgs(target: VideoFormat, copyVideo: boolean, opts: PlanOptions): string[] {
	if (copyVideo) return ['-c:v', 'copy'];

	const args = ['-c:v', target.videoCodec ?? 'libx264'];
	if (target.videoCodec === 'libvpx') {
		// Eight times faster than the default deadline for the same file size.
		// Without this a one minute clip takes six minutes.
		args.push('-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8');
	} else {
		// veryfast rather than ultrafast on purpose: ultrafast finished in a
		// third of the time and produced a file larger than the source, which
		// defeats the point of converting.
		args.push('-preset', 'veryfast', '-crf', String(opts.crf ?? 23), '-pix_fmt', 'yuv420p');
	}
	return args;
}

function encodeArgs(
	target: VideoFormat,
	outName: string,
	opts: PlanOptions,
	copyVideo = false,
	copyAudio = false
): string[] {
	return [
		'-i',
		IN,
		...videoArgs(target, copyVideo, opts),
		'-c:a',
		copyAudio ? 'copy' : (target.audioCodec ?? 'aac'),
		'-y',
		outName
	];
}

/**
 * The arguments for one conversion, and an honest guess at how long it will
 * feel. `outName` is the name inside ffmpeg's own filesystem, not the
 * download name.
 */
export function planConversion(
	target: VideoFormat,
	probe: ProbeResult,
	outName: string,
	opts: PlanOptions = {}
): ConvertPlan {
	if (target.kind === 'audio') {
		const copied = canCopyAudio(target, probe) && probe.audioCodec !== null;
		return makePlan(audioArgs(target, outName, probe), copied ? 'audio' : 'none', 'instant');
	}
	if (target.kind === 'animation') {
		return makePlan(gifArgs(outName, opts), 'none', 'quick');
	}

	const video = canCopyVideo(target, probe);
	const audio = canCopyAudio(target, probe);

	if (video && audio) {
		return makePlan(['-i', IN, '-c', 'copy', '-y', outName], 'full', 'instant');
	}
	if (video) {
		// The picture is 95% of the work and all of the quality, so keeping it
		// and re-encoding only the sound stays effectively instant. This is
		// what an MP4 going into an AVI needs, since AVI takes H.264 but not AAC.
		return makePlan(encodeArgs(target, outName, opts, true, false), 'video', 'instant');
	}
	if (audio && probe.audioCodec) {
		return makePlan(encodeArgs(target, outName, opts, false, true), 'audio', 'slow');
	}
	return makePlan(encodeArgs(target, outName, opts), 'none', 'slow');
}

/**
 * A second attempt for when a copy turned out not to work after all.
 *
 * Containers are not honest about what is inside them, and a probe can only
 * report what ffmpeg managed to parse. Rather than guess harder, the copy is
 * attempted and this is what runs if it fails.
 */
export function fallbackPlan(
	target: VideoFormat,
	outName: string,
	opts: PlanOptions = {}
): ConvertPlan {
	return makePlan(encodeArgs(target, outName, opts), 'none', 'slow');
}

/** Rough seconds of work, for a progress estimate. Deliberately pessimistic. */
export function estimateSeconds(plan: ConvertPlan, probe: ProbeResult): number | null {
	if (!probe.durationSeconds) return null;
	const pixels = (probe.width ?? 1280) * (probe.height ?? 720);
	const scale = pixels / (1280 * 720);
	if (plan.expectation === 'instant') return 1;
	if (plan.expectation === 'quick') return Math.max(1, probe.durationSeconds * 0.25 * scale);
	// measured at roughly 0.8x realtime for VP8 and 1.9x for H.264 at 720p
	const rate = plan.args.includes('libvpx') ? 0.8 : 1.9;
	return Math.max(2, probe.durationSeconds * rate * scale);
}
