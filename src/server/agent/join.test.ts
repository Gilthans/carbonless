import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOIN, type JoinLeave } from "../../shared/agent.js";
import { ReviewClaim } from "./claim.js";
import {
	type AttachOutcome,
	JoinBroker,
	type JoinBrokerDeps,
	JoinElsewhereError,
	joinGraceGate,
	StaleJoinRequestError,
	type WatchLease,
} from "./join.js";

const WHO = { name: "carbonless · main", machine: "devbox", harness: "cc 2.1" };

let dir: string;
let left: JoinLeave[];
let approved: number;
let waiting: boolean;
const brokers: JoinBroker[] = [];

const make = (over: Partial<JoinBrokerDeps> = {}): JoinBroker => {
	const b = new JoinBroker({
		dir,
		onApproved: async () => {
			approved++;
		},
		onLeft: (why) => left.push(why),
		waiting: async () => waiting,
		...over,
	});
	brokers.push(b);
	return b;
};

/** request → approve → the token, as the session collects it. */
async function joined(b: JoinBroker): Promise<string> {
	const { request } = b.request(WHO);
	await b.answer(request, true);
	const o = await b.outcome(request, 0);
	if (o.state !== "approved") throw new Error(`not approved: ${o.state}`);
	return o.token;
}

/** Whether a promise has settled (after the microtasks queued so far). */
async function settled(p: Promise<unknown>): Promise<boolean> {
	let done = false;
	void p.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	for (let i = 0; i < 20; i++) await Promise.resolve();
	return done;
}

beforeEach(() => {
	vi.useFakeTimers();
	dir = mkdtempSync(join(tmpdir(), "crb-join-"));
	left = [];
	approved = 0;
	waiting = false;
});

