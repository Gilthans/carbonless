import { hostname } from "node:os";
import { parseArgs } from "node:util";
import {
	DEVICE_NAME,
	readConfig,
	TELEMETRY_EVERY,
	updateConfig,
} from "../config.js";
import { readLiveServerState } from "../serverState.js";
import {
	deviceBranch,
	type MailboxStatus,
	pushMailbox,
	readStatus,
	shownRemote,
	telemetryDir,
} from "./mailbox.js";
import { defaultTraceDir } from "./traceDir.js";

const TELEMETRY_USAGE = `Usage: crb telemetry on <git remote> [--device <name>] [--every <minutes>] [--no-send]
       crb telemetry off
       crb telemetry status
       crb telemetry send

The telemetry mailbox: crb pushes its traces, logs and a snapshot of its
state (no keys or tokens) to a git repo you own, on the branch
device/<name>, with your own git credentials. Off by default.

  on      Turn it on and push once (--no-send: don't). --device defaults
          to this machine's name; --every to ${TELEMETRY_EVERY} minutes
  off     Turn it off (what was pushed stays in the repo)
  status  Whether it's on, and the last push
  send    Push now`;

/** This machine's name as a device name. */
export function defaultDevice(name = hostname()): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+|-+$/g, "")
		.slice(0, 64);
	return DEVICE_NAME.test(slug) ? slug : "device";
}

const ago = (iso: string, now = Date.now()): string => {
	const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (s < 90) return `${s}s ago`;
	if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
	if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
};

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function describe(status: MailboxStatus): string[] {
	const lines = [
		`last push: ${status.at} (${ago(status.at)}), ${status.ok ? "ok" : "FAILED"}${status.by === "cli" ? ", by crb telemetry send" : ""}`,
	];
	if (!status.ok) {
		lines.push(`  ${status.error ?? "unknown error"}`);
		lines.push(
			`last ok: ${status.lastOkAt ? `${status.lastOkAt} (${ago(status.lastOkAt)})` : "never"}`,
		);
	}
	if (status.tookOver) {
		lines.push(
			`${deviceBranch(status.device)} had been written by another crb since this device's last push (another machine with this device name, or a reinstall): taken over`,
		);
	}
	if (status.bytes !== undefined) {
		lines.push(
			`snapshot: ${status.files ?? 0} files, ${mb(status.bytes)}${status.newBytes !== undefined ? `, ${mb(status.newBytes)} new` : ""}`,
		);
	}
	if (status.tracesWaiting) {
		lines.push(
			`  ${status.tracesWaiting} older trace files wait for the next pushes (new data per push is capped)`,
		);
	}
	if (status.tracesOverCap) {
		lines.push(
			`  ${status.tracesOverCap} oldest trace files left out: the window's total cap`,
		);
	}
	return lines;
}

/**
 * Where crb serve traces: what the running one says, else
 * $CRB_TRACE_DIR, else the mailbox's default.
 */
async function traceDirNow(): Promise<string> {
	const server = await readLiveServerState().catch(() => null);
	return server?.traceDir ?? process.env.CRB_TRACE_DIR ?? defaultTraceDir();
}

async function send(print: (line: string) => void): Promise<number> {
	const { config } = await readConfig();
	if (!config.telemetry) {
		print("Telemetry is off: crb telemetry on <git remote> first.");
		return 1;
	}
	const result = await pushMailbox({
		telemetry: config.telemetry,
		config,
		traceDir: await traceDirNow(),
		by: "cli",
	});
	if (!result.status) {
		print("A push is already running (crb serve's); try again shortly.");
		return 1;
	}
	for (const line of describe(result.status)) print(line);
	return result.status.ok ? 0 : 1;
}

/** `crb telemetry …`; resolves to the exit code. */
export async function telemetryCli(
	argv: string[],
	print: (line: string) => void = (l) => console.log(l),
): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			device: { type: "string" },
			every: { type: "string" },
			"no-send": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		print(TELEMETRY_USAGE);
		return values.help ? 0 : 1;
	}
	const extraArgs = (n: number) => {
		if (rest.length > n) {
			throw new Error(`crb telemetry ${command}: too many arguments`);
		}
	};
	if (command === "on") {
		extraArgs(1);
		const mailbox = rest[0];
		if (!mailbox) throw new Error("crb telemetry on <git remote URL or path>");
		const device = values.device ?? defaultDevice();
		if (!DEVICE_NAME.test(device)) {
			throw new Error(
				`--device ${JSON.stringify(device)}: lowercase letters, digits, - or _`,
			);
		}
		const every =
			values.every === undefined ? TELEMETRY_EVERY : Number(values.every);
		if (!(every >= 1 && every <= 1440)) {
			throw new Error("--every takes minutes, from 1 to 1440");
		}
		await updateConfig((c) => ({
			...c,
			telemetry: { mailbox, device, every },
		}));
		print(
			`Telemetry on: ${shownRemote(mailbox)}, branch ${deviceBranch(device)}, every ${every} min.`,
		);
		const server = await readLiveServerState().catch(() => null);
		if (server && !server.traceDir) {
			print("The running crb serve traces from its next restart.");
		}
		// Pushed here, crb serve's next is an interval later.
		if (!values["no-send"]) return send(print);
		if (server) print("crb serve pushes within a minute.");
		return 0;
	}
	if (values.device !== undefined || values.every !== undefined) {
		throw new Error("--device and --every belong to crb telemetry on");
	}
	if (command === "off") {
		extraArgs(0);
		const { config } = await readConfig();
		await updateConfig(
			(c) => {
				const { telemetry: _off, ...rest } = c;
				return rest;
			},
			{ removeTelemetry: true },
		);
		print("Telemetry off.");
		if (config.telemetry) {
			print(
				`What was pushed stays on ${shownRemote(config.telemetry.mailbox)}: git push <remote> --delete ${deviceBranch(config.telemetry.device)} removes it. Local copy: ${telemetryDir()}`,
			);
		}
		return 0;
	}
	if (command === "status") {
		extraArgs(0);
		const { config } = await readConfig();
		const t = config.telemetry;
		print(
			t
				? `on: ${shownRemote(t.mailbox)}, branch ${deviceBranch(t.device)}, every ${t.every} min`
				: "off",
		);
		if (t) print(`traces: ${await traceDirNow()}`);
		const status = await readStatus();
		if (status) for (const line of describe(status)) print(line);
		else if (t) print("last push: none yet");
		return 0;
	}
	if (command === "send") {
		extraArgs(0);
		return send(print);
	}
	throw new Error(
		`crb telemetry: unknown command ${JSON.stringify(command)}\n${TELEMETRY_USAGE}`,
	);
}
