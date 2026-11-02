// The snooze dates are local 09:00: checked in a zone with DST, against
// literal instants, so a UTC shortcut (setUTCHours, days × 24 h) fails.
process.env.TZ = "America/New_York";

import { describe, expect, it } from "vitest";
import { pickedDate, snoozePresets } from "./snooze";

describe("snooze dates in America/New_York", () => {
	it("runs in the zone it names", () => {
		expect(new Date(2026, 9, 31, 15).toISOString()).toBe(
			"2026-10-31T19:00:00.000Z",
		);
	});

	it("gives tomorrow, in 3 days and next Monday at 09:00 local, across the fall-back", () => {
		// Saturday 31 Oct 2026, 15:00 EDT; clocks go back on Sunday 1 Nov.
		const sat = new Date("2026-10-31T19:00:00.000Z");
		const [tomorrow, three, monday] = snoozePresets(sat);
		expect(tomorrow?.until.toISOString()).toBe("2026-11-01T14:00:00.000Z");
		expect(three?.until.toISOString()).toBe("2026-11-03T14:00:00.000Z");
		expect(monday?.until.toISOString()).toBe("2026-11-02T14:00:00.000Z");
		expect(tomorrow?.hint).toBe("Sun 09:00");
		expect(monday?.hint).toBe("Mon 09:00");
	});

	it("keeps 09:00 across the spring-forward", () => {
		// Saturday 7 Mar 2026, 12:00 EST; clocks go forward on Sunday 8 Mar.
		const sat = new Date("2026-03-07T17:00:00.000Z");
		expect(snoozePresets(sat)[0]?.until.toISOString()).toBe(
			"2026-03-08T13:00:00.000Z",
		);
	});

	it("on a Monday, next Monday is a week on; on a Sunday, it's tomorrow", () => {
		const mon = new Date("2026-11-02T13:00:00.000Z"); // 08:00 EST
		expect(snoozePresets(mon)[2]?.until.toISOString()).toBe(
			"2026-11-09T14:00:00.000Z",
		);
		const sun = new Date("2026-11-01T20:00:00.000Z");
		expect(snoozePresets(sun)[2]?.until.toISOString()).toBe(
			"2026-11-02T14:00:00.000Z",
		);
	});

	it("a picked date is 09:00 local that day, and only in the future", () => {
		const now = new Date("2026-10-31T19:00:00.000Z");
		expect(pickedDate("2026-11-02", now)?.toISOString()).toBe(
			"2026-11-02T14:00:00.000Z",
		);
		expect(
			pickedDate("2026-03-08", new Date("2026-03-01T12:00:00Z"))?.toISOString(),
		).toBe("2026-03-08T13:00:00.000Z");
		expect(pickedDate("2026-10-30", now)).toBeNull();
		expect(pickedDate("", now)).toBeNull();
		expect(pickedDate("2026-13-40", now)).toBeNull();
	});
});
