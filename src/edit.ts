import { BEZEL_COLOUR, evenPhoneFrame, type PhoneFrame } from './phoneframe';
import type { VideoFormat } from './formats';
import type { ConvertPlan, ProbeResult } from './plan';
import { sampleRamp, SLOWER, type RampPoint, type RampRange, type RampSegment } from './ramp';

/**
 * Turning an edit into ffmpeg arguments.
 *
 * The companion to `plan.ts`, which handles conversion. Kept apart because the
 * two answer different questions: conversion asks "will this container take
 * what is already here", and an edit asks "what has to be done to the picture".
 * Both are pure and tested for the same reason, since this is where the whole
 * cost of the video section is decided.
 *
 * The cost is worth stating plainly. A filter forces a decode and an encode, so
 * almost everything here is in the seconds-to-minutes range where a conversion
 * is often instant. Two operations escape it, and both are worth having for
 * exactly that reason:
 *
 *   trim on a keyframe    copies both streams      instant
 *   remove the sound      copies the picture       instant
 *
 * Everything else re-encodes. `-preset veryfast` and the VP8 settings are
 * inherited from `plan.ts`, where they were measured. See CLAUDE.md before
 * changing them.
 */

const IN = 'input';

/** What the visitor asked for, before it becomes arguments. */
export type EditOp =
	| { kind: 'trim'; startSeconds: number; endSeconds: number | null; exact: boolean }
	| { kind: 'crop'; x: number; y: number; width: number; height: number }
	| { kind: 'resize'; width: number; height: number | null }
	| { kind: 'speed'; factor: number }
	| { kind: 'stretch'; startSeconds: number; endSeconds: number; targetSeconds: number }
	/**
	 * The same page's other mode: a drawn curve of how fast the clip runs at
	 * each moment, rather than one section given one length. `ramp.ts` owns the
	 * curve and the sampling, this file only turns the result into arguments.
	 */
	| {
			kind: 'ramp';
			points: RampPoint[];
			/**
			 * Which way the curve runs. Not optional in practice: the range is
			 * what the points are clamped against, so planning a speed up curve
			 * against the slow range would quietly flatten every point above 1
			 * back down to it and encode a clip that does nothing.
			 */
			range: RampRange;
	  }
	| { kind: 'fps'; fps: number }
	| { kind: 'rotate'; quarterTurns: number; flipHorizontal: boolean; flipVertical: boolean }
	| { kind: 'blur'; strength: number }
	| { kind: 'text'; text: string; size: number; colour: string; position: TextPosition; box: boolean }
	| { kind: 'mute' }
	| { kind: 'compress'; quality: number }
	/**
	 * A screen recording in a phone frame. The geometry is the image tool's,
	 * from `phoneframe.ts`, so a still and a video get the same phone.
	 */
	| {
			kind: 'phone';
			/**
			 * The picture's size as it plays, read off the preview, which is what
			 * the person saw the frame drawn round. ffmpeg nearly always agrees,
			 * since both apply a rotation flag first. `phoneFrameGraph` covers the
			 * odd pixel where it does not.
			 */
			width: number;
			height: number;
			bezelOn: boolean;
			bezel: number;
			radius: number;
			/** What fills the corners outside the frame, as #rrggbb. */
			background: string;
			/**
			 * See-through corners instead of a background colour. Only a WebM can
			 * carry them here, as VP8 with an alpha channel, so `planEdit` refuses
			 * this for any other target rather than quietly dropping the alpha.
			 */
			transparent: boolean;
	  }
	/**
	 * Joining several clips. Listed here only so the tools registry can name it
	 * like every other page, since `op` is typed as `EditOp['kind']`. It never
	 * reaches `planEdit`: every function in this file takes one probe and one
	 * input, and a join is the one operation that is about several. `merge.ts`
	 * plans it and `mergeVideos` runs it.
	 */
	| { kind: 'merge' }
	/**
	 * Pulling stills out of a clip. Here for the same reason as `merge`: the
	 * registry types `op` as `EditOp['kind']`, so a page cannot be named
	 * without one. It never reaches `planEdit` either, because every function
	 * in this file produces exactly one output file and this one produces a
	 * pile. `frames.ts` plans it and `extractFrames` runs it.
	 */
	| { kind: 'frames' };

export type TextPosition = 'top' | 'centre' | 'bottom';

/** Where a caption sits, as a drawtext expression. Padded off the edge. */
const TEXT_Y: Record<TextPosition, string> = {
	top: 'h*0.06',
	centre: '(h-text_h)/2',
	bottom: 'h*0.94-text_h'
};

/** The font written into ffmpeg's filesystem before a text edit runs. */
export const FONT_FILE = 'font.ttf';

/**
 * What a phone frame writes into ffmpeg's filesystem before it runs: the frame
 * itself, painted once by `paintPhoneFrame`, and for a see-through video the
 * shape its alpha comes from, painted by `paintPhoneMask`.
 */
