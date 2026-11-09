// pnpm test-profile [run|latest] [--compare <run>] [--top N] [--jaeger]
//
// Summarizes a test run's traces (docs/test-profiling.md). A run is named
// by its directory under ~/.cache/carbonless/test-traces, "latest", or any
// part of a name (the newest match: "e2e", "unit"). --jaeger loads it into
// a local Jaeger (docker) and prints the link.
import { execFileSync } from "node:child_process";
import { traceRoot } from "../../test/trace-run";
import { compactRun, readRequests, spansOf } from "./load";
import { findRun } from "./runs";
import { formatCompare, formatSummary, summarize } from "./summary";

const USAGE =
	"usage: pnpm test-profile [run|latest] [--compare <run>] [--top N] [--jaeger]";

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
	const spans = spansOf(readRequests(dir));
	if (spans.length === 0) {
		console.log("🔎 no spans in this run");
		return;
	}
	// Never all interfaces: the UI binds to the Tailscale address only.
	const ip = sh("tailscale", ["ip", "-4"]).split("\n")[0]?.trim() ?? "";
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
		throw new Error("no Tailscale IPv4 address (tailscale ip -4)");
	}
	const inspect = (format: string) => {
		try {
			return sh("docker", ["inspect", "-f", format, JAEGER.name]);
		} catch {
			return null;
		}
	};
	let state = inspect("{{.State.Running}}") ?? "missing";
	const bound = inspect(
		'{{(index (index .HostConfig.PortBindings "16686/tcp") 0).HostIp}}',
	);
	if (state !== "missing" && bound !== ip) {
		// Made for another address: made again.
		sh("docker", ["rm", "-f", JAEGER.name]);
		state = "missing";
	}
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
		else if (a === "--top") {
			top = Number(argv[++i]);
			if (!Number.isInteger(top) || top < 1) {
				throw new Error(`--top takes a count\n${USAGE}`);
			}
		} else if (a === "--jaeger") toJaeger = true;
		else if (a === "-h" || a === "--help") {
			console.log(USAGE);
			return;
		} else if (a.startsWith("-")) throw new Error(USAGE);
		else run = a;
	}
	const root = traceRoot();
	const found = findRun(root, run);
	const { dir } = found;
	if (toJaeger) {
		compactRun(dir);
		await jaeger(dir);
		return;
	}
	const summary = summarize(load(dir), top);
	const label = (r: typeof found) => (r.cwd ? `${r.name} · ${r.cwd}` : r.name);
	if (compare) {
		const other = findRun(root, compare);
		const before = summarize(load(other.dir), top);
		console.log(formatCompare(label(other), before, label(found), summary));
		return;
	}
	console.log(formatSummary(label(found), summary, top));
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`test-profile: ${(error as Error).message}`);
	process.exitCode = 1;
});
