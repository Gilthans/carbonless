import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	parseShippedReleaseNotes,
	type ShippedReleaseNotes,
} from "../../shared/releaseNotes.js";
import type {
	NotesSection,
	OwnNotes,
	UpdateNotes,
} from "../../shared/whatsNew.js";
import {
	MAX_MANIFEST,
	PACKAGE,
	RegistryError,
	readCapped,
	TIMEOUT_MS,
} from "./registry.js";
import { compareVersions, parseVersion, type Version } from "./semver.js";

/** The largest manifest read for its notes (spec section 6): registry.ts's. */
export { MAX_MANIFEST };

/** A package's notes, read and checked (parseShippedReleaseNotes). */
export interface ParsedNotes {
	entries: ShippedReleaseNotes[];
	/** Entries dropped whole (their version unknown: counted wherever shown). */
	dropped: number;
	/** Notes dropped inside a version's entry, by version. */
	droppedIn?: Record<string, number>;
}

/**
 * The most entries read: a sanity bound only. The package's own file
 * carries every release, uncapped (the manifest's field, at most ten).
 */
const MAX_ENTRIES = 10_000;

/**
 * `raw` read with CAR-200's parseShippedReleaseNotes an entry at a time,
 * so what was dropped is known per version (the modal counts only the
 * versions it shows). Null when `raw` isn't a list.
 */
function parseNotes(raw: unknown): ParsedNotes | null {
	if (!Array.isArray(raw)) return null;
	const out: Required<ParsedNotes> = { entries: [], dropped: 0, droppedIn: {} };
	for (const item of raw.slice(0, MAX_ENTRIES)) {
		const one = parseShippedReleaseNotes([item]);
		const entry = one?.entries[0];
		if (!one || !entry) {
			out.dropped += one?.dropped ?? 1;
			continue;
		}
		out.entries.push(entry);
		out.droppedIn[entry.version] =
			(out.droppedIn[entry.version] ?? 0) + one.dropped;
	}
	out.dropped += Math.max(0, raw.length - MAX_ENTRIES);
	return out;
}

/**
 * The notes `version` carries on the registry: its manifest's
 * `crbReleaseNotes` (one small request covers every version between, as
 * each build carries the last ten). Read capped, every field checked.
 * Throws a RegistryError with a short reason the modal shows.
 */
export async function fetchOfferedNotes(
	version: string,
	opts: { registry: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<ParsedNotes> {
	if (!parseVersion(version)) throw new RegistryError("Not a version");
	const get = opts.fetch ?? fetch;
	let res: Response;
	try {
		res = await get(
			`${opts.registry}/${PACKAGE}/${encodeURIComponent(version)}`,
			{
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
			},
		);
	} catch (error) {
		throw new RegistryError(
			(error as Error)?.name === "TimeoutError"
				? "Registry timed out"
				: "Registry unreachable",
		);
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new RegistryError(`Registry answered ${res.status}`);
	}
	let manifest: unknown;
	try {
		const text = await readCapped(res, MAX_MANIFEST);
		if (text === null) throw new Error("too big");
		manifest = JSON.parse(text);
	} catch (error) {
		throw new RegistryError(
			(error as Error)?.name === "TimeoutError"
				? "Registry timed out"
				: "Registry gave a bad answer",
		);
	}
	const field =
		typeof manifest === "object" && manifest !== null
			? (manifest as Record<string, unknown>).crbReleaseNotes
			: undefined;
	if (field === undefined) throw new RegistryError("No notes in this version");
	const parsed = parseNotes(field);
	if (!parsed) throw new RegistryError("Notes unreadable");
	return parsed;
}

/** The running build's notes file (`dist/release-notes.json` in its package). */
const ownNotesFile = (): string =>
	fileURLToPath(new URL("../../../dist/release-notes.json", import.meta.url));

/** The running build's own notes; null when it has no file (a local build). */
export async function readOwnNotes(file: string): Promise<ParsedNotes | null> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return null;
	}
	try {
		return parseNotes(JSON.parse(text)) ?? { entries: [], dropped: 1 };
	} catch {
		return { entries: [], dropped: 1 };
	}
}

/** `v` as a release: X.Y.Z of a prerelease, itself otherwise. */
const releaseOf = (v: Version): Version => ({ ...v, pre: [] });

const isPre = (v: Version) => v.pre.length > 0;

function section(
	entry: ShippedReleaseNotes,
	label: string,
	notes = entry.notes,
	uncovered = entry.uncovered ?? [],
): NotesSection {
	const shown = parseVersion(label);
	return {
		version: label,
		date: entry.date,
		notes,
		uncovered,
		// A release has its tag's page; its date may still be unknown (null:
		// the publish day is written after the tarball).
		released: shown !== null && !isPre(shown),
	};
}

/**
 * What's new from `current` to `available`, from the notes `available`
 * carries: the versions after the running one up to the offered one's
 * release, newest first. An entry the running build has too (an RC's
 * upcoming release) keeps only what it doesn't have: notes by id, and
 * changes without notes it already ran. The upcoming release's entry shows
 * as the offered RC.
 */