export const PHONE_FRAME_FILE = 'phone-frame.png';
export const PHONE_MASK_FILE = 'phone-mask.png';

/**
 * The first frame of a recording the browser can't play, as a PNG, for the
 * phone frame's preview.
 *
 * The page sizes the frame from what the preview shows, and a browser that
 * can't play the file shows nothing: every browser refuses AVI, and plenty
 * refuse HEVC, which is what an iPhone records. ffmpeg reads both. The still
 * comes out of the same decoder and the same rotation the edit will use, so
 * its size is the size the frame has to fit.
 */
export const STILL_FILE = 'still.png';

/**
 * `colour` is the matrix and range the framed copy will play back with, from
 * `stillColour`, so the still shows the colours the file will. Left to itself
 * ffmpeg turns an untagged picture into RGB as BT.601. Measured on an
 * untagged 460 × 1000 MPEG-4 recording, which the framed copy plays as BT.709:
 * a green the export showed as (0, 136, 0) was (0, 159, 0) in the preview, and
 * (0, 134, 0) once converted this way.
 */
export function stillArgs(input: string, colour?: Pick<PhoneColour, 'matrix' | 'range'>): string[] {
	const convert = colour
		? ['-vf', `scale=in_color_matrix=${colour.matrix}:in_range=${colour.range}`]
		: [];
	// The first video stream only, one frame of it, and nothing else.
	return ['-i', input, '-map', '0:v:0', '-frames:v', '1', ...convert, '-an', '-y', STILL_FILE];
}

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
/** atempo only accepts 0.5 to 2, so anything outside is reached by chaining. */
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2;

export const BLUR_MIN = 1;
export const BLUR_MAX = 20;

/** A section shorter than this is a mark, not a stretch of footage. */
export const STRETCH_MIN_SECONDS = 0.1;
/** An hour of output from one section is already well past useful. */
export const STRETCH_MAX_SECONDS = 3600;

/**
 * atempo as many times as it takes.
 *
 * The filter refuses a factor outside 0.5 to 2, so quarter speed is two halves
 * and quadruple is two doubles. Without this the slider silently produced a
 * file with the wrong pitch or no sound at all.
 */
export function tempoChain(factor: number): number[] {
	const steps: number[] = [];
	let remaining = factor;
	while (remaining < ATEMPO_MIN - 1e-9) {
		steps.push(ATEMPO_MIN);
		remaining /= ATEMPO_MIN;
	}
	while (remaining > ATEMPO_MAX + 1e-9) {
		steps.push(ATEMPO_MAX);
		remaining /= ATEMPO_MAX;
	}
	steps.push(Number(remaining.toFixed(6)));
	return steps;
}

/** Even numbers only: H.264 will not encode an odd width or height. */
export function evenSize(value: number): number {
	return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * What has to be escaped inside drawtext's value, established by testing each
 * character against the real thing rather than by reading the parser.
 *
 * The colon has to be escaped even inside quotes, or it ends the option list
 * and drawtext fails with "Error while processing the decoded data". The
 * percent must NOT be: escaping it makes the value unparseable and drawtext
 * then draws nothing at all without reporting anything, which is worse than
 * failing. Doing both was the original bug, and it shipped because the obvious
 * test case had no punctuation in it. `expansion=none` in the filter covers
 * the percent instead.
 */
export function escapeDrawText(text: string): string {
	return text
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/:/g, '\\:')
		.replace(/\r?\n/g, ' ');
}

/**
 * The video filter chain for an edit, or null when it needs none.
 *
 * Separated from the arguments so a test can read the chain rather than hunt
 * through an argv, and so the panel can show what it is about to run.
 */
export function filterFor(op: EditOp): string | null {
	switch (op.kind) {
		case 'crop':
			return `crop=${evenSize(op.width)}:${evenSize(op.height)}:${Math.max(0, Math.round(op.x))}:${Math.max(0, Math.round(op.y))}`;
		case 'resize': {
			const width = evenSize(op.width);
			// -2 rather than -1: it keeps the aspect ratio and rounds to an even
			// number, which is what H.264 insists on.
			return `scale=${width}:${op.height ? evenSize(op.height) : -2}`;
		}
		case 'speed':
			return `setpts=${(1 / op.factor).toFixed(6)}*PTS`;
		case 'fps':
			return `fps=${op.fps}`;
		case 'rotate': {
			const parts: string[] = [];
			// transpose turns a quarter at a time, so three of them is the other
			// way round. Two is a 180, which needs no flip of its own.
			for (let i = 0; i < (((op.quarterTurns % 4) + 4) % 4); i++) parts.push('transpose=1');
			if (op.flipHorizontal) parts.push('hflip');
			if (op.flipVertical) parts.push('vflip');
			return parts.length ? parts.join(',') : null;
		}
		case 'blur':
			return `boxblur=${Math.round(op.strength)}:1`;
		case 'text': {
			const bits = [
				`fontfile=${FONT_FILE}`,
				// Literal text, so a percent sign is a percent sign rather than
				// the start of a substitution drawtext would try to evaluate.
				'expansion=none',
				`text='${escapeDrawText(op.text)}'`,
				`fontsize=${Math.round(op.size)}`,
				`fontcolor=${op.colour.replace('#', '0x')}`,
				'x=(w-text_w)/2',
				`y=${TEXT_Y[op.position]}`
			];
			// A caption over a bright frame is unreadable without something
			// behind it, and a box costs nothing.
			if (op.box) bits.push('box=1', 'boxcolor=0x000000@0.5', 'boxborderw=12');
			return `drawtext=${bits.join(':')}`;
		}
		default:
			return null;
	}
}

