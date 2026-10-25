// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fullDate, RelativeTime, relativeTime } from "./RelativeTime";

const NOW = new Date("2026-01-04T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
	const at = (ms: number) => relativeTime(ago(ms), NOW.getTime(), "en-US");

	it("says just now under a minute, in either direction", () => {
		expect(at(0)).toBe("just now");
		expect(at(59_000)).toBe("just now");
		expect(at(-30_000)).toBe("just now");
	});

	it("uses the largest whole unit", () => {
		expect(at(MIN)).toBe("1 minute ago");
		expect(at(59 * MIN)).toBe("59 minutes ago");
		expect(at(6 * HOUR)).toBe("6 hours ago");
		expect(at(3 * DAY)).toBe("3 days ago");
		expect(at(45 * DAY)).toBe("1 month ago");
		expect(at(800 * DAY)).toBe("2 years ago");
	});

	it("handles a date in the future (clock skew)", () => {
		expect(at(-5 * MIN)).toBe("in 5 minutes");
	});
});

describe("fullDate", () => {
	it("gives the exact date, time and long time zone name", () => {
		const d = new Date("2026-01-04T09:30:15Z");
		expect(fullDate(d, { locale: "en-US", timeZone: "Asia/Jerusalem" })).toBe(
			"Sunday, January 4, 2026 at 11:30:15 AM Israel Standard Time",
		);
		expect(fullDate(d, { locale: "en-US", timeZone: "UTC" })).toBe(
			"Sunday, January 4, 2026 at 9:30:15 AM Coordinated Universal Time",
		);
	});
});

describe("RelativeTime", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			now: NOW,
			toFake: ["Date", "setInterval", "clearInterval"],
		});
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	const renderAt = (iso: string) =>
		render(<RelativeTime iso={iso} locale="en-US" timeZone="Asia/Jerusalem" />);

	it("renders a semantic <time> with short relative text", () => {
		const { container } = renderAt("2026-01-04T06:00:00Z");
		const time = container.querySelector("time");
		expect(time).toHaveAttribute("dateTime", "2026-01-04T06:00:00Z");
		expect(time).toHaveTextContent("6 hours ago");
	});

	it("updates as time passes, on one shared minute tick", async () => {
		const spy = vi.spyOn(globalThis, "setInterval");
		const { container } = render(
			<>
				<RelativeTime iso="2026-01-04T11:59:30Z" locale="en-US" />
				<RelativeTime iso="2026-01-04T06:00:00Z" locale="en-US" />
			</>,
		);
		const [first, second] = container.querySelectorAll("time");
		expect(first).toHaveTextContent("just now");
		expect(spy).toHaveBeenCalledTimes(1);
		act(() => {
			vi.advanceTimersByTime(60 * MIN);
		});
		expect(first).toHaveTextContent("1 hour ago");
		expect(second).toHaveTextContent("7 hours ago");
		spy.mockRestore();
	});

	it("shows the full date and time zone on hover and on keyboard focus", async () => {
		vi.useRealTimers();
		const user = userEvent.setup();
		const { container } = renderAt("2026-01-04T09:30:15Z");
		const time = container.querySelector("time");
		if (!time) throw new Error("no <time>");
		const full = "Sunday, January 4, 2026 at 11:30:15 AM Israel Standard Time";
		// Always the accessible description, visible only when opened.
		expect(time).toHaveAccessibleDescription(full);
		expect(screen.queryByRole("tooltip")).toBeNull();

		await user.hover(time);
		expect(screen.getByRole("tooltip")).toHaveTextContent(full);
		await user.unhover(time);
		expect(screen.queryByRole("tooltip")).toBeNull();

		await user.tab();
		expect(time).toHaveFocus();
		expect(screen.getByRole("tooltip")).toHaveTextContent(full);
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("tooltip")).toBeNull();
		await user.tab();
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("renders nothing for a missing or invalid date", () => {
		expect(renderAt("").container).toBeEmptyDOMElement();
		cleanup();
		expect(renderAt("not a date").container).toBeEmptyDOMElement();
	});
});
