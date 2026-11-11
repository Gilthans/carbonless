import { describe, expect, it } from "vitest";
import { detectService, RESTART_EXIT } from "./service";

const UNIT_CGROUP =
	"0::/user.slice/user-1000.slice/user@1000.service/app.slice/crb.service\n";

function systemd(props: string, seen: string[][] = []) {
	return {
		env: { INVOCATION_ID: "abc" },
		platform: "linux" as const,
		pid: 42,
		readCgroup: async () => UNIT_CGROUP,
		systemctl: async (args: string[]) => {
			seen.push(args);
			return props;
		},
	};
}

describe("detectService", () => {
	it("none: a crb started from a shell", async () => {
		expect(
			await detectService({ env: {}, platform: "linux", pid: 4242 }),
		).toBeNull();
	});

	it("$CRB_SERVICE: any manager that restarts it on exit (launchd, a Windows service wrapper)", async () => {
		expect(
			await detectService({ env: { CRB_SERVICE: "1" }, platform: "win32" }),
		).toEqual({
			manager: "service",
			exitCode: RESTART_EXIT,
		});
		expect(
			await detectService({ env: { CRB_SERVICE: "0" }, platform: "win32" }),
		).toBeNull();
	});

	it("pm2", async () => {
		expect((await detectService({ env: { pm_id: "3" } }))?.manager).toBe("pm2");
	});

	it("systemd: the unit's main process, its Restart= picks the exit code", async () => {
		const seen: string[][] = [];
		expect(
			await detectService(systemd("MainPID=42\nRestart=on-failure\n", seen)),
		).toEqual({
			manager: "systemd (crb.service)",
			exitCode: RESTART_EXIT,
		});
		expect(seen).toEqual([
			["--user", "show", "crb.service", "--property=MainPID,Restart"],
		]);
		expect(
			(await detectService(systemd("MainPID=42\nRestart=always\n")))?.exitCode,
		).toBe(RESTART_EXIT);
		expect(
			(await detectService(systemd("MainPID=42\nRestart=on-success\n")))
				?.exitCode,
		).toBe(0);
		// Not started again: no one-click update.
		expect(
			(await detectService(systemd("MainPID=42\nRestart=no\n")))?.exitCode,
		).toBeNull();
	});

	it("systemd: not the main process (a wrapper, a shell the unit runs), or systemctl can't tell: the command only, never a helper systemd would kill", async () => {
		const managed = { manager: "systemd (crb.service)", exitCode: null };
		expect(await detectService(systemd("MainPID=7\nRestart=always\n"))).toEqual(
			managed,
		);
		expect(
			await detectService({
				...systemd(""),
				systemctl: async () => {
					throw new Error("no systemctl");
				},
			}),
		).toEqual(managed);
	});

	it("systemd, but not in a service (a session scope): none", async () => {
		expect(
			await detectService({
				...systemd("MainPID=42\nRestart=always\n"),
				readCgroup: async () =>
					"0::/user.slice/user-1000.slice/session-3.scope\n",
			}),
		).toBeNull();
	});

	it("PID 1 (a container's main process): the command only, unless CRB_SERVICE", async () => {
		expect(await detectService({ env: {}, platform: "linux", pid: 1 })).toEqual(
			{
				manager: "PID 1",
				exitCode: null,
			},
		);
		expect(
			(
				await detectService({
					env: { CRB_SERVICE: "1" },
					platform: "linux",
					pid: 1,
				})
			)?.exitCode,
		).toBe(RESTART_EXIT);
	});

	it("a system unit and cgroup v1", async () => {
		const seen: string[][] = [];
		expect(
			await detectService({
				...systemd("MainPID=42\nRestart=always\n", seen),
				readCgroup: async () =>
					"12:pids:/system.slice/crb.service\n1:name=systemd:/system.slice/crb.service\n",
			}),
		).not.toBeNull();
		expect(seen[0]?.[0]).toBe("show");
	});
});
