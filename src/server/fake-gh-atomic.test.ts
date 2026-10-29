import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../test/fake-gh/atomic.mjs";

const HELPER = pathToFileURL(
	resolve(import.meta.dirname, "../../test/fake-gh/atomic.mjs"),
).href;
/** Rewrites of the file by the writer: enough to overlap many reads. */
const WRITES = 300;
/** Padding per write, so a half-written file is a likely read. */
const PAD = "x".repeat(512 * 1024);

/**
 * The fake gh's scenario file is rewritten by gh (saving a reply) while
 * other gh processes and the test read it whole: a truncating write
 * (writeFileSync) lets a reader see an empty or half-written file.
 */
describe("writeFileAtomic", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-atomic-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the file and leaves nothing else behind", () => {
		const path = join(dir, "scenario.json");
		writeFileAtomic(path, '{"n":1}');
		writeFileAtomic(path, '{"n":2}');
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ n: 2 });
		expect(readdirSync(dir)).toEqual(["scenario.json"]);
	});

	it("never lets a concurrent reader see a half-written file", async () => {
		const path = join(dir, "scenario.json");
		writeFileAtomic(path, JSON.stringify({ n: 0, pad: PAD }));
		// A writer in its own process, like gh saving: the same large JSON
		// over and over, each write a new version number.
		const script = `
			import { writeFileAtomic } from ${JSON.stringify(HELPER)};
			const pad = "x".repeat(${PAD.length});
			for (let n = 1; n <= ${WRITES}; n++) {
				writeFileAtomic(${JSON.stringify(path)}, JSON.stringify({ n, pad }));
			}
		`;
		const writer = spawn(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		writer.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		// `close`, not `exit`: by then its stderr is all in, for the message.
		const closed = new Promise<number | null>((done) =>
			writer.on("close", done),
		);
		let running = true;
		closed.then(() => {
			running = false;
		});
		// Read and parse the file, like gh does, for as long as the writer runs.
		const bad: string[] = [];
		let reads = 0;
		// Reads that saw a version between the first write and the last: the
		// ones that overlapped the writer.
		let overlapped = 0;
		while (running) {
			reads++;
			const text = readFileSync(path, "utf8");
			try {
				const s = JSON.parse(text) as { n: number; pad: string };
				if (s.pad !== PAD)
					bad.push(`read ${reads}: pad of ${s.pad.length} after n=${s.n}`);
				if (s.n > 0 && s.n < WRITES) overlapped++;
			} catch (error) {
				bad.push(`read ${reads}: ${String(error)} (${text.length} bytes)`);
			}
			// Let the writer's close event through.
			await new Promise((next) => setImmediate(next));
		}
		expect(await closed, stderr).toBe(0);
		expect(bad.slice(0, 5)).toEqual([]);
		// The race was real: many reads overlapped the writes (~95% do).
		expect(overlapped).toBeGreaterThan(50);
		expect(JSON.parse(readFileSync(path, "utf8")).n).toBe(WRITES);
		expect(readdirSync(dir)).toEqual(["scenario.json"]);
		// A process writing 150 MB while this one reads: seconds on a loaded
		// machine.
	}, 30_000);
});