/**
 * A stretch, worked out and clamped, before it becomes a filter graph.
 *
 * Kept apart from the graph itself so the panel can show what is about to
 * happen without building ffmpeg arguments to read them back, and so a test
 * can check the arithmetic without matching a string full of semicolons.
 */
export interface StretchLayout {
	startSeconds: number;
	endSeconds: number;
	targetSeconds: number;
	/** How many times longer the section becomes. 14.29 for 70s into 1000s. */
	stretch: number;
	/** Whether there is any clip before the section, and any after it. */
	head: boolean;
	tail: boolean;
}

export function stretchLayout(
	op: Extract<EditOp, { kind: 'stretch' }>,
	sourceSeconds: number | null
): StretchLayout {
	const startSeconds = Math.max(0, op.startSeconds);
	const endSeconds = Math.max(startSeconds + STRETCH_MIN_SECONDS, op.endSeconds);
	const targetSeconds = Math.min(
		STRETCH_MAX_SECONDS,
		Math.max(STRETCH_MIN_SECONDS, op.targetSeconds)
	);
	return {
		startSeconds,
		endSeconds,
		targetSeconds,
		stretch: targetSeconds / (endSeconds - startSeconds),
		// A duration we could not read is treated as having something after the
		// section. An empty segment fed to concat is the worse guess: it ends
		// the graph with nothing to join rather than joining nothing.
		head: startSeconds > 0.01,
		tail: sourceSeconds === null || endSeconds < sourceSeconds - 0.01
	};
}

/** How long the whole clip runs once the section has been stretched. */
export function stretchedTotal(layout: StretchLayout, sourceSeconds: number): number {
	const section = layout.endSeconds - layout.startSeconds;
	return Math.max(0, sourceSeconds - section) + layout.targetSeconds;
}

/**
 * The filter graph that slows one section and leaves the rest alone: head,
 * retimed section, tail. `concatFilter` below does the work and carries the
 * reasoning.
 */
export function stretchFilter(layout: StretchLayout, hasAudio: boolean): string {
	const pieces: ConcatPiece[] = [];
	if (layout.head) pieces.push({ from: 0, to: layout.startSeconds, scale: 1 });
	pieces.push({ from: layout.startSeconds, to: layout.endSeconds, scale: layout.stretch });
	// Open ended, so a duration that was a hundredth out does not clip the last
	// frames off the end of the clip.
	if (layout.tail) pieces.push({ from: layout.endSeconds, to: null, scale: 1 });
	return concatFilter(pieces, hasAudio);
}

/** One constant-speed slice of the input, before it becomes a filter chain. */
export interface ConcatPiece {
	from: number;
	/** Null runs to the end of the clip. */
	to: number | null;
	/** The setpts multiplier. Above 1 is slower, exactly 1 is untouched. */
	scale: number;
}

/**
 * Cut the input into slices, retime the ones that asked for it, and join them
 * back into one stream.
 *
 * Shared by both modes of the slow motion page, which is the only reason the
 * curve mode was cheap to add: a marked section is three slices and a drawn
 * curve is thirty, and past that they are the same operation. Keeping one
 * builder means the two cannot drift on the things that were expensive to get
 * right, all of which are here.
 *
 * Every slice needs `-STARTPTS`, because a trimmed piece still carries the
 * timestamps it had where it came from and concat would leave the gap in.
 *
 * The sound follows the picture through `atempo`, chained by `tempoChain`
 * because one instance refuses anything outside half to double speed. A big
 * change is several instances and it sounds like it, which is honest: the
 * alternative is a clip whose sound is silently out of step with its picture.
 *
 * There is no `fps` filter anywhere in here, and that is the expensive
 * decision on this page. Repeating frames to hold a constant rate would mean
 * encoding 14 times as many of them for a 14 times stretch, for a picture that
 * changes at exactly the same moments either way. So the frames that exist are
 * spread out, and `-fps_mode vfr` beside the filter keeps ffmpeg from filling
 * the gaps back in.
 */
