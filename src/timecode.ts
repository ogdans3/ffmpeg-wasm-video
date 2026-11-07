/**
 * Reading and writing a position in a clip.
 *
 * The rest of the video section works in plain seconds, because every control
 * it has is a slider over a clip a few seconds long. Slowing a section down is
 * the first page where somebody arrives already knowing where the interesting
 * part is, and they know it as "2:32" because that is what their player showed
 * them. Typing 152 instead is arithmetic the page can do itself.
 *
 * Pure, so it is tested rather than trusted. Both directions matter: a value
 * that round trips wrong moves the visitor's mark without telling them.
 */

/**
 * Seconds from "2:32", "1:02:03.5" or "152.4", or null when it is not a time.
 *
 * Deliberately forgiving about what it accepts and strict about what it
 * rejects: an empty box is null rather than zero, because zero is a real
 * answer somebody might have meant and a half typed value is not.
 */
export function parseTimecode(input: string): number | null {
	const text = input.trim();
	if (!text) return null;
	// Up to five digits on the leading field, because it is only the hours
	// when there are two colons. With no colon at all it is seconds, and 1000
	// seconds is exactly the sort of length this page is asked for.
	if (!/^\d{1,5}(:[0-5]?\d){0,2}(\.\d+)?$/.test(text)) return null;

	const parts = text.split(':');
	// Minutes and seconds only make sense read from the right: "2:32" is two
	// minutes and "1:02:03" is an hour, so the last field is always seconds.
	const seconds = Number(parts[parts.length - 1]);
	const minutes = parts.length > 1 ? Number(parts[parts.length - 2]) : 0;
	const hours = parts.length > 2 ? Number(parts[0]) : 0;
	const total = hours * 3600 + minutes * 60 + seconds;
	return Number.isFinite(total) ? total : null;
}

/**
 * Seconds as "2:32.4", or "1:02:03.4" once there is an hour of it.
 *
 * One decimal, because the sliders step in tenths and a readout with more
 * precision than the control that produced it is a lie about how exact the
 * mark is.
 */
export function formatTimecode(seconds: number): string {
	const safe = Math.max(0, seconds);
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe % 3600) / 60);
	const rest = safe % 60;
	const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
	const secondsText = rest < 10 ? `0${rest.toFixed(1)}` : rest.toFixed(1);
	return hours ? `${hours}:${pad(minutes)}:${secondsText}` : `${minutes}:${secondsText}`;
}