afterEach(() => {
	for (const b of brokers.splice(0)) b.close();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

describe("JoinBroker: requests", () => {
	it("request then Approve: outcome is approved with a token check accepts", async () => {
		const b = make();
		const { request } = b.request(WHO);
		expect(b.view().joinRequest).toMatchObject({ id: request, ...WHO });
		await b.answer(request, true);
		expect(approved).toBe(1);
		const o = await b.outcome(request, 0);
		expect(o.state).toBe("approved");
		const token = (o as Extract<AttachOutcome, { state: "approved" }>).token;
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(b.check(token)).toBe(true);
		expect(b.check(`${token.slice(0, -1)}x`)).toBe(false);
		expect(b.check("")).toBe(false);
		expect(b.view()).toMatchObject({ via: "mcp", joined: WHO });
		expect(b.view().joinRequest).toBeUndefined();
		// joined.json holds the hash only.
		const file = readFileSync(join(dir, "joined.json"), "utf8");
		expect(file).not.toContain(token);
		expect(JSON.parse(file)).toMatchObject({ who: WHO });
	});

	it("the token is handed out once: a second collect doesn't carry it", async () => {
		const b = make();
		const { request } = b.request(WHO);
		await b.answer(request, true);
		expect((await b.outcome(request, 0)).state).toBe("approved");
		expect(await b.outcome(request, 0)).toEqual({ state: "expired" });
	});

	it("Deny: outcome denied, nothing joined", async () => {
		const b = make();
		const { request } = b.request(WHO);
		await b.answer(request, false);
		expect(await b.outcome(request, 0)).toEqual({ state: "denied" });
		expect(b.view().joined).toBeUndefined();
		expect(approved).toBe(0);
		expect(existsSync(join(dir, "joined.json"))).toBe(false);
	});

	it("a second request replaces the first: the old id is stale", async () => {
		const b = make();
		const first = b.request(WHO).request;
		const second = b.request({ name: "other", machine: "laptop" }).request;
		expect(second).not.toBe(first);
		expect(b.view().joinRequest).toMatchObject({ id: second, name: "other" });
		await expect(b.answer(first, true)).rejects.toBeInstanceOf(
			StaleJoinRequestError,
		);
		expect(await b.outcome(first, 0)).toEqual({ state: "expired" });
		await b.answer(second, true);
		expect((await b.outcome(second, 0)).state).toBe("approved");
	});

	it("two answers race (Approve and Deny at once): the first wins, the second is stale; one token", async () => {
		const b = make();
		const { request } = b.request(WHO);
		const [a, d] = await Promise.allSettled([
			b.answer(request, true),
			b.answer(request, false),
		]);
		expect(a.status).toBe("fulfilled");
		expect(d.status).toBe("rejected");
		expect((d as PromiseRejectedResult).reason).toBeInstanceOf(
			StaleJoinRequestError,
		);
		expect(approved).toBe(1);
		expect((await b.outcome(request, 0)).state).toBe("approved");
		// Two Approves: still one.
		const next = b.request(WHO).request;
		const both = await Promise.allSettled([
			b.answer(next, true),
			b.answer(next, true),
		]);
		expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(approved).toBe(2);
	});

	it("identity strings are sanitised and capped at 80 characters", () => {
		const b = make();
		b.request({
			name: `a\u202eb<!-- x -->${"n".repeat(200)}`,
			machine: "dev\u0007box",
			harness: "",
		});
		const r = b.view().joinRequest;
		expect(r?.name).toBe(`ab${"n".repeat(78)}`);
		expect(r?.machine).toBe("devbox");
		expect(r).not.toHaveProperty("harness");
	});

	it("identity strings are one line: newlines, tabs, line separators, NEL and C1 become one space or go", () => {
		const b = make();
		b.request({
			name: "dev\nbox\t\r\nmain",
			machine: "a\u2028b\u2029c x\u0085y\u009bz",
			harness: "cc 2.1\n\nApproved by your admin",
		});
		expect(b.view().joinRequest).toMatchObject({
			name: "dev box main",
			machine: "a b c x yz",
			harness: "cc 2.1 Approved by your admin",
		});
	});

	it("the cap counts code points and never splits a surrogate pair; an empty name falls back to the machine", () => {
		const b = make();
		b.request({ name: "😀".repeat(100), machine: "devbox" });
		const name = b.view().joinRequest?.name ?? "";
		expect(Array.from(name)).toHaveLength(80);
		expect(name).toBe("😀".repeat(80));
		b.request({ name: " \n<!-- -->", machine: "devbox" });
		expect(b.view().joinRequest?.name).toBe("devbox");
		b.request({ name: "", machine: "" });
		expect(b.view().joinRequest?.name).toBe("session");
	});

	it("outcome during an Approve still being installed is pending, then approved", async () => {
		let release: () => void = () => {};
		const b = make({
			onApproved: () =>
				new Promise<void>((r) => {
					release = r;
				}),
		});
		const { request } = b.request(WHO);
		const answering = b.answer(request, true);
		await settled(answering);
		expect(await b.outcome(request, 0)).toEqual({ state: "pending", request });
		const waited = b.outcome(request, JOIN.attachWaitMs);
		expect(await settled(waited)).toBe(false);
		release();
		await answering;
		expect((await waited).state).toBe("approved");
	});

	it("a filesystem step that fails during an Approve rolls it back: no join, not active, expired", async () => {
		const b = make();
		// joined.json can't be written: a directory is in its place.
		mkdirSync(join(dir, "joined.json"));
		const { request } = b.request(WHO);
		await expect(b.answer(request, true)).rejects.toThrow();
		expect(b.view().joined).toBeUndefined();
		expect(b.isJoined()).toBe(false);
		expect(b.active()).toBe(false);
		expect(await b.outcome(request, 0)).toEqual({ state: "expired" });
		expect(approved).toBe(0);
		await expect(b.answer(request, true)).rejects.toBeInstanceOf(
			StaleJoinRequestError,
		);
	});

	it("an onApproved that throws doesn't fail the Approve: the join took effect", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const b = make({
			onApproved: async () => {
				throw new Error("disk full");
			},
		});
		const { request } = b.request(WHO);
		await expect(b.answer(request, true)).resolves.toBeUndefined();
		expect((await b.outcome(request, 0)).state).toBe("approved");
		warn.mockRestore();
	});

	it("an Approve sets acp-off itself, before joined.json and onApproved", async () => {
		const order: string[] = [];
		const b = make({
			onApproved: async () => {
				order.push(existsSync(join(dir, "acp-off")) ? "acp-off" : "no acp-off");
			},
		});
		expect(b.acpOff()).toBe(false);
		await joined(b);
		expect(order).toEqual(["acp-off"]);
		expect(b.acpOff()).toBe(true);
	});

	it("active while asked, joined or watched", async () => {
		const b = make();
		expect(b.active()).toBe(false);
		const { request } = b.request(WHO);
		expect(b.active()).toBe(true);
		await b.answer(request, false);
		expect(b.active()).toBe(false);
		await joined(b);
		expect(b.active()).toBe(true);
		b.leave("detached");
		expect(b.active()).toBe(false);
	});

	it("an unknown request id is stale", async () => {
		const b = make();
		await expect(b.answer("01k9e6m2q8x4v7c3n5b0h1j2t6", true)).rejects.toThrow(
			StaleJoinRequestError,
		);
	});

	it("expires after JOIN.expiryMs with no answer", async () => {
		const b = make();
		const { request } = b.request(WHO);
		vi.advanceTimersByTime(JOIN.expiryMs - 1);
		expect(b.view().joinRequest).toBeDefined();
		vi.advanceTimersByTime(1);
		expect(b.view().joinRequest).toBeUndefined();
		expect(await b.outcome(request, 0)).toEqual({ state: "expired" });
		await expect(b.answer(request, true)).rejects.toThrow(
			StaleJoinRequestError,
		);
	});

	it("outcome waits up to waitMs: pending with no answer, early when answered", async () => {
		const b = make();
		const { request } = b.request(WHO);
		const idle = b.outcome(request, JOIN.attachWaitMs);
		expect(await settled(idle)).toBe(false);
		await vi.advanceTimersByTimeAsync(JOIN.attachWaitMs);
		expect(await idle).toEqual({ state: "pending", request });
		const answered = b.outcome(request, JOIN.attachWaitMs);
		expect(await settled(answered)).toBe(false);
		await b.answer(request, true);
		expect((await answered).state).toBe("approved");
	});
});

describe("JoinBroker: presence", () => {
	it("a watcher lease: listening; wake() delivers", async () => {
		const b = make();
		const token = await joined(b);
		expect(b.watcher("nope")).toBeNull();
		const lease = b.watcher(token) as WatchLease;
		await vi.advanceTimersByTimeAsync(0);
		expect(b.view().presence).toBe("listening");
		expect(await settled(lease.deliver)).toBe(false);
		b.wake();
		expect(await settled(lease.deliver)).toBe(true);
	});

	it("a question already waiting is delivered at once", async () => {
		const b = make();
		const token = await joined(b);
		waiting = true;
		const lease = b.watcher(token) as WatchLease;
		expect(await settled(lease.deliver)).toBe(true);
	});

	it("closed without a delivery: reconnecting, then lost after graceMs", async () => {
		const b = make();
		const token = await joined(b);
		const lease = b.watcher(token) as WatchLease;
		await vi.advanceTimersByTimeAsync(0);
		lease.close();
		expect(b.view().presence).toBe("reconnecting");
		await vi.advanceTimersByTimeAsync(JOIN.graceMs - 1);
		expect(left).toEqual([]);
		// Back in time: listening again, no leave.
		const again = b.watcher(token) as WatchLease;
		await vi.advanceTimersByTimeAsync(JOIN.graceMs * 2);
		expect(left).toEqual([]);
		expect(b.view().presence).toBe("listening");
		again.close();
		await vi.advanceTimersByTimeAsync(JOIN.graceMs);
		expect(left).toEqual(["lost"]);
		expect(b.view().left).toMatchObject({ ...WHO, why: "lost" });
		expect(b.view().joined).toBeUndefined();
		expect(b.check(token)).toBe(false);
		expect(existsSync(join(dir, "joined.json"))).toBe(false);
	});

	it("a delivered question: busy until the session replies or reconnects; lost after busyMs", async () => {
		const b = make();
		const token = await joined(b);
		const lease = b.watcher(token) as WatchLease;
		b.wake();
		await lease.deliver;
		lease.close();
		expect(b.view().presence).toBe("busy");
		// Past the grace window: busy isn't an interruption.
		await vi.advanceTimersByTimeAsync(JOIN.graceMs * 2);
		expect(left).toEqual([]);
		await vi.advanceTimersByTimeAsync(JOIN.busyMs);
		expect(left).toEqual(["lost"]);
	});

	it("a watcher dropped mid-delivery: delivered again on reconnect", async () => {
		const b = make();
		const token = await joined(b);
		waiting = true;
		const first = b.watcher(token) as WatchLease;
		await first.deliver;
		// The line was written, the socket died before curl read it.
		first.close();
		const second = b.watcher(token) as WatchLease;
		expect(await settled(second.deliver)).toBe(true);
	});

	it("handOut with no reply and no watcher for busyMs: lost, and the hand-out cleared", async () => {
		const b = make();
		await joined(b);
		b.handOut("t1", "m1");
		expect(b.handedOut()).toEqual({ thread: "t1", asked: "m1" });
		expect(b.view().presence).toBe("busy");
		await vi.advanceTimersByTimeAsync(JOIN.busyMs - 1);
		expect(left).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(left).toEqual(["lost"]);
		expect(b.handedOut()).toBeNull();
	});

	it("replied clears the hand-out; with no watcher the grace window runs", async () => {
		const b = make();
		await joined(b);
		b.handOut("t1", undefined);
		b.replied("t1");
		expect(b.handedOut()).toBeNull();
		expect(b.view().presence).toBe("reconnecting");
		await vi.advanceTimersByTimeAsync(JOIN.graceMs);
		expect(left).toEqual(["lost"]);
	});

	it("a new lease closes the old one as replaced", async () => {
		const b = make();
		const token = await joined(b);
		const one = b.watcher(token) as WatchLease;
		b.watcher(token);
		expect(await one.ended).toBe("replaced");
		expect(b.view().presence).toBe("listening");
	});

	it("approved but never collected: lost after expiryMs", async () => {
		const b = make();
		const { request } = b.request(WHO);
		await b.answer(request, true);
		await vi.advanceTimersByTimeAsync(JOIN.graceMs * 2);
		expect(left).toEqual([]);
		await vi.advanceTimersByTimeAsync(JOIN.expiryMs);
		expect(left).toEqual(["lost"]);
	});
});

describe("JoinBroker: leaving", () => {
	it("leave(detached) clears the hand-out, invalidates the token, ends the lease", async () => {
		const b = make();
		const token = await joined(b);
		const lease = b.watcher(token) as WatchLease;
		b.handOut("t1", "m1");
		b.leave("detached");
		expect(b.handedOut()).toBeNull();
		expect(b.check(token)).toBe(false);
		expect(b.watcher(token)).toBeNull();
		expect(await lease.ended).toBe("left");
		expect(left).toEqual(["detached"]);
		expect(b.view()).toMatchObject({
			left: { ...WHO, why: "detached" },
		});
		expect(b.view().via).toBeUndefined();
		expect(existsSync(join(dir, "joined.json"))).toBe(false);
		// Once: a second leave does nothing.
		b.leave("disconnected");
		expect(left).toEqual(["detached"]);
	});

	it("a new join approved replaces the joined session", async () => {
		const b = make();
		const old = await joined(b);
		b.handOut("t1", "m1");
		const other = { name: "other", machine: "laptop" };
		const { request } = b.request(other);
		await b.answer(request, true);
		expect(left).toEqual(["replaced"]);
		expect(b.view().left).toMatchObject({ ...WHO, why: "replaced" });
		expect(b.check(old)).toBe(false);
		expect(b.handedOut()).toBeNull();
		const o = await b.outcome(request, 0);
		expect(b.check((o as { token: string }).token)).toBe(true);
		expect(b.view().joined).toMatchObject(other);
	});
});

describe("JoinBroker: disconnect", () => {
	it("leave(disconnected) clears the hand-out (the thread waits again)", async () => {
		const b = make();
		const token = await joined(b);
		b.handOut("t1", "m1");
		b.leave("disconnected");
		expect(b.handedOut()).toBeNull();
		expect(b.check(token)).toBe(false);
		expect(b.view().left?.why).toBe("disconnected");
	});
});

describe("JoinBroker: the review's claim (several servers, one agents dir)", () => {
	const claimOf = (port: number) =>
		new ReviewClaim(dir, () => ({ pid: process.pid, port }));

	it("only the holder restores; another server's broker leaves joined.json alone and reports elsewhere", async () => {
		const holder = make({ claim: claimOf(4747) });
		const token = await joined(holder);
		holder.watcher(token);
		const other = make({ claim: claimOf(4748) });
		await other.restore();
		expect(other.view().joined).toBeUndefined();
		expect(other.check(token)).toBe(false);
		expect(other.watcher(token)).toBeNull();
		expect(await other.claimCheck()).toEqual({
			ok: false,
			holder: { pid: process.pid, port: 4747 },
		});
		const { request } = other.request(WHO);
		await expect(other.answer(request, true)).rejects.toBeInstanceOf(
			JoinElsewhereError,
		);
		await vi.advanceTimersByTimeAsync(JOIN.graceMs * 2);
		expect(existsSync(join(dir, "joined.json"))).toBe(true);
		expect(holder.view().presence).toBe("listening");
		expect(left).toEqual([]);
	});

	it("once the holder closes, the next server takes the claim and restores", async () => {
		const holder = make({ claim: claimOf(4747) });
		const token = await joined(holder);
		holder.close();
		await vi.waitFor(() =>
			expect(existsSync(join(dir, "claim.json"))).toBe(false),
		);
		const next = make({ claim: claimOf(4748) });
		await next.restore();
		expect(next.view().presence).toBe("reconnecting");
		expect(next.check(token)).toBe(true);
	});

	it("claimCheck takes nothing for good when nothing is joined", async () => {
		const b = make({ claim: claimOf(4747) });
		expect(await b.claimCheck()).toEqual({ ok: true });
		expect(existsSync(join(dir, "claim.json"))).toBe(false);
	});
});

describe("JoinBroker: restart", () => {
	it("restore() from joined.json: reconnecting; a lease within graceMs makes it listening", async () => {
		// The old server goes (its timers with it); joined.json stays.
		const old = make();
		const token = await joined(old);
		old.close();
		expect(existsSync(join(dir, "joined.json"))).toBe(true);
		const b = make();
		await b.restore();
		expect(b.view()).toMatchObject({
			via: "mcp",
			joined: WHO,
			presence: "reconnecting",
		});
		expect(b.check(token)).toBe(true);
		await vi.advanceTimersByTimeAsync(JOIN.graceMs - 1);
		b.watcher(token);
		await vi.advanceTimersByTimeAsync(JOIN.graceMs * 2);
		expect(b.view().presence).toBe("listening");
		expect(left).toEqual([]);
	});

	it("restore() with no watcher back in graceMs: lost", async () => {
		const old = make();
		await joined(old);
		old.close();
		const b = make();
		await b.restore();
		await vi.advanceTimersByTimeAsync(JOIN.graceMs);
		expect(left).toEqual(["lost"]);
		expect(b.view().left).toMatchObject({ ...WHO, why: "lost" });
		expect(existsSync(join(dir, "joined.json"))).toBe(false);
	});

	it("restore() ignores a missing or corrupt joined.json", async () => {
		const b = make();
		await b.restore();
		expect(b.view().joined).toBeUndefined();
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(dir, "joined.json"), "{not json");
		const c = make();
		await c.restore();
		expect(c.view().joined).toBeUndefined();
	});

	it("acp-off survives a new broker on the same dir, and one made before sees it", async () => {
		const b = make();
		const earlier = make();
		expect(b.acpOff()).toBe(false);
		await b.setAcpOff(true);
		expect(existsSync(join(dir, "acp-off"))).toBe(true);
		expect(make().acpOff()).toBe(true);
		expect(earlier.acpOff()).toBe(true);
		await b.setAcpOff(false);
		expect(make().acpOff()).toBe(false);
	});
});