export function concatFilter(pieces: ConcatPiece[], hasAudio: boolean): string {
	const parts: string[] = [];
	const labels: string[] = [];

	pieces.forEach((piece, i) => {
		const span = `start=${piece.from.toFixed(3)}${piece.to === null ? '' : `:end=${piece.to.toFixed(3)}`}`;
		const setpts = piece.scale === 1 ? 'PTS-STARTPTS' : `${piece.scale.toFixed(6)}*(PTS-STARTPTS)`;
		parts.push(`[0:v]trim=${span},setpts=${setpts}[v${i}]`);
		if (hasAudio) {
			const tempo =
				piece.scale === 1
					? ''
					: `,${tempoChain(1 / piece.scale)
							.map((step) => `atempo=${step}`)
							.join(',')}`;
			parts.push(`[0:a]atrim=${span},asetpts=PTS-STARTPTS${tempo}[a${i}]`);
		}
		labels.push(`[v${i}]${hasAudio ? `[a${i}]` : ''}`);
	});

	parts.push(
		`${labels.join('')}concat=n=${pieces.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`
	);
	return parts.join(';');
}

/**
 * The filter graph for a drawn curve: one slice per constant-speed piece.
 *
 * A segment at exactly 1 comes back with no multiplier and no atempo, which is
 * how the untouched head and tail of a ramped clip stay untouched.
 */
export function rampFilter(segments: RampSegment[], hasAudio: boolean): string {
	return concatFilter(
		segments.map((segment, i) => ({
			from: segment.from,
			// Same reason as the stretch tail: the last piece runs to the end of
			// the clip rather than to a computed timestamp, so a duration read a
			// hundredth out does not lose the final frames.
			to: i === segments.length - 1 ? null : segment.to,
			scale: 1 / segment.speed
		})),
		hasAudio
	);
}

/**
 * The frame for a phone edit, on the grid a video needs. The panel's preview
 * and the PNG written for ffmpeg both come from here, so what is on screen and
 * what is encoded cannot disagree by a pixel.
 */
export function phoneLayout(op: Extract<EditOp, { kind: 'phone' }>): PhoneFrame {
	return evenPhoneFrame(op.width, op.height, {
		bezelOn: op.bezelOn,
		bezel: op.bezel,
		radius: op.radius
	});
}

/**
 * What the frame PNG is filled with outside the phone's outline, as the
 * `outside` that `paintPhoneFrame` takes.
 *
 * With a colour picked, that colour, since those pixels are the corners.
 *
 * With see-through corners and a border, black like the border, even though
 * nothing out there is ever seen. The mask decides what is see-through, and
 * along the outline its edge is soft, so the pixels there are partly opaque
 * and show whatever colour the frame gave them. Left transparent, the frame let
 * the recording through at exactly those pixels, because the recording's square
 * corner reaches past the outer curve whenever the radius is more than about
 * 2.4 times the border, which the phone defaults always are. Measured on a
 * framed screenshot recording laid over a black page, the outline of every
 * corner came out up to 71 levels bright in the recording's own colours.
 * Black out there makes the soft edge black at every opacity, which is the
 * border's own edge.
 *
 * With see-through corners and no border, left transparent. The outline is
 * then the screen's own edge, and the pixels along it should be the
 * recording's, fading out.
 */
export function phoneOverlayOutside(op: Extract<EditOp, { kind: 'phone' }>): string | undefined {
	if (!op.transparent) return op.background;
	return phoneLayout(op).bezel > 0 ? BEZEL_COLOUR : undefined;
}

/**
 * How the painted frame's colours are written into the video, so the corners
 * come out as the colour that was picked and the border as black, and so the
 * recording on the screen plays back exactly as it did before it was framed.
 *
 * Left to itself, ffmpeg turns the frame's RGB into Y'CbCr with the BT.601
 * matrix in limited range, whatever the video is. Measured in the site's own
 * core, through the real edit: on a recording tagged BT.709, which is what an
 * iPhone makes, #52A152 came back as (76, 148, 79) once a player read it with
 * the matrix the file is tagged with, and on a full range recording the black
 * border came back as (16, 16, 16) and white corners as light grey. So the
 * frame is converted with the recording's own matrix and range.
 *
 * The output's tag is always written out with `setparams`, never left to ride
 * through on the frames, because the frames lie. ffmpeg's VP8 decoder labels
 * every frame BT.601, whatever the file said and whether it said anything, so
 * a WebM tagged BT.709 would come out tagged BT.601 and an untagged one would
 * gain a tag it never had. It labels the range limited the same way, and
 * Chrome's MediaRecorder writes VP8 in full range, so the framed copy of one
 * came out tagged limited over full range pixels: every grey stretched, 176
 * shown as 186, a mean difference of 7.9 levels across the screen in the
 * Chrome that made it. The range is written out beside the rest, and
 * `phoneFrameGraph` holds the pixels in it, so the copy plays back with the
 * recording's own contrast, a mean of 0.04 levels off it in Chrome 131 and
 * 154. The range comes from the stream line, where ffmpeg prints what the
 * container says, not what the decoder decided. The matrix tag written is
 * the recording's own, from one of three places.
 *
 * A tag ffmpeg read off the stream line, matrix, primaries and transfer.
 *
 * A tag only the container declares, which is the one ffmpeg's VP9 decoder
 * throws away, and Chrome's MP4 recordings keep theirs there. `readColourTag`
 * finds it as `declaredColour`. Browsers read it, so without it the framed
 * video would play with a different matrix from the recording.
 *
 * No tag at all, and then none is written, explicitly, so every player reads
 * the output with the same guess it read the recording with and the screen
 * can't change colour between the two. The first version wrote its own guess
 * down instead, and an untagged VP8 WebM that Chrome showed as BT.709 came out
 * tagged BT.601, a red up to 18 levels off in the same browser that had just
 * previewed it. The guess is `untaggedMatrix`, and it is written down only
 * where the output would be guessed differently: a VP9 recording, or one the
 * border takes past 720 lines.
 */
