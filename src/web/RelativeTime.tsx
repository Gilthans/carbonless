import { useSyncExternalStore } from "react";
import { Tooltip } from "./Tooltip";

const MINUTE = 60_000;

// ---- One shared clock: a single interval for every RelativeTime on the page.

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function tick() {
	now = Date.now();
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!timer) {
		tick();
		timer = setInterval(tick, MINUTE);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};
}

function getNow() {
	// While nothing is subscribed the clock is not ticking: catch up first.
	if (!timer && Date.now() - now >= MINUTE / 2) now = Date.now();
	return now;
}

/** The current time, refreshed every minute and shared by all callers. */
export function useNow(): number {
	return useSyncExternalStore(subscribe, getNow, getNow);
}

// ---- Formatting (formatters are cached: many dates render each minute)

const cache = new Map<string, Intl.RelativeTimeFormat | Intl.DateTimeFormat>();

function cached<T extends Intl.RelativeTimeFormat | Intl.DateTimeFormat>(
	key: string,
	make: () => T,
): T {
	let format = cache.get(key) as T | undefined;
	if (!format) {
		format = make();
		cache.set(key, format);
	}
	return format;
}

/**
 * Rounded like GitHub: "now", "6 hours ago", "2 days ago" (47 hours), or
 * "in 2 minutes" for clock skew. Localized by Intl.RelativeTimeFormat.
 */
export function relativeTime(
	date: Date,
	nowMs: number,
	locale?: string,
): string {
	const diff = date.getTime() - nowMs;
	const sign = diff < 0 ? -1 : 1;
	const seconds = Math.round(Math.abs(diff) / 1000);
	if (seconds < 45) {
		return cached(
			`rel-auto:${locale}`,
			() => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
		).format(0, "second");
	}
	const minutes = Math.round(seconds / 60);
	const hours = Math.round(minutes / 60);
	const days = Math.round(hours / 24);
	const months = Math.round(days / 30.44);
	const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] =
		minutes < 45
			? [Math.max(1, minutes), "minute"]
			: hours < 22
				? [Math.max(1, hours), "hour"]
				: days < 26
					? [Math.max(1, days), "day"]
					: months < 11
						? [Math.max(1, months), "month"]
						: [Math.max(1, Math.round(days / 365.25)), "year"];
	return cached(
		`rel:${locale}`,
		() => new Intl.RelativeTimeFormat(locale, { numeric: "always" }),
	).format(sign * amount, unit);
}

/** "Sunday, January 4, 2026 at 11:00:00 AM Israel Standard Time". */
export function fullDate(
	date: Date,
	opts: { locale?: string; timeZone?: string } = {},
): string {
	return cached(
		`full:${opts.locale}:${opts.timeZone}`,
		() =>
			new Intl.DateTimeFormat(opts.locale, {
				weekday: "long",
				year: "numeric",
				month: "long",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				second: "2-digit",
				timeZoneName: "long",
				timeZone: opts.timeZone,
			}),
	).format(date);
}

/**
 * A date as short relative text that stays current, with the exact local date,
 * time and time zone name on hover or keyboard focus. Renders nothing for a
 * missing or invalid date.
 */
export function RelativeTime(props: {
	iso: string;
	/** For tests; the viewer's own zone and locale otherwise. */
	timeZone?: string;
	locale?: string;
	className?: string;
}) {
	const nowMs = useNow();
	const date = new Date(props.iso);
	if (!props.iso || Number.isNaN(date.getTime())) return null;
	const full = fullDate(date, {
		locale: props.locale,
		timeZone: props.timeZone,
	});
	return (
		<Tooltip content={full}>
			{(trigger) => (
				<time
					{...trigger}
					dateTime={props.iso}
					// Focusable so keyboard users can open the exact date too.
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className={`cursor-help rounded-sm underline decoration-slate-300 decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-600 ${props.className ?? ""}`}
				>
					{relativeTime(date, nowMs, props.locale)}
				</time>
			)}
		</Tooltip>
	);
}
