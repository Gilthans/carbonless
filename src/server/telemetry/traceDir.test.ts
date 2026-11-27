import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configDir, stateDir } from "../paths";
import { createTracer, setDefaultTraceDir, tracer } from "../trace";
import {
	applyMailboxTracing,
	defaultTraceDir,
	mailboxTraceDir,
} from "./traceDir";

const DEFAULT_DIR = Symbol.for("carbonless.traceDefaultDir");
const defaultDir = () =>
	(globalThis as { [DEFAULT_DIR]?: string })[DEFAULT_DIR];

describe("tracing follows the mailbox", () => {
	afterEach(() => {
		(globalThis as { [DEFAULT_DIR]?: string })[DEFAULT_DIR] = undefined;
	});

	it("traces into the state dir only while the mailbox is on and $CRB_TRACE_DIR is unset", () => {
		expect(defaultTraceDir()).toBe(join(stateDir(), "traces"));
		expect(mailboxTraceDir(true, {})).toBe(defaultTraceDir());
		expect(mailboxTraceDir(false, {})).toBeUndefined();
		expect(mailboxTraceDir(true, { CRB_TRACE_DIR: "/x" })).toBeUndefined();
	});

	it("crb serve's start reads the config", async () => {
		mkdirSync(configDir(), { recursive: true });
		const file = join(configDir(), "config.json");
		writeFileSync(file, JSON.stringify({}));
		await applyMailboxTracing();
		expect(defaultDir()).toBeUndefined();
		writeFileSync(
			file,
			JSON.stringify({
				telemetry: { mailbox: "/somewhere.git", device: "laptop" },
			}),
		);
		const saved = process.env.CRB_TRACE_DIR;
		delete process.env.CRB_TRACE_DIR;
		try {
			await applyMailboxTracing();
		} finally {
			if (saved !== undefined) process.env.CRB_TRACE_DIR = saved;
		}
		expect(defaultDir()).toBe(defaultTraceDir());
	});

	it("the process's tracer takes the default dir, $CRB_TRACE_DIR first", () => {
		const KEY = Symbol.for("carbonless.tracer");
		const g = globalThis as { [KEY]?: unknown };
		const saved = { tracer: g[KEY], env: process.env.CRB_TRACE_DIR };
		try {
			setDefaultTraceDir("/default-traces");
			delete g[KEY];
			delete process.env.CRB_TRACE_DIR;
			expect(tracer("crb").dir).toBe("/default-traces");
			delete g[KEY];
			process.env.CRB_TRACE_DIR = "/env-traces";
			expect(tracer("crb").dir).toBe("/env-traces");
		} finally {
			g[KEY] = saved.tracer;
			if (saved.env === undefined) delete process.env.CRB_TRACE_DIR;
			else process.env.CRB_TRACE_DIR = saved.env;
		}
	});

	it("a tracer knows its directory", () => {
		expect(createTracer({ dir: undefined, service: "x" }).dir).toBeNull();
		expect(
			createTracer({ dir: "/t", service: "x", flushOnExit: false }).dir,
		).toBe("/t");
	});
});