export interface PhoneColour {
	/** For scale's `out_color_matrix`. */
	matrix: 'bt709' | 'bt601' | 'bt2020' | 'smpte240m' | 'fcc';
	range: 'tv' | 'pc';
	/** What the output is tagged with, in the names `setparams` takes. */
	tag: { colorspace: string; primaries: string; transfer: string };
}

/** ffmpeg's tag names, to the matrices `scale` knows how to write. */
const PHONE_MATRICES: Record<string, PhoneColour['matrix']> = {
	bt709: 'bt709',
	smpte170m: 'bt601',
	bt470bg: 'bt601',
	bt2020nc: 'bt2020',
	bt2020c: 'bt2020',
	smpte240m: 'smpte240m',
	fcc: 'fcc'
};

/**
 * The primaries and transfers `setparams` has names for, which are the names
 * ffmpeg prints on the stream line. Anything else is written as unknown
 * rather than handed to the filter to refuse.
 */
const PRIMARIES = new Set(['bt709', 'bt470m', 'bt470bg', 'smpte170m', 'smpte240m', 'film', 'bt2020', 'smpte428', 'smpte431', 'smpte432']);
const TRANSFERS = new Set([
	'bt709',
	'bt470m',
	'bt470bg',
	'smpte170m',
	'smpte240m',
	'linear',
	'log100',
	'log316',
	'iec61966-2-4',
	'bt1361e',
	'iec61966-2-1',
	'bt2020-10',
	'bt2020-12',
	'smpte2084',
	'smpte428',
	'arib-std-b67'
]);

/**
 * H.273's numbers, the ones in an MP4's `colr` and `vpcC` boxes, to ffmpeg's
 * names. A number missing here is written as unknown.
 */
const H273_MATRICES: Record<number, string> = {
	1: 'bt709',
	4: 'fcc',
	5: 'bt470bg',
	6: 'smpte170m',
	7: 'smpte240m',
	9: 'bt2020nc',
	10: 'bt2020c'
};
const H273_PRIMARIES: Record<number, string> = {
	1: 'bt709',
	4: 'bt470m',
	5: 'bt470bg',
	6: 'smpte170m',
	7: 'smpte240m',
	8: 'film',
	9: 'bt2020'
};
const H273_TRANSFERS: Record<number, string> = {
	1: 'bt709',
	4: 'bt470m',
	5: 'bt470bg',
	6: 'smpte170m',
	7: 'smpte240m',
	8: 'linear',
	13: 'iec61966-2-1',
	14: 'bt2020-10',
	15: 'bt2020-12',
	16: 'smpte2084',
	18: 'arib-std-b67'
};

/**
 * The matrix a browser reads an untagged picture with. Measured in Chrome 131
 * and 154, one saturated red at a time: H.264 and VP8 are BT.709 from 720
 * lines up and BT.601 below, whatever the width (1280 × 718 was BT.601,
 * 460 × 720 BT.709), and VP9 is BT.601 at every size up to 1920 × 1080. The
 * output here is always H.264 or VP8, so pass no codec for it.
 */
export function untaggedMatrix(codec: string | null, height: number): 'bt709' | 'bt601' {
	if (codec === 'vp9') return 'bt601';
	return height >= 720 ? 'bt709' : 'bt601';
}

const UNKNOWN = 'unknown';
/** The tag that says a guess out loud, for matrix, primaries and transfer. */
const GUESS_TAGS = { bt709: 'bt709', bt601: 'smpte170m' } as const;

function known(names: Set<string>, name: string | null | undefined): string {
	return name && names.has(name) ? name : UNKNOWN;
}

