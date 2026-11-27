/**
 * Puts `text` on the clipboard; true once it is there. Call it from a
 * click: the fallback needs the user's gesture.
 *
 * The Clipboard API exists only in a secure context (HTTPS or localhost).
 * A crb served over plain http on another address (a tailnet IP, opened
 * from a phone) has none, so this falls back to copying a selected,
 * off-screen textarea with `execCommand("copy")`, which browsers still
 * honour inside a click. The fallback runs before any await, so it keeps
 * the gesture.
 *
 * `near` is an element by the Copy button (the field showing the text, or
 * the button). Inside a modal dialog (`showModal()`) the rest of the page
 * is inert: a textarea added to the body can't be focused or selected, so
 * nothing is copied, yet `execCommand` still answers true (CAR-278). The
 * textarea therefore goes into the dialog `near` is in (else the focused
 * element's, else the top-most open modal), and the copy only counts when
 * the textarea really held the focus and the whole text was selected.
 */
export async function copyText(
	text: string,
	near?: Element | null,
): Promise<boolean> {
	const clipboard = window.isSecureContext ? navigator.clipboard : undefined;
	if (!clipboard?.writeText) return legacyCopy(text, near);
	try {
		await clipboard.writeText(text);
		return true;
	} catch {
		return legacyCopy(text, near);
	}
}

/** Where the fallback's textarea can take focus: the open dialog, else the body. */
function host(near: Element | null | undefined): HTMLElement {
	const from = (el: Element | null | undefined) =>
		el?.closest<HTMLDialogElement>("dialog[open]") ?? null;
	return (
		from(near) ?? from(document.activeElement) ?? topModal() ?? document.body
	);
}

/**
 * The last open modal dialog in document order, if the browser can tell.
 * The top layer's order can't be read, so with two modals open this may
 * pick the lower one; that one is inert under the top one, the textarea
 * can't take the focus there, and `held` reports a failed copy: it can
 * only err toward "Copy failed", never a false check. It is only the last
 * resort anyway, after the dialog of the field and of the focus.
 */
function topModal(): HTMLDialogElement | null {
	const open = [...document.querySelectorAll("dialog[open]")].reverse();
	for (const d of open) {
		try {
			if (d.matches(":modal")) return d as HTMLDialogElement;
		} catch {
			return null;
		}
	}
	return null;
}

function legacyCopy(text: string, near?: Element | null): boolean {
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.setAttribute("aria-hidden", "true");
	// Off-screen, and 16px so iOS doesn't zoom in on its focus.
	area.style.cssText =
		"position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
	const back = document.activeElement;
	host(near).append(area);
	area.focus({ preventScroll: true });
	area.select();
	// iOS selects nothing with select() alone.
	area.setSelectionRange(0, area.value.length);
	let ok = false;
	try {
		ok = held(area) && document.execCommand("copy") && held(area);
	} catch {
		ok = false;
	}
	area.remove();
	if (back instanceof HTMLElement) back.focus({ preventScroll: true });
	return ok;
}

/**
 * Whether `area` has the focus and its whole text selected: what "copy"
 * copies. Measured on `area.value`, not the text given: a textarea turns
 * "\r\n" (GitHub bodies) into "\n", so the lengths differ. `execCommand`'s own answer isn't proof (it is true with nothing
 * selected).
 */
function held(area: HTMLTextAreaElement): boolean {
	return (
		document.activeElement === area &&
		area.selectionStart === 0 &&
		area.selectionEnd === area.value.length
	);
}
