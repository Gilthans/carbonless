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

// ---- Formatting

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 60 * MINUTE],
	["month", 30 * 24 * 60 * MINUTE],
	["day", 24 * 60 * MINUTE],
	["hour", 60 * MINUTE],
	["minute", MINUTE],
];

/** "just now", "6 hours ago", "3 days ago" (or "in 2 minutes" for clock skew). */
export function relativeTime(
	date: Date,
	nowMs: number,
	locale?: string,
): string {
	const diff = date.getTime() - nowMs;
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
	for (const [unit, ms] of UNITS) {
		const amount = Math.trunc(diff / ms);
		if (amount !== 0) return format.format(amount, unit);
	}
	return "just now";
}

/** "Sunday, January 4, 2026 at 11:00:00 AM Israel Standard Time". */
export function fullDate(
	date: Date,
	opts: { locale?: string; timeZone?: string } = {},
): string {
	return new Intl.DateTimeFormat(opts.locale, {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "long",
		timeZone: opts.timeZone,
	}).format(date);
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
