import {
	MAX_GITHUB_THREAD_ID,
	MAX_MOVE_PATH,
	type MoveRequest,
	type ThreadRef,
} from "../../shared/rereview/moves.js";
import type { DiffSide, ThreadAnchorRef } from "../../shared/types.js";
import { isLowerUlid } from "../review/events.js";
import { InvalidPlacementError } from "./threads.js";

const fail = (message: string) => new InvalidPlacementError(message);
const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isSide = (v: unknown): v is DiffSide => v === "LEFT" || v === "RIGHT";
const isLine = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 1 && v < 2 ** 31;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A move's thread: `{source: "agent", id: <lowercase ULID>}` or `{source: "github", id: <node id>}`. */
export function parseThreadRef(raw: unknown): ThreadRef {
	if (!isObj(raw)) throw fail("thread is { source, id }");
	const { source, id } = raw;
	if (source === "agent") {
		if (typeof id === "string" && isLowerUlid(id)) return { source, id };
		throw fail("An agent thread's id is a lowercase ULID");
	}
	if (source === "github") {
		if (
			typeof id === "string" &&
			id !== "" &&
			id.length <= MAX_GITHUB_THREAD_ID
		)
			return { source, id };
		throw fail("A GitHub thread's id is 1 to 200 characters");
	}
	throw fail("thread.source must be agent or github");
}

/** `{patchset}` or `{head}`, one of them (the target viewed). */
export function parseMoveTarget(
	raw: unknown,
): { patchset: number } | { head: string } {
	if (!isObj(raw)) throw fail("to is { patchset } or { head }");
	const { patchset, head } = raw;
	if ((patchset === undefined) === (head === undefined)) {
		throw fail("to: a patch set or a head, one of them");
	}
	if (patchset !== undefined) {
		if (!isLine(patchset)) throw fail("to.patchset must be a patch set number");
		return { patchset };
	}
	if (typeof head !== "string" || !OID.test(head)) {
		throw fail("to.head must be a commit id");
	}
	return { head };
}

/**
 * A move's lines: sides LEFT or RIGHT, lines positive integers (start not
 * after end on one side) and a path of at most MAX_MOVE_PATH bytes (the
 * session checks it against the target's files). Only these fields.
 */
export function parseMoveAnchor(raw: unknown): ThreadAnchorRef {
	if (!isObj(raw)) throw fail("anchor is required");
	const { path, startSide, startLine, side, line } = raw;
	if (
		typeof path !== "string" ||
		path === "" ||
		Buffer.byteLength(path) > MAX_MOVE_PATH
	) {
		throw fail("anchor.path must be a file's path");
	}
	if (!isSide(side) || !isSide(startSide)) {
		throw fail("anchor sides must be LEFT or RIGHT");
	}
	if (!isLine(line) || !isLine(startLine)) {
		throw fail("anchor lines must be positive integers");
	}
	if (side === startSide && startLine > line) {
		throw fail("anchor must start before it ends");
	}
	return { path, startSide, startLine, side, line };
}

/**
 * POST /moves's body: `{thread, to, anchor}`, each checked; nothing else
 * is taken (the snapshot's base and head are the server's, never the
 * body's).
 */
export function parseMoveBody(body: unknown): MoveRequest {
	if (!isObj(body)) throw fail("A move is { thread, to, anchor }");
	return {
		thread: parseThreadRef(body.thread),
		to: parseMoveTarget(body.to),
		anchor: parseMoveAnchor(body.anchor),
	};
}
