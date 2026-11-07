# ffmpeg-wasm-video

This is the video code from [imagetoolbox.org](https://imagetoolbox.org/video),
where it runs the free video converters and editors in the browser. You can try
every part of it there before you install it.

It does video conversion and editing with
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), with nothing uploaded
anywhere. It turns "the user wants this clip trimmed" into the ffmpeg arguments
that do it, and a small runner loads the core and runs them.

Most of the work went into the parts that fail quietly. Escaped inside the
filter, a caption loses its apostrophe, and a comma after one fails the whole
filter. So captions go to `drawtext` as a file, where every character is text.

A Chrome recording comes out with washed-out greys, because ffmpeg.wasm drops
the colour tag from the MOV or MP4. And a stream copy into a container that
claims to hold the codec can give a file that won't play.

The tests cover those cases. Several of them run the real ffmpeg.wasm build and
check the pixels that come out, rather than trusting the docs.

What is in it:

- **Conversion** between MP4, MOV, WebM, MKV and AVI, and out to GIF and MP3.
  The stream is copied when the target container can hold it, which takes
  milliseconds. A re-encode only runs when the copy is impossible or fails.
- **Edits:** trim (keyframe-fast or frame-exact), crop, resize, rotate and
  flip, speed, frame rate, blur, captions, mute, compress.
- **Slow motion and speed ramps:** stretch one section to a given length, or
  draw a curve of speed over time and get a concat of retimed pieces with the
  audio following along.
- **Merging** several clips, copying when they match and fitting them to one
  size when they do not, without dropping the sound of the clips that have
  any.
- **Frame extraction** to numbered JPG or PNG files, at a set rate or every
  frame, with a cap so a two-minute 60 fps clip does not become 7,200 files by
  accident.
- **A phone frame** around a screen recording or a screenshot: rounded corners,
  a black bezel, and a background colour or transparent corners (WebM only).
- **Probing:** reads duration, size, codecs, frame rate, rotation and colour
  out of ffmpeg's own log, and reads the colour tag from the MP4/MOV file itself
  when ffmpeg loses it.

Everything except `ffmpeg.ts` is plain TypeScript with no browser or ffmpeg
dependency. You can use the planners with your own runner, in a worker, or with
a native ffmpeg on a server.

## Install

```sh
npm install ffmpeg-wasm-video @ffmpeg/core@0.12.10
```

It's plain ES modules with type declarations, so any bundler takes it, and the
planners run in Node as well. `@ffmpeg/ffmpeg` comes with it. The core is yours
to serve, and every setting here was measured against version 0.12.10.

## Serve the core

ffmpeg.wasm runs its core inside a worker, which refuses cross-origin and blob
URLs. Copy `ffmpeg-core.js` and `ffmpeg-core.wasm` from
`node_modules/@ffmpeg/core/dist/esm/` into your static files.

Put them under a path with the version in it, so they can be cached for a long
time:

```
public/ffmpeg/0.12.10/ffmpeg-core.js
public/ffmpeg/0.12.10/ffmpeg-core.wasm
```

The core is about 32 MB, around 7 MB with brotli. `loadFfmpeg` reports the
download so you can show real progress instead of a spinner.

## Use

```ts
import { loadFfmpeg, convertVideo, editVideo, VIDEO_FORMATS } from 'ffmpeg-wasm-video';

const ff = await loadFfmpeg(
	{
		coreURL: '/ffmpeg/0.12.10/ffmpeg-core.js',
		wasmURL: '/ffmpeg/0.12.10/ffmpeg-core.wasm',
		// only needed for captions: any TrueType font you serve
		fontURL: '/fonts/caption.ttf'
	},
	({ ratio }) => console.log('core', ratio)
);

// MOV to MP4. Usually a copy, so it is done before the bar has moved.
const mp4 = await convertVideo(ff, file, VIDEO_FORMATS.mp4, {
	onProgress: (ratio) => console.log(ratio)
});
mp4.blob; // the result
mp4.fullCopy; // true when nothing was re-encoded

// Trim from 0:05 to 0:12, frame-exact, keeping the container it came in.
const trimmed = await editVideo(
	ff,
	file,
	{ kind: 'trim', startSeconds: 5, endSeconds: 12, exact: true },
	VIDEO_FORMATS.mp4
);
```

The other runners are `extractFrames(ff, file, request)`,
`mergeVideos(ff, files, target)` and `readStill(ff, file)`. Every edit is one
`EditOp`. The type in `src/edit.ts` has the full list and what each field means.

### Just the arguments

If you run ffmpeg yourself, skip `ffmpeg.ts` and call the planners. They take
a `ProbeResult`, which `parseProbe` builds from the lines ffmpeg prints for
`ffmpeg -i input`.

```ts
import { parseProbe, planConversion, planEdit, VIDEO_FORMATS } from 'ffmpeg-wasm-video';

const probe = parseProbe(logLines);

const plan = planConversion(VIDEO_FORMATS.webm, probe, 'output.webm');
plan.args; // ['-i', 'input', ...]
plan.expectation; // 'instant' | 'quick' | 'slow'

const blur = planEdit({ kind: 'blur', strength: 8 }, VIDEO_FORMATS.mp4, probe, 'output.mp4');
```

The input file is always called `input` inside ffmpeg's filesystem. A caption
also needs its text in `CAPTION_FILE` and a font in `FONT_FILE`, and
`captionFor(op)` gives you the text to write.

## Develop

```sh
pnpm install
pnpm test    # vitest, with pixel tests against the real ffmpeg.wasm core
pnpm check   # tsc
pnpm build   # dist/
```

`npm publish` builds the package and runs the tests and the type check first.
The font in `fixtures/` is only for the tests. It's Roboto Bold, under the
Apache License beside it.

## License

MIT. Copyright Teorimester AS.

The ffmpeg core itself, `@ffmpeg/core`, is GPL-2.0-or-later. This package only
loads it, and it's the core's licence that applies to the file you serve.
