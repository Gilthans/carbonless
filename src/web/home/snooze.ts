// Snooze dates: 09:00 local time, built from local date fields so the hour
// holds across a DST change (never days × 24 h).

const at9 = (d: Date, addDays: number) =>
	new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays, 9, 0, 0, 0);

/** A date input's value: "2026-10-29". */
export const ymd = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The earliest date the picker offers: tomorrow. */
export const minPick = (now: Date) => ymd(at9(now, 1));

const hintOf = (d: Date) =>
	`${new Intl.DateTimeFormat("en", { weekday: "short" }).format(d)} 09:00`;

/** Tomorrow, in 3 days and next Monday, each at 09:00 local time. */
export function snoozePresets(now: Date): {
	label: string;
	hint: string;
	until: Date;
}[] {
	// Days to the next Monday, strictly after today (a Monday: a week on).
	const toMonday = (8 - now.getDay()) % 7 || 7;
	return [
		{ label: "Tomorrow", days: 1 },
		{ label: "In 3 days", days: 3 },
		{ label: "Next Monday", days: toMonday },
	].map(({ label, days }) => {
		const until = at9(now, days);
		return { label, hint: hintOf(until), until };
	});
}

/** A picked "2026-11-02" as 09:00 local that day; null unless a real date after `now`. */
export function pickedDate(value: string, now: Date): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
	const date = new Date(y, mo, d, 9);
	// No rolling over: 2026-13-40 is not a date.
	if (
		date.getFullYear() !== y ||
		date.getMonth() !== mo ||
		date.getDate() !== d
	)
		return null;
	return date.getTime() > now.getTime() ? date : null;
}