export function prepareUpdateNotes(
	current: string,
	available: string,
	offered: ParsedNotes,
	own: ParsedNotes | null,
): UpdateNotes {
	const cur = parseVersion(current);
	const av = parseVersion(available);
	if (!cur || !av) throw new Error("Not a version");
	const top = releaseOf(av);
	const mine = new Map((own?.entries ?? []).map((v) => [v.version, v]));
	const ran = new Set<number>();
	for (const v of own?.entries ?? []) {
		for (const n of v.notes) for (const pr of n.prs) ran.add(pr);
		for (const pr of v.uncovered ?? []) ran.add(pr);
	}
	const entries = offered.entries
		.map((v) => ({ v, parsed: parseVersion(v.version) as Version }))
		.filter(
			({ parsed }) =>
				compareVersions(parsed, cur) > 0 && compareVersions(parsed, top) <= 0,
		)
		.sort((a, b) => compareVersions(b.parsed, a.parsed));
	// One entry per version (a repeated one: the first kept).
	const seen = new Set<string>();
	const sections: NotesSection[] = [];
	for (const { v, parsed } of entries) {
		if (seen.has(v.version)) continue;
		seen.add(v.version);
		const had = mine.get(v.version);
		const ids = new Set(had?.notes.map((n) => n.id) ?? []);
		const label =
			isPre(av) && compareVersions(parsed, top) === 0 ? available : v.version;
		sections.push(
			section(
				v,
				label,
				v.notes.filter((n) => !ids.has(n.id)),
				(v.uncovered ?? []).filter((pr) => !ran.has(pr)),
			),
		);
	}
	const reaches = offered.entries.some((v) => {
		const p = parseVersion(v.version);
		return (p && compareVersions(p, cur) <= 0) || mine.has(v.version);
	});
	return {
		current,
		available,
		sections,
		older: !reaches,
		// Only what's missing from the versions shown (and entries whose
		// version couldn't be read: they might be among them).
		dropped:
			offered.dropped +
			[...seen].reduce((n, v) => n + (offered.droppedIn?.[v] ?? 0), 0),
	};
}

/**
 * The running crb's own notes for Global settings: its version's (an RC
 * reads its upcoming release's, under its own version), then the earlier
 * releases the file keeps.
 */
export function prepareOwnNotes(
	current: string,
	own: ParsedNotes | null,
): OwnNotes {
	const cur = parseVersion(current);
	if (!own || !cur) {
		return { current, file: false, running: null, earlier: [], dropped: 0 };
	}
	const base = releaseOf(cur);
	const entry =
		own.entries.find((v) => v.version === current) ??
		own.entries.find((v) => {
			const p = parseVersion(v.version);
			return p !== null && compareVersions(p, base) === 0;
		});
	const earlier = own.entries
		.map((v) => ({ v, parsed: parseVersion(v.version) as Version }))
		.filter(({ parsed }) => compareVersions(parsed, base) < 0)
		.sort((a, b) => compareVersions(b.parsed, a.parsed))
		.map(({ v }) => section(v, v.version));
	return {
		current,
		file: true,
		running: entry ? section(entry, current) : null,
		earlier,
		dropped:
			own.dropped +
			Object.values(own.droppedIn ?? {}).reduce((n, d) => n + d, 0),
	};
}

/** A load's outcome: the notes, or why they didn't come. */
export type NotesResult =
	| { ok: true; notes: ParsedNotes }
	| { ok: false; reason: string };

/**
 * The offered version's notes, kept in memory (a version's manifest never
 * changes): one load per offered version; a failure is kept with its
 * reason until a Retry, or the next check (`afterCheck`, once per check).
 */
export class NotesCache {
	readonly #load: (version: string) => Promise<ParsedNotes>;
	#version: string | null = null;
	#entry: Promise<NotesResult> | null = null;
	#settled: NotesResult | null = null;

	constructor(load: (version: string) => Promise<ParsedNotes>) {
		this.#load = load;
	}

	#start(version: string): Promise<NotesResult> {
		this.#version = version;
		this.#settled = null;
		const run: Promise<NotesResult> = this.#load(version).then(
			(notes) => ({ ok: true as const, notes }),
			(error: unknown) => ({
				ok: false as const,
				reason:
					error instanceof RegistryError
						? error.message
						: "Notes couldn't be read",
			}),
		);
		this.#entry = run;
		void run.then((r) => {
			if (this.#entry === run) this.#settled = r;
		});
		return run;
	}

	/** A check found `version` on offer: load its notes unless they are in (or loading). */
	afterCheck(version: string): void {
		if (
			version !== this.#version ||
			!this.#entry ||
			(this.#settled && !this.#settled.ok)
		) {
			void this.#start(version);
		}
	}

	/** `version`'s notes: the kept ones, the load under way, or a new load. */
	get(version: string): Promise<NotesResult> {
		if (version !== this.#version || !this.#entry) return this.#start(version);
		return this.#entry;
	}

	/** Loads again after a failure; the kept notes or the load under way otherwise. */
	retry(version: string): Promise<NotesResult> {
		if (
			version !== this.#version ||
			!this.#entry ||
			(this.#settled && !this.#settled.ok)
		) {
			return this.#start(version);
		}
		return this.#entry;
	}
}

let ownCache: Promise<ParsedNotes | null> | null = null;

/** The running build's own notes, read once per process. */
export const runningBuildNotes = (): Promise<ParsedNotes | null> => {
	ownCache ??= readOwnNotes(ownNotesFile());
	return ownCache;
};

/** Notes that didn't load, with the reason the modal shows (HTTP 502). */
export class NotesError extends Error {}
