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

/**
 * "2026 Aug 31, 22:11:13 Israel Time": year first, short month, day, 24-hour
 * time with seconds and the zone's generic name. Always English (the order is
 * fixed); the viewer's own zone unless `timeZone` is given.
 */
export function fullDate(date: Date, opts: { timeZone?: string } = {}): string {
	const format = cached(`full:${opts.timeZone}`, () => {
		const options: Intl.DateTimeFormatOptions = {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
			timeZone: opts.timeZone,
		};
		try {
			return new Intl.DateTimeFormat("en", {
				...options,
				timeZoneName: "longGeneric",
			});
		} catch {
			// An engine without generic zone names.
			return new Intl.DateTimeFormat("en", {
				...options,
				timeZoneName: "long",
			});
		}
	});
	const parts = format.formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? "";
	let zone = part("timeZoneName");
	// UTC has no generic name: Intl says "GMT+00:00" or the like.
	if (
		UTC_ZONES.has(format.resolvedOptions().timeZone) &&
		/^(GMT|UTC)([+-]0?0(:?00)?)?$/.test(zone)
	) {
		zone = "UTC";
	}
	return `${part("year")} ${part("month")} ${part("day")}, ${part("hour")}:${part("minute")}:${part("second")} ${zone}`;
}

const UTC_ZONES = new Set([
	"UTC",
	"Etc/UTC",
	"Etc/GMT",
	"GMT",
	"Etc/Universal",
	"Etc/Zulu",
]);

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
	const full = fullDate(date, { timeZone: props.timeZone });
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