describe("the grace gate (test-only CRB_JOIN_GRACE_GATE)", () => {
	it("names a file; unset or blank keeps the real window", () => {
		expect(joinGraceGate({ CRB_JOIN_GRACE_GATE: " /t/gate " })).toBe("/t/gate");
		for (const v of [undefined, "", "  "]) {
			expect(joinGraceGate({ CRB_JOIN_GRACE_GATE: v })).toBeUndefined();
		}
	});

	it("a dropped watcher stays reconnecting past graceMs, and leaves as lost once the file exists", async () => {
		const gate = join(dir, "grace-gate");
		const b = make({ graceGate: gate });
		const token = await joined(b);
		const lease = b.watcher(token) as WatchLease;
		await vi.advanceTimersByTimeAsync(0);
		lease.close();
		await vi.advanceTimersByTimeAsync(JOIN.graceMs * 2);
		expect(left).toEqual([]);
		expect(b.view().presence).toBe("reconnecting");
		writeFileSync(gate, "");
		await vi.advanceTimersByTimeAsync(100);
		expect(left).toEqual(["lost"]);
		expect(b.check(token)).toBe(false);
	});

	it("a watcher back inside a gated window stops it: the gate opening later doesn't end the session", async () => {
		const gate = join(dir, "grace-gate");
		const b = make({ graceGate: gate });
		const token = await joined(b);
		const first = b.watcher(token) as WatchLease;
		await vi.advanceTimersByTimeAsync(0);
		first.close();
		expect(b.view().presence).toBe("reconnecting");
		b.watcher(token) as WatchLease;
		writeFileSync(gate, "");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(left).toEqual([]);
		expect(b.view().presence).toBe("listening");
	});

	it("gates only the grace window: a busy session still leaves after busyMs, open gate or not", async () => {
		const gate = join(dir, "grace-gate");
		writeFileSync(gate, "");
		const b = make({ graceGate: gate });
		const token = await joined(b);
		const lease = b.watcher(token) as WatchLease;
		b.wake();
		await lease.deliver;
		lease.close();
		// Busy, not grace: the open gate doesn't end it.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(left).toEqual([]);
		await vi.advanceTimersByTimeAsync(JOIN.busyMs);
		expect(left).toEqual(["lost"]);
	});
});
