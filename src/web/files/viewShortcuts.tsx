import { useShortcut } from "../shortcuts";
import { NOT_PHONE, useMedia } from "../useMedia";
import { ignoreWhitespace, showInvisibles, sideBySide } from "../viewSettings";

/** The keys that flip Settings' diff switches (shown on their rows too). */
export const VIEW_KEYS = {
	showInvisibles: "h",
	ignoreWhitespace: "w",
	sideBySide: "s",
} as const;

/**
 * `h`, `w` and `s` toggle "Show hidden characters", "Ignore whitespace" and
 * "Side by side" on Files changed (where the diff is): registered where the
 * page mounts, under its group in the help. Desktop only: a phone has no
 * shortcuts. The row being read stays put, as with the switch (the
 * settings' `subscribe` anchors it).
 */
export function useViewShortcuts(): void {
	const wide = useMedia(NOT_PHONE);
	const when = () => wide;
	useShortcut({
		keys: VIEW_KEYS.showInvisibles,
		label: "Show hidden characters",
		group: "Files changed",
		when,
		run: () => showInvisibles.toggle(),
	});
	useShortcut({
		keys: VIEW_KEYS.ignoreWhitespace,
		label: "Ignore whitespace",
		group: "Files changed",
		when,
		run: () => ignoreWhitespace.toggle(),
	});
	useShortcut({
		keys: VIEW_KEYS.sideBySide,
		label: "Side by side",
		group: "Files changed",
		when,
		run: () => sideBySide.toggle(),
	});
}
