import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * A service manager that starts crb again when it exits: crb then installs
 * while it still runs and exits with `exitCode` for the manager to start
 * the new version, rather than relaunching itself (the manager would kill
 * a helper left in its unit, and start crb while the install runs).
 * `exitCode` null: managed, but the manager won't start it again (systemd
 * `Restart=no`): no one-click update, the command instead.
 */
export interface Service {
	manager: string;
	exitCode: number | null;
}

/** Exit code for "start me again": non-zero, so `Restart=on-failure` counts it. */
export const RESTART_EXIT = 75;

export interface ServiceDeps {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	pid?: number;
	readCgroup?: () => Promise<string>;
	systemctl?: (args: string[]) => Promise<string>;
}

const systemctl = (args: string[]) =>
	new Promise<string>((done, fail) => {
		execFile("systemctl", args, { timeout: 5000 }, (error, stdout) =>
			error ? fail(error) : done(stdout),
		);
	});

/**
 * Which service manager runs this crb, if one does:
 * - `$CRB_SERVICE` set (not "0"): one that restarts it on any exit (set it
 *   in a launchd job, a Windows service wrapper such as NSSM or WinSW, a
 *   container's restart policy);
 * - pm2 (`$pm_id`);
 * - systemd (`$INVOCATION_ID`, in a `.service` cgroup): when crb is its
 *   unit's main process (`systemctl show`'s MainPID), its `Restart=`
 *   decides the exit code; when it isn't (a wrapper script, a shell the
 *   unit runs), or systemctl can't tell, the command only: systemd kills
 *   whatever is left in the unit when its main process ends, a helper too;
 * - PID 1 (a container's main process): the command only, since the
 *   container ends with it, unless `$CRB_SERVICE` says something restarts it.
 */
export async function detectService(
	deps: ServiceDeps = {},
): Promise<Service | null> {
	const env = deps.env ?? process.env;
	const flag = env.CRB_SERVICE;
	if (flag && flag !== "0")
		return { manager: "service", exitCode: RESTART_EXIT };
	if (env.pm_id !== undefined)
		return { manager: "pm2", exitCode: RESTART_EXIT };
	if ((deps.pid ?? process.pid) === 1) {
		return { manager: "PID 1", exitCode: null };
	}
	if (!env.INVOCATION_ID || (deps.platform ?? process.platform) !== "linux") {
		return null;
	}
	try {
		const cgroup = await (
			deps.readCgroup ?? (() => readFile("/proc/self/cgroup", "utf8"))
		)();
		// cgroup v2's one line, or v1's systemd hierarchy.
		const line = cgroup
			.split("\n")
			.find((l) => l.startsWith("0::") || l.includes(":name=systemd:"));
		const segments = line?.slice(line.lastIndexOf(":") + 1).split("/") ?? [];
		const unit = segments.at(-1);
		if (!unit?.endsWith(".service")) return null;
		const user = segments.some((s) => /^user@\d+\.service$/.test(s));
		const managed: Service = { manager: `systemd (${unit})`, exitCode: null };
		const out = await (deps.systemctl ?? systemctl)([
			...(user ? ["--user"] : []),
			"show",
			unit,
			"--property=MainPID,Restart",
		]).catch(() => null);
		if (out === null) return managed;
		const props = Object.fromEntries(
			out
				.trim()
				.split("\n")
				.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
		);
		if (Number(props.MainPID) !== (deps.pid ?? process.pid)) return managed;
		const restart = props.Restart ?? "no";
		const exitCode =
			restart === "always" || restart === "on-failure"
				? RESTART_EXIT
				: restart === "on-success"
					? 0
					: null;
		return { manager: `systemd (${unit})`, exitCode };
	} catch {
		return null;
	}
}