export function phoneColour(op: Extract<EditOp, { kind: 'phone' }>, probe: ProbeResult): PhoneColour {
	const range = probe.fullRange ? 'pc' : 'tv';
	const tagged = probe.colourMatrix ? PHONE_MATRICES[probe.colourMatrix] : undefined;
	if (tagged && probe.colourMatrix) {
		return {
			matrix: tagged,
			range,
			tag: {
				colorspace: probe.colourMatrix,
				primaries: known(PRIMARIES, probe.colourPrimaries),
				transfer: known(TRANSFERS, probe.colourTransfer)
			}
		};
	}

	const declared = probe.declaredColour;
	const declaredName = declared ? H273_MATRICES[declared.matrix] : undefined;
	if (declared && declaredName) {
		return {
			matrix: PHONE_MATRICES[declaredName],
			range,
			tag: {
				colorspace: declaredName,
				primaries: H273_PRIMARIES[declared.primaries] ?? UNKNOWN,
				transfer: H273_TRANSFERS[declared.transfer] ?? UNKNOWN
			}
		};
	}

	const source = untaggedMatrix(probe.videoCodec, op.height);
	const output = untaggedMatrix(null, phoneLayout(op).height);
	const name = source === output ? UNKNOWN : GUESS_TAGS[source];
	return { matrix: source, range, tag: { colorspace: name, primaries: name, transfer: name } };
}

/**
 * The matrix and range a recording's picture plays back with once framed,
 * which is the same `phoneColour` works out for the edit: the recording's own
 * tag, or the guess a browser makes for it. For the still a preview shows in
 * place of a recording the browser can't play. The border has no say in
 * either, so the frame here has none.
 */
export function stillColour(probe: ProbeResult): Pick<PhoneColour, 'matrix' | 'range'> {
	const { matrix, range } = phoneColour(
		{
			kind: 'phone',
			width: probe.width ?? 0,
			height: probe.height ?? 0,
			bezelOn: false,
			bezel: 0,
			radius: 0,
			background: '#000000',
			transparent: false
		},
		probe
	);
	return { matrix, range };
}

/**
 * The filter graph that puts a video in its phone frame.
 *
 * Input 0 is the video, input 1 the frame PNG, input 2 the mask for a
 * see-through result. The video is padded out to the frame's size with the
 * screen where the frame leaves its hole, and the PNG goes over the top: the
 * border, and in its corners either the background colour or nothing. The PNG
 * is one still, and overlay holds its last frame for as long as the video
 * runs, so it is decoded once rather than once a frame.
 *
 * The pad colour never shows. The hole in the PNG is exactly the cropped
 * screen, so everything the padding adds is under an opaque part of the PNG.
 * That is also why its black is left as ffmpeg's, which is 16 in a full range
 * file: nothing is left for it to be seen through. It did show once, when an
 * odd recording was placed a pixel smaller than its hole, see
 * `evenPhoneFrame`. What the PNG itself holds outside the outline is
 * `phoneOverlayOutside`'s decision, and for see-through corners that matters
 * more than it looks: see there.
 *
 * A see-through result needs one more step, because an overlay can only paint
 * over the picture and never make any of it transparent. With the border off,
 * nothing would round the video's own corners. `alphamerge` takes the alpha
 * channel from the mask instead, which is white over the whole phone.
 */
export function phoneFrameGraph(frame: PhoneFrame, transparent: boolean, colour: PhoneColour): string {
	const s = frame.screen;
	const { range } = colour;
	const chain = [
		// Into the pixel format the encoder takes, here and in the recording's
		// own range, stated both ways so nothing is converted. Left to the
		// converter ffmpeg slips in further down, the range was decided by how
		// the decoder labelled the frames, which is not always what they are:
		// its VP8 decoder calls Chrome's full range recordings limited, its VP9
		// decoder calls them full, and a yuvj H.264 is full by its format alone.
		// A see-through copy went through that converter on its way to
		// yuva420p, so the same recording came out limited from an MP4 and
		// untouched from a WebM. Stated here, it is the same for every decoder.
		// A no-op for most recordings, which are already yuv420p.
		`scale=in_range=${range}:out_range=${range}`,
		`format=${transparent ? 'yuva420p' : 'yuv420p'}`,
		// Cut to the screen. Usually that changes nothing and costs nothing,
		// since crop only moves a pointer. But the size the frame was built for
		// is the browser's, and the browser and ffmpeg can disagree about an odd
		// one: Chromium reported a 461 × 999 WebM as 460 × 998, and padding 461
		// pixels into a 460 pixel hole is an error. The even frame also gives up
		// an odd recording's last column or row on purpose, and this is where
		// that happens, before crop or pad can round it off on their own. A
		// browser that saw a bigger picture than ffmpeg does, a rotation it
		// ignored say, fails here loudly rather than framing it wrong.
		`crop=${s.width}:${s.height}:0:0`,
		`pad=${frame.width}:${frame.height}:${s.x}:${s.y}:color=black`
	];
	// The frame is converted here, with the video's matrix and range, rather
	// than by the converter ffmpeg would slip in, which always uses BT.601
	// limited. See `phoneColour`.
	const paint = `[1:v]scale=out_color_matrix=${colour.matrix}:out_range=${range},format=yuva420p[frame]`;
	const framed = `[0:v]${chain.join(',')}[padded];${paint};[padded][frame]overlay=0:0`;
	const { colorspace, primaries, transfer } = colour.tag;
	const tag = `,setparams=colorspace=${colorspace}:color_primaries=${primaries}:color_trc=${transfer}:range=${range}`;
	return transparent
		? `${framed}[framed];[framed][2:v]alphamerge${tag}[v]`
		: `${framed}${tag}[v]`;
}

