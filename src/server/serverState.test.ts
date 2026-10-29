import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	accessKey,
	readLiveServerState,
	removeServerState,
	rotateAccessKey,
	type ServerState,
	writeServerState,
} from "./serverState";
import { BUILD } from "./version";

describe("serverState", () => {
	let dir: string;
	let saved: string | undefined;
	const file = (name: string) => join(dir, "carbonless", name);
	const mode = (name: string) => statSync(file(name)).mode & 0o777;

	const state = (over: Partial<ServerState> = {}): ServerState => ({
		url: "http://127.0.0.1:4800",
		host: "127.0.0.1",
		port: 4800,
		pid: process.pid,
		startedAt: "2026-10-29T10:00:00.000Z",
		version: BUILD,
		...over,
	});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-state-"));
		saved = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = dir;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = saved;
		rmSync(dir, { recursive: true, force: true });
	});

	it("is null when there is no file", async () => {
		expect(await readLiveServerState()).toBeNull();
	});

	it("reads back what was written, file mode 0600", async () => {
		await writeServerState(state());
		expect(await readLiveServerState()).toEqual(state());
		expect(mode("server.json")).toBe(0o600);
	});

	it("is null when the pid is gone", async () => {
		// A process that has exited: its pid is free.
		const child = spawnSync(process.execPath, ["-e", "0"]);
		await writeServerState(state({ pid: child.pid ?? 0 }));
		expect(await readLiveServerState()).toBeNull();
	});

	it("is null when the file is garbage", async () => {
		await writeServerState(state());
		writeFileSync(file("server.json"), "{ nope");
		expect(await readLiveServerState()).toBeNull();
		writeFileSync(file("server.json"), JSON.stringify({ pid: "x" }));
		expect(await readLiveServerState()).toBeNull();
	});

	it("removes only the state of this process", async () => {
		await writeServerState(state({ pid: 1 }));
		await removeServerState();
		// pid 1 (init) is alive and isn't this process: its file stays.
		expect((await readLiveServerState())?.pid).toBe(1);
		await writeServerState(state());
		await removeServerState();
		expect(await readLiveServerState()).toBeNull();
		await removeServerState();
	});

	it("the key is made once, 0600, and survives the state's removal", async () => {
		const key = await accessKey();
		expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(mode("key")).toBe(0o600);
		await writeServerState(state());
		await removeServerState();
		expect(await accessKey()).toBe(key);
	});

	it("concurrent first uses agree on one key", async () => {
		const keys = await Promise.all([accessKey(), accessKey(), accessKey()]);
		expect(new Set(keys).size).toBe(1);
	});

	it("rotating makes a new key that sticks", async () => {
		const key = await accessKey();
		const rotated = await rotateAccessKey();
		expect(rotated).not.toBe(key);
		expect(await accessKey()).toBe(rotated);
		expect(mode("key")).toBe(0o600);
	});
});
