import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ShippedReleaseNotes } from "../../shared/releaseNotes";
import { buildApp } from "../app";
import { SessionRegistry } from "../registry";
import {
	fetchOfferedNotes,
	MAX_MANIFEST,
	NotesCache,
	type ParsedNotes,
	prepareOwnNotes,
	prepareUpdateNotes,
	readOwnNotes,
} from "./notes";
import { RegistryError } from "./registry";
import { Updater } from "./updater";

const v = (
	version: string,
	over: Partial<ShippedReleaseNotes> = {},
): ShippedReleaseNotes => ({
	version,
	date: "2026-11-20",
	notes: [],
	...over,
});

const note = (id: string, pr: number, text = `Note number ${pr}.`) => ({
	id,
	kind: "new" as const,
	prs: [pr],
	text,
});

const servers: Server[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) {
		s.closeAllConnections();
		await new Promise((r) => s.close(r));
	}
});

/** A fake registry: `answer` for each version's manifest; what it was asked. */
async function fakeRegistry(
	answer: (version: string) => { status: number; body?: unknown } | "hang",
): Promise<{ url: string; asked: string[] }> {
	const asked: string[] = [];
	const server = createServer((req, res) => {
		asked.push(req.url ?? "");
		const version = decodeURIComponent(
			(req.url ?? "").replace("/carbonless-review/", ""),
		);
		const a = answer(version);
		if (a === "hang") return;
		res
			.writeHead(a.status, { "content-type": "application/json" })
			.end(JSON.stringify(a.body ?? {}));
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, asked };
}

describe("fetchOfferedNotes", () => {
	it("reads the version's manifest's crbReleaseNotes", async () => {
		const r = await fakeRegistry(() => ({
			status: 200,
			body: {
				name: "carbonless-review",
				version: "0.5.0",
				crbReleaseNotes: [v("0.5.0", { notes: [note("CAR-1", 10)] })],
			},
		}));
		const got = await fetchOfferedNotes("0.5.0", { registry: r.url });
		expect(r.asked).toEqual(["/carbonless-review/0.5.0"]);
		expect(got.dropped).toBe(0);
		expect(got.entries[0]?.notes).toEqual([note("CAR-1", 10)]);
	});

	it("says why it failed: a 404, no field, a bad answer, too big, a timeout, unreachable", async () => {
		const missing = await fakeRegistry(() => ({ status: 404 }));
		await expect(
			fetchOfferedNotes("0.5.0", { registry: missing.url }),
		).rejects.toThrow("Registry answered 404");
		const bare = await fakeRegistry(() => ({
			status: 200,
			body: { version: "0.5.0" },
		}));
		await expect(
			fetchOfferedNotes("0.5.0", { registry: bare.url }),
		).rejects.toThrow("No notes in this version");
		const notList = await fakeRegistry(() => ({
			status: 200,
			body: { crbReleaseNotes: { "0.5.0": [] } },
		}));
		await expect(
			fetchOfferedNotes("0.5.0", { registry: notList.url }),
		).rejects.toThrow("Notes unreadable");
		await expect(
			fetchOfferedNotes("0.5.0", {
				registry: "http://x",
				fetch: async () => new Response("not json"),
			}),
		).rejects.toThrow("Registry gave a bad answer");
		const big = await fakeRegistry(() => ({
			status: 200,
			body: { crbReleaseNotes: [], pad: "x".repeat(MAX_MANIFEST) },
		}));
		await expect(
			fetchOfferedNotes("0.5.0", { registry: big.url }),
		).rejects.toThrow("Registry gave a bad answer");
		const hang = await fakeRegistry(() => "hang");
		await expect(
			fetchOfferedNotes("0.5.0", { registry: hang.url, timeoutMs: 50 }),
		).rejects.toThrow("Registry timed out");
		await expect(
			fetchOfferedNotes("0.5.0", {
				registry: "http://x",
				fetch: async () => {
					throw new TypeError("fetch failed");
				},
			}),
		).rejects.toThrow("Registry unreachable");
		// Never asks for something that isn't a version.
		await expect(
			fetchOfferedNotes("../../evil", { registry: missing.url }),
		).rejects.toThrow("Not a version");
	});

	it("bad entries are dropped and counted, the rest kept", async () => {
		const r = await fakeRegistry(() => ({
			status: 200,
			body: {
				crbReleaseNotes: [
					{
						...v("0.5.0"),
						notes: [
							note("CAR-1", 10),
							{ ...note("CAR-2", 11), kind: "breaking" },
							{ ...note("CAR-3", 12), text: "Line one\nline two" },
							{ ...note("CAR-4", 13), text: "Evil \u202eetats" },
							{ ...note("CAR-5", 14), prs: ["14"] },
							{ ...note("CAR-6", 15), text: "x".repeat(601) },
						],
					},
					{ version: "not one", notes: [] },
				],
			},
		}));
		const got = await fetchOfferedNotes("0.5.0", { registry: r.url });
		expect(got.entries.map((x) => x.version)).toEqual(["0.5.0"]);
		expect(got.entries[0]?.notes.map((n) => n.id)).toEqual(["CAR-1"]);
		// The bad version whole; the bad notes by their version.
		expect(got.dropped).toBe(1);
		expect(got.droppedIn).toEqual({ "0.5.0": 5 });
	});
});

const parsed = (entries: ShippedReleaseNotes[], dropped = 0): ParsedNotes => ({
	entries,
	dropped,
});

describe("prepareUpdateNotes", () => {
	it("the versions after the running one up to the offered one, newest first", () => {
		const got = prepareUpdateNotes(
			"0.3.0",
			"0.5.0",
			parsed(
				[
					v("0.4.0", { notes: [note("CAR-2", 20)] }),
					v("0.5.0", { notes: [note("CAR-3", 30)] }),
					v("0.3.0", { notes: [note("CAR-1", 10)] }),
				],
				2,
			),
			null,
		);
		expect(got.sections.map((s) => s.version)).toEqual(["0.5.0", "0.4.0"]);
		expect(got.sections.every((s) => s.released)).toBe(true);
		expect(got.older).toBe(false);
		expect(got.dropped).toBe(2);
	});

	it("couldn't be read: only the versions shown, and entries whose version is unknown", () => {
		const got = prepareUpdateNotes(
			"0.3.0",
			"0.5.0",
			{
				entries: [v("0.5.0"), v("0.4.0"), v("0.3.0"), v("0.2.0")],
				dropped: 1,
				droppedIn: { "0.5.0": 2, "0.4.0": 1, "0.3.0": 4, "0.2.0": 8 },
			},
			null,
		);
		expect(got.dropped).toBe(4);
	});

	it("a release's own entry without a date (written after the tarball): released, no date", () => {
		const got = prepareUpdateNotes(
			"0.3.0",
			"0.4.0",
			parsed([v("0.4.0", { date: null }), v("0.3.0")]),
			null,
		);
		expect(got.sections).toMatchObject([
			{ version: "0.4.0", date: null, released: true },
		]);
		expect(
			prepareOwnNotes("0.4.0", parsed([v("0.4.0", { date: null })])).running,
		).toMatchObject({ date: null, released: true });
	});

	it("older: the offered list doesn't reach the running version", () => {
		const got = prepareUpdateNotes(
			"0.3.0",
			"0.5.0",
			parsed([v("0.5.0"), v("0.4.1")]),
			null,
		);
		expect(got.older).toBe(true);
		expect(got.sections[1]?.notes).toEqual([]);
	});

	it("an RC: only what the running build didn't have, under the offered RC; changes without notes it hadn't run", () => {
		const own = parsed([
			v("0.4.0", {
				date: null,
				notes: [note("CAR-1", 10)],
				uncovered: [11],
			}),
			v("0.3.0"),
		]);
		const got = prepareUpdateNotes(
			"0.4.0-rc.3",
			"0.4.0-rc.5",
			parsed([
				v("0.4.0", {
					date: null,
					notes: [note("CAR-1", 10), note("CAR-2", 12)],
					uncovered: [11, 13, 14],
				}),
				v("0.3.0"),
			]),
			own,
		);
		expect(got.sections).toEqual([
			{
				version: "0.4.0-rc.5",
				date: null,
				notes: [note("CAR-2", 12)],
				uncovered: [13, 14],
				released: false,
			},
		]);
		expect(got.older).toBe(false);
	});

	it("an RC offered the release: the release's notes past what the RC had, linked as a release", () => {
		const got = prepareUpdateNotes(
			"0.4.0-rc.3",
			"0.4.0",
			parsed([v("0.4.0", { notes: [note("CAR-1", 10), note("CAR-2", 12)] })]),
			parsed([v("0.4.0", { date: null, notes: [note("CAR-1", 10)] })]),
		);
		expect(got.sections.map((s) => [s.version, s.released])).toEqual([
			["0.4.0", true],
		]);
		expect(got.sections[0]?.notes.map((n) => n.id)).toEqual(["CAR-2"]);
	});
});

describe("prepareOwnNotes", () => {
	it("the running version's notes and the earlier releases; none without a file", () => {
		const own = parsed([
			v("0.3.0", { notes: [note("CAR-1", 1)] }),
			v("0.4.0", { notes: [note("CAR-2", 2)] }),
		]);
		const got = prepareOwnNotes("0.4.0", own);
		expect(got.file).toBe(true);
		expect(got.running?.notes.map((n) => n.id)).toEqual(["CAR-2"]);
		expect(got.earlier.map((s) => s.version)).toEqual(["0.3.0"]);
		// An RC reads its upcoming release's, under its own version.
		const rc = prepareOwnNotes("0.4.0-rc.2", own);
		expect(rc.running?.version).toBe("0.4.0-rc.2");
		expect(rc.running?.released).toBe(false);
		expect(prepareOwnNotes("0.4.0", null)).toEqual({
			current: "0.4.0",
			file: false,
			running: null,
			earlier: [],
			dropped: 0,
		});
	});

	it("reads the package's file: absent is none, unreadable is counted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "crb-notes-"));
		try {
			expect(await readOwnNotes(join(dir, "missing.json"))).toBeNull();
			await writeFile(join(dir, "bad.json"), "{");
			expect(await readOwnNotes(join(dir, "bad.json"))).toEqual({
				entries: [],
				dropped: 1,
			});
			await writeFile(join(dir, "ok.json"), JSON.stringify([v("0.4.0")]));
			expect((await readOwnNotes(join(dir, "ok.json")))?.entries).toHaveLength(
				1,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("NotesCache", () => {
	it("one load for two reads; a failure kept until a Retry or the next check", async () => {
		const loads: string[] = [];
		let fail = true;
		const cache = new NotesCache(async (version) => {
			loads.push(version);
			if (fail) throw new RegistryError("Registry timed out");
			return parsed([v(version)]);
		});
		cache.afterCheck("0.5.0");
		expect(await cache.get("0.5.0")).toEqual({
			ok: false,
			reason: "Registry timed out",
		});
		expect(await cache.get("0.5.0")).toMatchObject({ ok: false });
		expect(loads).toEqual(["0.5.0"]);
		fail = false;
		expect(await cache.retry("0.5.0")).toMatchObject({ ok: true });
		expect(await cache.get("0.5.0")).toMatchObject({ ok: true });
		await cache.retry("0.5.0");
		cache.afterCheck("0.5.0");
		expect(loads).toEqual(["0.5.0", "0.5.0"]);
		// Another version on offer: its own load.
		await cache.get("0.6.0");
		expect(loads).toEqual(["0.5.0", "0.5.0", "0.6.0"]);
		// A failure is loaded again once per check.
		fail = true;
		await cache.get("0.7.0");
		cache.afterCheck("0.7.0");
		await cache.get("0.7.0");
		expect(loads.filter((x) => x === "0.7.0")).toHaveLength(2);
	});
});

describe("/api/update/notes and /api/release-notes", () => {
	const apps: { close(): Promise<unknown> }[] = [];
	afterEach(async () => {
		for (const a of apps.splice(0)) await a.close();
	});

	async function app(
		updater: Updater | undefined,
		ownNotes?: () => Promise<ParsedNotes | null>,
	) {
		const a = await buildApp(new SessionRegistry(), {
			accessKey: null,
			updater,
			ownNotes,
		});
		apps.push(a);
		await a.listen({ port: 0, host: "127.0.0.1" });
		const address = a.server.address() as AddressInfo;
		return { a, host: `127.0.0.1:${address.port}` };
	}

	const updater = (notes: (version: string) => Promise<ParsedNotes>) =>
		new Updater({
			build: { version: "0.3.0", commit: "a".repeat(40) },
			enabled: true,
			install: null,
			check: async () => "0.5.0",
			notes,
			ownNotes: async () => parsed([v("0.3.0")]),
			service: async () => null,
			exit: () => {},
			port: () => 4747,
		});

	it("prefetched when the update is found; one load for many reads; a failure is 502 with its reason; POST retries", async () => {
		let loads = 0;
		let fail = true;
		const u = updater(async (version) => {
			loads++;
			if (fail) throw new RegistryError("Registry answered 503");
			return parsed([
				v(version, { notes: [note("CAR-9", 90)] }),
				v("0.4.0"),
				v("0.3.0"),
			]);
		});
		await u.checkNow();
		expect(loads).toBe(1);
		const { a, host } = await app(u);
		const failed = await a.inject({
			url: "/api/update/notes",
			headers: { host },
		});
		expect(failed.statusCode).toBe(502);
		expect(failed.json()).toEqual({ error: "Registry answered 503" });
		expect(loads).toBe(1);
		fail = false;
		const retried = await a.inject({
			method: "POST",
			url: "/api/update/notes",
			headers: { host },
		});
		expect(retried.statusCode).toBe(200);
		expect(retried.json()).toMatchObject({
			current: "0.3.0",
			available: "0.5.0",
			older: false,
			dropped: 0,
			sections: [{ version: "0.5.0" }, { version: "0.4.0" }],
		});
		await a.inject({ url: "/api/update/notes", headers: { host } });
		expect(loads).toBe(2);
		u.stop();
	});

	it("nothing on offer: 409; own notes without an updater", async () => {
		const { a, host } = await app(undefined, async () =>
			parsed([v("0.1.0", { notes: [note("CAR-1", 1)] })]),
		);
		expect(
			(await a.inject({ url: "/api/update/notes", headers: { host } }))
				.statusCode,
		).toBe(409);
		const own = await a.inject({
			url: "/api/release-notes",
			headers: { host },
		});
		expect(own.statusCode).toBe(200);
		expect(own.json()).toMatchObject({ file: true });
		const none = await app(undefined, async () => null);
		expect(
			(
				await none.a.inject({
					url: "/api/release-notes",
					headers: { host: none.host },
				})
			).json(),
		).toMatchObject({ file: false, running: null });
	});
});