/** True when the sound has to be re-encoded because its timing changed. */
function touchesAudio(op: EditOp): boolean {
	return op.kind === 'speed';
}

function encodeVideoArgs(target: VideoFormat, quality: number): string[] {
	const codec = target.videoCodec ?? 'libx264';
	if (codec === 'libvpx') {
		return ['-c:v', codec, '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8'];
	}
	return ['-c:v', codec, '-preset', 'veryfast', '-crf', String(quality), '-pix_fmt', 'yuv420p'];
}

function makePlan(
	args: string[],
	copy: ConvertPlan['copy'],
	expectation: ConvertPlan['expectation']
): ConvertPlan {
	return {
		args,
		copy,
		expectation,
		get framesIntact() {
			return copy === 'full' || copy === 'video';
		}
	};
}

/**
 * Everything a concat of retimed slices needs past the graph itself.
 *
 * `-fps_mode vfr` is the load bearing part: left to itself ffmpeg makes the
 * output constant rate, which means repeating every frame of the slowed
 * section until it fills the new running time. The same picture, many times
 * the encode.
 */
function concatPlan(
	graph: string,
	hasAudio: boolean,
	target: VideoFormat,
	quality: number,
	outName: string
): ConvertPlan {
	return makePlan(
		[
			'-i',
			IN,
			'-filter_complex',
			graph,
			'-map',
			'[v]',
			...(hasAudio ? ['-map', '[a]'] : []),
			'-fps_mode',
			'vfr',
			...encodeVideoArgs(target, quality),
			// Filtered sound cannot be copied, so it is always re-encoded here.
			...(hasAudio ? ['-c:a', target.audioCodec ?? 'aac'] : ['-an']),
			'-y',
			outName
		],
		'none',
		'slow'
	);
}

/**
 * Sound the edit did not touch: copied when the container takes it, which
 * costs nothing and keeps the original quality, and re-encoded when it does
 * not, as AAC does not go into a WebM.
 */
function untouchedAudioArgs(target: VideoFormat, probe: ProbeResult): string[] {
	if (!probe.audioCodec) return ['-an'];
	if (!target.copyableAudioCodecs.includes(probe.audioCodec)) {
		return ['-c:a', target.audioCodec ?? 'aac'];
	}
	return ['-c:a', 'copy'];
}

/**
 * VP8 with an alpha channel, for see-through corners.
 *
 * VP8 rather than VP9, which is what most guides reach for, because VP9 crashes
 * the tab in this ffmpeg build (see CLAUDE.md) and did so again with alpha.
 * VP8 in yuva420p encoded and played back in Chromium with the corners at
 * alpha 0. The speed settings are the ones measured in `plan.ts`, and
 * `-auto-alt-ref 0` because libvpx refuses to encode VP8 transparency with
 * alternate reference frames turned on.
 */
const VP8_ALPHA_ARGS = [
	'-c:v',
	'libvpx',
	'-pix_fmt',
	'yuva420p',
	'-auto-alt-ref',
	'0',
	'-b:v',
	'1M',
	'-deadline',
	'realtime',
	'-cpu-used',
	'8'
];

/**
 * A phone frame: the video padded out and the frame laid over it.
 *
 * `-fps_mode vfr` for the same reason as the retiming pages, from a different
 * direction. A screen recording is usually variable frame rate, since a phone
 * only captures a frame when something on the screen changes, and an MP4
 * written at a constant rate fills every still moment with repeated frames to
 * encode. Here no frame is repeated and none is dropped. Each one is snapped
 * to the stream's nominal frame grid on the way through, so a frame can move
 * by up to half a frame (about 17 ms at 30 fps), which playback doesn't show.
 */
function phonePlan(
	op: Extract<EditOp, { kind: 'phone' }>,
	target: VideoFormat,
	probe: ProbeResult,
	quality: number,
	outName: string
): ConvertPlan {
	if (op.transparent && target.id !== 'webm') {
		throw new Error('See-through corners need a WebM, and nothing else here can hold them');
	}
	const frame = phoneLayout(op);
	const inputs = ['-i', IN, '-i', PHONE_FRAME_FILE];
	if (op.transparent) inputs.push('-i', PHONE_MASK_FILE);
	return makePlan(
		[
			...inputs,
			'-filter_complex',
			phoneFrameGraph(frame, op.transparent, phoneColour(op, probe)),
			'-map',
			'[v]',
			// Mapping the graph's output turns off ffmpeg's own stream choice, so
			// the sound has to be asked for by name or it is silently left out.
			...(probe.audioCodec ? ['-map', '0:a:0'] : []),
			'-fps_mode',
			'vfr',
			...(op.transparent ? VP8_ALPHA_ARGS : encodeVideoArgs(target, quality)),
			...untouchedAudioArgs(target, probe),
			'-y',
			outName
		],
		'none',
		'slow'
	);
}

