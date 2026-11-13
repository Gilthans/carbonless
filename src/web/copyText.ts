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
 */
export async function copyText(text: string): Promise<boolean> {
	const clipboard = window.isSecureContext ? navigator.clipboard : undefined;
	if (!clipboard?.writeText) return legacyCopy(text);
	try {
		await clipboard.writeText(text);
		return true;
	} catch {
		return legacyCopy(text);
	}
}

function legacyCopy(text: string): boolean {
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.setAttribute("aria-hidden", "true");
	// Off-screen, and 16px so iOS doesn't zoom in on its focus.
	area.style.cssText =
		"position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
	const back = document.activeElement;
	document.body.append(area);
	area.focus();
	area.select();
	// iOS selects nothing with select() alone.
	area.setSelectionRange(0, text.length);
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	area.remove();
	if (back instanceof HTMLElement) back.focus({ preventScroll: true });
	return ok;
}
