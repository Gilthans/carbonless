// pnpm test-profile [run|latest|<path>] [--compare <run|path>] [--top N] [--jaeger]
// pnpm test-profile <server trace dir> [--since 1d] [--only <build>] [--top N] [--jaeger]
// pnpm test-profile <server trace dir> [--since 1d] --compare-version <a> <b>
// pnpm test-profile [unit run] --write-durations [--force]
//
// Summarizes a test run's traces (docs/test-profiling.md). A run is named
// by its directory under ~/.cache/carbonless/test-traces, "latest", or any
// part of a name (the newest match: "e2e", "unit"), or by a path: a run
// directory or a directory of runs, such as a CI artifact downloaded with
// `gh run download <id> -n test-traces-e2e -D <dir>`. --jaeger loads it into
// a local Jaeger (docker) and prints the link. --write-durations writes a
// unit run's file durations into the list the Vitest sequencer starts
// the slowest files by (scripts/test-profile/sequencer.mjs). A crb serve's
// trace directory ($CRB_TRACE_DIR: no run.json, crb's files) is read as a
// server: its slowest routes and gh/git calls, over `--since` (30m, 6h,
// 1d, 2w or a date); it is never packed. Spans carry the build that wrote
// them: `--only` keeps one build's (a version, a build as listed, a commit's start),
// `--compare-version` puts two side by side.
import { execFileSync } from "node:child_process";
import { traceRoot } from "../../test/trace-run";
import { writeDurations } from "./durations";
import {
	extent,
	type OtlpRequest,
	readRequests,
	spansOf,
	viewRun,
} from "./load";
import { resolveRun } from "./runs";
import { DURATIONS_FILE } from "./sequencer.mjs";
import {
	formatServer,
	formatServerCompare,
	ofBuild,
	parseSince,
	readServerRequests,
	summarizeServer,
} from "./server";
import { formatCompare, formatSummary, summarize } from "./summary";

const USAGE =
	"usage: pnpm test-profile [run|latest|<path>] [--compare <run|path>] [--top N] [--jaeger]\n       pnpm test-profile <server trace dir> [--since 1d] [--only <build>] [--top N] [--jaeger]\n       pnpm test-profile <server trace dir> [--since 1d] --compare-version <a> <b>\n       pnpm test-profile [unit run] --write-durations [--force]";

const load = (dir: string) => viewRun(dir);

/** A server directory's window when --since isn't given. */
const SERVER_WINDOW = "7d";

const JAEGER = {
	name: "crb-jaeger",
	image: "jaegertracing/all-in-one:1.62.0",
	ui: 16686,
	otlp: 4318,
};

function sh(cmd: string, args: string[]): string {
	return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

interface JaegerView {
	/** Jaeger's service to search. */
	service: string;
	/** Tags to search by, if any. */
	tags?: Record<string, string>;
}

async function jaeger(lines: OtlpRequest[], view: JaegerView): Promise<void> {
	const spans = spansOf(lines);
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
	const start = (extent(spans.map((s) => s.startMs))?.[0] ?? 0) - 60_000;
	const end = (extent(spans.map((s) => s.endMs))?.[1] ?? 0) + 60_000;
	const params = new URLSearchParams({
		service: view.service,
		...(view.tags ? { tags: JSON.stringify(view.tags) } : {}),
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
	let topSet = false;
	let toJaeger = false;
	let toDurations = false;
	let force = false;
	let since: string | undefined;
	let only: string | undefined;
	let versions: [string, string] | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a === "--compare") compare = argv[++i];
		else if (a === "--top") {
			top = Number(argv[++i]);
			topSet = true;
			if (!Number.isInteger(top) || top < 1) {
				throw new Error(`--top takes a count\n${USAGE}`);
			}
		} else if (a === "--since") {
			since = argv[++i] ?? "";
			parseSince(since); // Refused before anything is read.
		} else if (a === "--only") only = argv[++i];
		else if (a === "--compare-version") {
			const x = argv[++i];
			const y = argv[++i];
			if (!x || !y)
				throw new Error(`--compare-version takes two builds\n${USAGE}`);
			versions = [x, y];
		} else if (a === "--jaeger") toJaeger = true;
		else if (a === "--write-durations") toDurations = true;
		else if (a === "--force") force = true;
		else if (a === "-h" || a === "--help") {
			console.log(USAGE);
			return;
		} else if (a.startsWith("-")) throw new Error(USAGE);
		else run = a;
	}
	const root = traceRoot();
	const found = resolveRun(root, run ?? (toDurations ? "unit" : undefined));
	const { dir } = found;
	if (found.server) {
		if (toDurations || compare) {
			throw new Error(
				`a server's trace directory takes --since, --top, --jaeger\n${USAGE}`,
			);
		}
		// A week unless asked: the whole directory can be a GiB of JSON.
		const window = since ?? SERVER_WINDOW;
		const lines = readServerRequests(dir, parseSince(window));
		const label = `${dir} · since ${window}${since ? "" : " (default; --since to change)"}`;
		const n = topSet ? top : 15;
		if (versions) {
			if (only) {
				throw new Error(
					`--only and --compare-version don't go together: the comparison names its two builds\n${USAGE}`,
				);
			}
			const spans = spansOf(lines);
			const [a, b] = versions;
			console.log(
				formatServerCompare(
					`${a} (since ${window})`,
					summarizeServer(ofBuild(spans, a)),
					b,
					summarizeServer(ofBuild(spans, b)),
					n,
				),
			);
		} else if (toJaeger) {
			// Every build's spans: Jaeger filters by tag itself
			// (service.version, service.commit).
			if (only) throw new Error(`--only doesn't apply to --jaeger\n${USAGE}`);
			await jaeger(lines, { service: "crb" });
		} else {
			const spans = spansOf(lines);
			const summary = summarizeServer(only ? ofBuild(spans, only) : spans);
			console.log(formatServer(label, summary, n));
		}
		return;
	}
	const serverOnly = [
		since !== undefined && "--since",
		only !== undefined && "--only",
		versions && "--compare-version",
	].filter(Boolean);
	if (serverOnly.length) {
		throw new Error(
			`${serverOnly.join(", ")} applies to a server's trace directory, not a test run\n${USAGE}`,
		);
	}
	if (toDurations) {
		const { count, changes } = writeDurations(process.cwd(), load(dir), force);
		console.log(`⏳ ${count} files from ${found.name} → ${DURATIONS_FILE}`);
		if (changes) console.log(`biggest changes:\n${changes}`);
		return;
	}
	if (toJaeger) {
		viewRun(dir); // Packs a finished run first.
		const run = dir.replace(/^.*\//, "");
		await jaeger(readRequests(dir), {
			service: run.includes("-unit-") ? "vitest" : "e2e",
			tags: { "crb.run": run },
		});
		return;
	}
	const summary = summarize(load(dir), top);
	const label = (r: typeof found) => (r.cwd ? `${r.name} · ${r.cwd}` : r.name);
	if (compare) {
		const other = resolveRun(root, compare);
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
