import type { DiffSide, ThreadAnchorRef } from "../../shared/types.js";
import { InvalidPlacementError } from "./threads.js";

/**
 * A placement request: a patch set number and an anchor whose sides are
 * LEFT or RIGHT, lines positive integers and path a non-empty string (the
 * session checks it against the patch set's files).
 */
export function parsePlacementBody(body: unknown): {
	patchset: number;
	anchor: ThreadAnchorRef;
} {
	const fail = (message: string) => new InvalidPlacementError(message);
	if (typeof body !== "object" || body === null) {
		throw fail("A placement is { patchset, anchor }");
	}
	const { patchset, anchor } = body as { patchset?: unknown; anchor?: unknown };
	if (
		typeof patchset !== "number" ||
		!Number.isInteger(patchset) ||
		patchset < 1
	) {
		throw fail("patchset must be a patch set number");
	}
	if (typeof anchor !== "object" || anchor === null) {
		throw fail("anchor is required");
	}
	const { path, startSide, startLine, side, line } = anchor as Record<
		string,
		unknown
	>;
	const isSide = (v: unknown): v is DiffSide => v === "LEFT" || v === "RIGHT";
	const isLine = (v: unknown): v is number =>
		typeof v === "number" && Number.isInteger(v) && v >= 1 && v < 2 ** 31;
	if (typeof path !== "string" || path === "" || path.length > 4096) {
		throw fail("anchor.path must be a file's path");
	}
	if (!isSide(side) || !isSide(startSide)) {
		throw fail("anchor sides must be LEFT or RIGHT");
	}
	if (!isLine(line) || !isLine(startLine)) {
		throw fail("anchor lines must be positive integers");
	}
	return { patchset, anchor: { path, startSide, startLine, side, line } };
}
