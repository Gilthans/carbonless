// pnpm test-profile [run|latest] [--compare <run>] [--top N] [--jaeger]
//
// Summarizes a test run's traces (docs/test-profiling.md). A run is named
// by its directory under ~/.cache/carbonless/test-traces, "latest", or any
// part of a name (the newest match: "e2e", "unit"). --jaeger loads it into
// a local Jaeger (docker) and prints the link.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { traceRoot } from "../../test/trace-run";
import { compactRun, readRequests, spansOf } from "./load";
import { formatCompare, formatSummary, summarize } from "./summary";

const USAGE =
	"usage: pnpm test-profile [run|latest] [--compare <run>] [--top N] [--jaeger]";

/** The run directory `name` means: an exact name, "latest", or the newest containing it. */
export function findRun(root: string, name = "latest"): string {
	const runs = existsSync(root)
		? readdirSync(root)
				.filter((d) => statSync(join(root, d)).isDirectory())
				.sort()
		: [];
	if (runs.includes(name)) return join(root, name);
	const match = runs.filter((d) => name === "latest" || d.includes(name));
	const found = match.at(-1);
	if (!found) {
		throw new Error(`no test traces match "${name}" in ${root}`);
	}
	return join(root, found);
}

function load(dir: string) {
	compactRun(dir);
	return spansOf(readRequests(dir));
}

const JAEGER = {
	name: "crb-jaeger",
	image: "jaegertracing/all-in-one:1.62.0",
	ui: 16686,
	otlp: 4318,
};

function sh(cmd: string, args: string[]): string {
	return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

async function jaeger(dir: string): Promise<void> {
	const ip = sh("tailscale", ["ip", "-4"]).split("\n")[0] ?? "";
	const state = (() => {
		try {
			return sh("docker", ["inspect", "-f", "{{.State.Running}}", JAEGER.name]);
		} catch {
			return "missing";
		}
	})();
	if (state === "missing") {
		sh("docker", [
			"run",
			"-d",
			"--name",
			JAEGER.name,
			"-e",
			"COLLECTOR_OTLP_ENABLED=true",
			// The UI on the Tailscale address only; OTLP on loopback.
			"-p",
			`${ip}:${JAEGER.ui}:16686`,
			"-p",
			`127.0.0.1:${JAEGER.otlp}:4318`,
			JAEGER.image,
		]);
	} else if (state !== "true") {
		sh("docker", ["start", JAEGER.name]);
	}
	const endpoint = `http://127.0.0.1:${JAEGER.otlp}/v1/traces`;
	const lines = readRequests(dir);
	// Up to 50 lines a request; Jaeger's collector may take a moment to listen.
	for (let i = 0; i < lines.length; i += 50) {
		const body = JSON.stringify({
			resourceSpans: lines.slice(i, i + 50).flatMap((l) => l.resourceSpans),
		});
		for (let attempt = 0; ; attempt++) {
			try {
				const res = await fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				});
				if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
				break;
			} catch (error) {
				if (attempt >= 30) throw error;
				await new Promise((r) => setTimeout(r, 500));
			}
		}
	}
	const run = dir.replace(/^.*\//, "");
	const spans = spansOf(lines);
	const start = Math.min(...spans.map((s) => s.startMs)) - 60_000;
	const end = Math.max(...spans.map((s) => s.endMs)) + 60_000;
	const service = run.includes("-unit-") ? "vitest" : "e2e";
	const params = new URLSearchParams({
		service,
		tags: JSON.stringify({ "crb.run": run }),
		start: String(Math.floor(start * 1000)),
		end: String(Math.ceil(end * 1000)),
		limit: "1500",
		lookback: "custom",
	});
	console.log(
		`🔎 ${spans.length} spans → http://${ip}:${JAEGER.ui}/search?${params}`,
	);
}

async function main(argv: string[]): Promise<void> {
	let run: string | undefined;
	let compare: string | undefined;
	let top = 8;
	let toJaeger = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--compare") compare = argv[++i];
		else if (a === "--top") top = Number(argv[++i]);
		else if (a === "--jaeger") toJaeger = true;
		else if (a === "-h" || a === "--help") {
			console.log(USAGE);
			return;
		} else if (a.startsWith("-")) throw new Error(USAGE);
		else run = a;
	}
	const root = traceRoot();
	const dir = findRun(root, run);
	const name = dir.replace(/^.*\//, "");
	if (toJaeger) {
		compactRun(dir);
		await jaeger(dir);
		return;
	}
	const summary = summarize(load(dir), top);
	if (compare) {
		const other = findRun(root, compare);
		const before = summarize(load(other), top);
		console.log(
			formatCompare(other.replace(/^.*\//, ""), before, name, summary),
		);
		return;
	}
	console.log(formatSummary(name, summary, top));
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`test-profile: ${(error as Error).message}`);
	process.exitCode = 1;
});
