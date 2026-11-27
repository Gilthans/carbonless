import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
			setDefaultTraceDir(join(stateDir(), "default-traces"));
			delete g[KEY];
			delete process.env.CRB_TRACE_DIR;
			expect(tracer("crb").dir).toBe(join(stateDir(), "default-traces"));
			delete g[KEY];
			process.env.CRB_TRACE_DIR = join(stateDir(), "env-traces");
			expect(tracer("crb").dir).toBe(join(stateDir(), "env-traces"));
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

	// crb serve's tracer is made at the first tracer() call; git.ts makes it
	// at import. The default dir must be set before that: src/cli.ts loads
	// only this chain before main.js, statically. A new import here that
	// reaches git.ts (or any module calling tracer() at load) would make
	// the tracer first, and the mailbox's tracing would silently stay off.
	it("src/cli.ts reaches nothing that makes the tracer before the default dir is set", () => {
		const src = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
		const seen = new Set<string>();
		const visit = (file: string, dynamicToo: boolean) => {
			if (seen.has(file)) return;
			seen.add(file);
			const text = readFileSync(file, "utf8");
			const specs = [
				...text.matchAll(/^(?:import|export)[^;]*?from\s+"(\.[^"]+)"/gms),
				...(dynamicToo
					? text.matchAll(/await import\(\s*"(\.[^"]+telemetry[^"]+)"/g)
					: []),
			]
				.filter((m) => !/^import type/.test(m[0]))
				.map((m) => m[1] as string);
			for (const spec of specs) {
				visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")), false);
			}
		};
		visit(join(src, "cli.ts"), true);
		const files = [...seen].map((f) => relative(src, f).replaceAll("\\", "/"));
		expect(files.sort()).toEqual(
			[
				"cli.ts",
				"server/atomicFile.ts",
				"server/buildInfo.ts",
				"server/config.ts",
				"server/paths.ts",
				"server/telemetry/traceDir.ts",
				"server/trace.ts",
			].sort(),
		);
		for (const f of seen) {
			expect(readFileSync(f, "utf8")).not.toMatch(/^const \w+ = tracer\(/m);
		}
	});
});