export interface EditOptions {
	/** Constant rate factor for H.264, lower is better quality. */
	quality?: number;
}

/**
 * The arguments for one edit, keeping the file in the container it arrived in.
 *
 * Staying in the same container is the point: somebody cropping an MP4 wants an
 * MP4 back, and changing the format as a side effect of an edit is the tool
 * making a decision that was not asked of it.
 */
export function planEdit(
	op: EditOp,
	target: VideoFormat,
	probe: ProbeResult,
	outName: string,
	opts: EditOptions = {}
): ConvertPlan {
	const quality = opts.quality ?? 23;

	// Loud rather than quiet. A join routed through here would otherwise fall
	// past every branch and come out as a plain re-encode of one file, which
	// looks like it worked.
	if (op.kind === 'merge') {
		throw new Error('A merge has several inputs and is planned by merge.ts, not planEdit');
	}

	// Loud for the same reason: routed through here it would fall past every
	// branch and come back as a plain re-encode of the clip, which looks like
	// it worked right up until somebody opens the file expecting images.
	if (op.kind === 'frames') {
		throw new Error('Frame extraction has many outputs and is planned by frames.ts, not planEdit');
	}

	// Trimming on a keyframe copies both streams, which is the difference
	// between instant and a full re-encode. `-ss` before `-i` seeks rather than
	// decoding up to the mark, so the cost does not grow with the start time.
	if (op.kind === 'trim') {
		const seek = ['-ss', op.startSeconds.toFixed(3)];
		const until = op.endSeconds === null ? [] : ['-to', op.endSeconds.toFixed(3)];
		if (!op.exact) {
			return makePlan([...seek, '-i', IN, ...until, '-c', 'copy', '-y', outName], 'full', 'instant');
		}
		return makePlan(
			[...seek, '-i', IN, ...until, ...encodeVideoArgs(target, quality), '-c:a', target.audioCodec ?? 'aac', '-y', outName],
			'none',
			'slow'
		);
	}

	// Slowing one section down, with the rest of the clip left at its own pace.
	if (op.kind === 'stretch') {
		const layout = stretchLayout(op, probe.durationSeconds);
		// Nothing either side of the section means this is not a section at all,
		// it is the whole clip, and the plain speed path already does that with
		// one filter instead of a concat of one.
		if (!layout.head && !layout.tail) {
			return planEdit({ kind: 'speed', factor: 1 / layout.stretch }, target, probe, outName, opts);
		}
		const hasAudio = Boolean(probe.audioCodec);
		return concatPlan(stretchFilter(layout, hasAudio), hasAudio, target, quality, outName);
	}

	// The same page's curve mode. Both modes end up as a concat of retimed
	// slices, so they share everything below the graph itself.
	if (op.kind === 'ramp') {
		const segments = sampleRamp(op.points, probe.durationSeconds, op.range ?? SLOWER);
		// One piece is a constant speed across the whole clip, which the plain
		// speed path already does with one filter instead of a concat of one.
		// The same reasoning as a stretch with no head and no tail.
		if (segments.length <= 1) {
			const factor = segments[0]?.speed ?? 1;
			return planEdit({ kind: 'speed', factor }, target, probe, outName, opts);
		}
		const hasAudio = Boolean(probe.audioCodec);
		return concatPlan(rampFilter(segments, hasAudio), hasAudio, target, quality, outName);
	}

	// Dropping the sound leaves every frame of the picture untouched.
	if (op.kind === 'mute') {
		return makePlan(['-i', IN, '-an', '-c:v', 'copy', '-y', outName], 'video', 'instant');
	}

	if (op.kind === 'phone') return phonePlan(op, target, probe, quality, outName);

	if (op.kind === 'compress') {
		return makePlan(
			['-i', IN, ...encodeVideoArgs(target, op.quality), '-c:a', target.audioCodec ?? 'aac', '-y', outName],
			'none',
			'slow'
		);
	}

	const filter = filterFor(op);
	const args = ['-i', IN];
	if (filter) args.push('-vf', filter);

	if (op.kind === 'speed') {
		const chain = tempoChain(op.factor).map((step) => `atempo=${step}`);
		if (probe.audioCodec) args.push('-af', chain.join(','));
	}

	args.push(...encodeVideoArgs(target, quality));

	// Sound that was not touched is copied rather than put through a second
	// encode, which costs nothing and keeps the original quality.
	if (probe.audioCodec && touchesAudio(op)) {
		args.push('-c:a', target.audioCodec ?? 'aac');
	} else {
		args.push(...untouchedAudioArgs(target, probe));
	}

	args.push('-y', outName);
	return makePlan(args, 'none', 'slow');
}

/** True when this edit needs the font written into ffmpeg's filesystem first. */
export function needsFont(op: EditOp): boolean {
	return op.kind === 'text';
}
