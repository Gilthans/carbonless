import type { ChildProcess } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expectNoPageOverflow, tapHeight } from "./files-ui";
import {
	expect,
	OWNER_REPO,
	PR_NUMBER,
	reviewPage,
	startServe,
	stopChild,
	test,
} from "./fixtures";
import { crbEnv } from "./pr-setup";

// Its own crb serve, installed and restarted by the update: acme/widget#7.
test.use({ crbServer: "own" });

/**
 * The update toast (CAR-108) against a crb "installed from npm": the built
 * dist copied into a global npm prefix (`<prefix>/lib/node_modules/
 * carbonless-review`) with the gitHead CI writes, a fake registry offering a
 * newer version, and a fake npm on PATH that "installs" it by rewriting the
 * copy's version. The restart is the real one: crb exits, the helper
 * installs and starts it again on the same port.
 */

// setVersion's `require`, here and in the fake npm it is written into.
const require = createRequire(import.meta.url);

const ROOT = resolve(import.meta.dirname, "..");
const CURRENT = "0.2.0";
const NEWER = "0.3.0";

/**
 * A request while crb restarts: refused while it is down, or cut off as it
 * stops (it force-closes every socket; Chromium logs a reset or, on a
 * reused socket, not connected). Expected only for the restart's window
 * (expectConsoleError's end): from Update to the page seeing the outcome.
 */
const CRB_DOWN =
	/net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|SOCKET_NOT_CONNECTED)/;

interface Installed {
	pkg: string;
	cli: string;
	npmLog: string;
	failFile: string;
	env: NodeJS.ProcessEnv;
}

/**
 * Writes the copy's build-info.json and package.json at `version`, as npm
 * would install it: the gitHead CI writes (docs/releasing.md). Also the
 * fake npm's own code (serialised into it).
 */
function setVersion(pkg: string, version: string): void {
	const fs = require("node:fs") as typeof import("node:fs");
	const commit = "cccccccccccccccccccccccccccccccccccccccc";
	fs.writeFileSync(
		`${pkg}/dist/build-info.json`,
		JSON.stringify({ version, commit }),
	);
	fs.writeFileSync(
		`${pkg}/package.json`,
		JSON.stringify({
			name: "carbonless-review",
			version,
			type: "module",
			bin: { crb: "dist/cli.js" },
			gitHead: commit,
		}),
	);
}

/** A global npm install of the built crb in `workdir`, at CURRENT. */
function install(workdir: string, registry: string): Installed {
	const prefix = join(workdir, "npm-prefix");
	const pkg = join(prefix, "lib", "node_modules", "carbonless-review");
	mkdirSync(pkg, { recursive: true });
	cpSync(join(ROOT, "dist"), join(pkg, "dist"), {
		recursive: true,
		filter: (src) => !src.endsWith(".map"),
	});
	// Its dependencies: the checkout's.
	symlinkSync(join(ROOT, "node_modules"), join(pkg, "node_modules"), "dir");
	setVersion(pkg, CURRENT);
	// The prefix's bin: crb's shim (how a global npm install is told) and
	// the prefix's own npm, which an update runs.
	const bin = join(prefix, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "crb"),
		`#!/bin/sh\nexec "${process.execPath}" "${join(pkg, "dist", "cli.js")}" "$@"\n`,
	);
	chmodSync(join(bin, "crb"), 0o755);
	const npmLog = join(workdir, "npm.log");
	const failFile = join(workdir, "npm-fail");
	writeFileSync(
		join(bin, "npm"),
		`#!${process.execPath}
const fs = require("node:fs");
${setVersion.toString()}
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(npmLog)}, JSON.stringify(args) + "\\n");
if (fs.existsSync(${JSON.stringify(failFile)})) {
	console.error("npm error code E404");
	console.error("npm error 404 Not Found - GET carbonless-review@${NEWER}");
	process.exit(1);
}
const spec = args.at(-1) ?? "";
setVersion(${JSON.stringify(pkg)}, spec.slice(spec.lastIndexOf("@") + 1));
console.log("changed 1 package in 1s");
`,
	);
	chmodSync(join(bin, "npm"), 0o755);
	const env = crbEnv(workdir);
	for (const k of [
		"INVOCATION_ID",
		"CRB_SERVICE",
		"pm_id",
		"CRB_NO_UPDATE_CHECK",
	]) {
		delete env[k];
	}
	env.CRB_NPM_REGISTRY = registry;
	// The helper's temp dirs here, for teardown to wait on.
	env.TMPDIR = join(workdir, "tmp");
	mkdirSync(env.TMPDIR);
	return { pkg, cli: join(pkg, "dist", "cli.js"), npmLog, failFile, env };
}

/** The registry's answers the test steers: dist-tags, manifests, a hold. */
interface Registry {
	url: string;
	server: Server;
	/** Each version's manifest (`crbReleaseNotes` among its fields); absent: 404. */
	manifests: Record<string, unknown>;
	/** A status for every manifest instead (a failing registry); null: none. */
	failWith: { status: number } | null;
	/** Holds every manifest answer until `release()`. */
	hold: () => void;
	release: () => void;
	/** Manifest requests so far. */
	asked: string[];
}

/** A registry answering `tags` and `manifests` (the test may change them as it goes). */
async function fakeRegistry(tags: Record<string, string>): Promise<Registry> {
	let gate: Promise<void> | null = null;
	let open: () => void = () => {};
	const reg = {
		manifests: {} as Record<string, unknown>,
		failWith: null as { status: number } | null,
		asked: [] as string[],
	};
	const server = createServer((req, res) => {
		if (req.url === "/-/package/carbonless-review/dist-tags") {
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify(tags));
			return;
		}
		const m = /^\/carbonless-review\/([^/]+)$/.exec(req.url ?? "");
		if (!m) {
			res.writeHead(404).end("{}");
			return;
		}
		const version = decodeURIComponent(m[1] ?? "");
		reg.asked.push(version);
		void (async () => {
			if (gate) await gate;
			if (reg.failWith) {
				res.writeHead(reg.failWith.status).end("{}");
				return;
			}
			const manifest = reg.manifests[version];
			if (manifest === undefined) res.writeHead(404).end("{}");
			else
				res
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify(manifest));
		})();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return Object.assign(reg, {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		server,
		hold: () => {
			gate ??= new Promise<void>((r) => {
				open = r;
			});
		},
		release: () => {
			gate = null;
			open();
		},
	});
}

/** The crb the helper started, as it recorded it. */
function relaunchedPid(workdir: string): number | null {
	const file = join(workdir, "state", "carbonless", "update-relaunched.pid");
	if (!existsSync(file)) return null;
	const pid = Number(readFileSync(file, "utf8"));
	return pid > 0 ? pid : null;
}

/** The crb the helper started again (server.json), stopped at the end. */
function serverPid(workdir: string): number | null {
	const file = join(workdir, "state", "carbonless", "server.json");
	if (!existsSync(file)) return null;
	return (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid;
}

const it = test.extend<{
	installed: Installed & {
		/** The registry's dist-tags (`latest` and `rc` NEWER until changed). */
		tags: Record<string, string>;
		/** The registry itself: manifests, failures, a hold. */
		registry: Registry;
		/** Writes the installed copy's own notes (dist/release-notes.json). */
		setOwnNotes: (notes: unknown[] | null) => void;
		/** Sets the installed copy's version before it starts. */
		setCurrent: (version: string) => void;
		/** Starts it (`args` after `serve --port 0`, `env` over its own). */
		start: (
			args?: string[],
			env?: NodeJS.ProcessEnv,
		) => Promise<{ url: string; child: ChildProcess }>;
	};
}>({
	installed: async ({ workdir, page }, use) => {
		const tags: Record<string, string> = { latest: NEWER, rc: NEWER };
		const registry = await fakeRegistry(tags);
		const inst = install(workdir, registry.url);
		const children: ChildProcess[] = [];
		// NEWER carries its notes unless a test says otherwise.
		registry.manifests[NEWER] = { crbReleaseNotes: NEWER_NOTES };
		const ownNotes = join(inst.pkg, "dist", "release-notes.json");
		// A copy of a local build: notes only where a test writes them.
		rmSync(ownNotes, { force: true });
		await use({
			...inst,
			tags,
			registry,
			setOwnNotes: (notes) => {
				if (notes === null) rmSync(ownNotes, { force: true });
				else writeFileSync(ownNotes, JSON.stringify(notes));
			},
			setCurrent: (version) => setVersion(inst.pkg, version),
			start: async (args = [], env = {}) => {
				const served = await startServe(
					workdir,
					args,
					{ ...inst.env, ...env },
					inst.cli,
				);
				children.push(served.child);
				return { url: served.url.replace(/\/$/, ""), child: served.child };
			},
		});
		await page.goto("about:blank").catch(() => {});
		for (const child of children) await stopChild(child).catch(() => {});
		// A helper still at work (a test that failed mid-update) would start
		// crb after teardown: wait for it to finish first.
		const tmp = join(workdir, "tmp");
		const until = Date.now() + 60_000;
		while (
			readdirSync(tmp).some((d) => d.startsWith("crb-update-")) &&
			Date.now() < until
		) {
			await new Promise((r) => setTimeout(r, 100));
		}
		// The crb a helper started (after an update, or a failed one): its
		// pid as the helper recorded it (written before crb listens), and
		// server.json's.
		for (const pid of new Set([relaunchedPid(workdir), serverPid(workdir)])) {
			if (pid === null) continue;
			// Only this test's crb (a pid can be reused once it is gone).
			let cmdline = "";
			try {
				cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
			} catch {
				continue;
			}
			if (!cmdline.includes(join(workdir, "npm-prefix"))) continue;
			try {
				process.kill(pid, "SIGTERM");
				const gone = Date.now() + 10_000;
				while (Date.now() < gone) {
					process.kill(pid, 0);
					await new Promise((r) => setTimeout(r, 100));
				}
			} catch {
				// Gone.
			}
		}
		registry.release();
		registry.server.closeAllConnections();
		await new Promise((r) => registry.server.close(r));
	},
});

/** A port free right now (a service restarts crb on its configured port). */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	await new Promise((r) => server.close(r));
	return port;
}

const toast = (page: Page) => page.getByTestId("update-toast");
const modal = (page: Page) => page.getByTestId("whats-new");

/** The toast's What's new: the modal, open. */
async function openWhatsNew(page: Page) {
	await toast(page).getByTestId("update-open").click();
	await expect(modal(page)).toHaveAttribute("open", "");
	return modal(page);
}

/** The toast's What's new, then the modal's Update (the toast has none of its own). */
async function clickUpdate(page: Page, version = NEWER) {
	const m = await openWhatsNew(page);
	await m.getByRole("button", { name: `Update to v${version}` }).click();
}

/** Screenshots for the report, when DESIGN_SHOTS names a folder. */
async function shot(page: Page, name: string, isMobile: boolean) {
	const dir = process.env.DESIGN_SHOTS;
	if (!dir) return;
	await page.screenshot({
		path: `${dir}/${name}-${isMobile ? "phone" : "desktop"}.png`,
	});
}

const note = (id: string, pr: number, text: string, kind = "new") => ({
	id,
	kind,
	prs: [pr],
	text,
});

/** NEWER's manifest: its notes and the version between (0.2.1), the running one's too. */
const NEWER_NOTES = [
	{
		version: NEWER,
		date: "2026-11-15",
		notes: [
			note(
				"CAR-38",
				118,
				"Images show before and after side by side. A per-file Show as switch picks the view.",
			),
			note(
				"CAR-184",
				130,
				"Ignore whitespace also applies to the verdict.",
				"fixed",
			),
			// HTML in a note: dropped by crb's reader (and, were it shown, text).
			note("CAR-7", 7, 'Says <img src=x onerror="window.pwned=1"> here.'),
			// A bidi override: dropped and counted.
			note("CAR-8", 8, "Evil \u202etxet"),
		],
		none: [],
	},
	{
		version: "0.2.1",
		date: "2026-11-10",
		notes: [
			note(
				"CAR-120",
				120,
				"One agent conversation about the whole review.",
				"improved",
			),
		],
		none: [],
	},
	{ version: CURRENT, date: "2026-11-01", notes: [], none: [] },
];

/** Asserts What's new lists NEWER's notes: two versions, newest first. */
async function expectNewerNotes(page: Page) {
	const m = modal(page);
	await expect(m).toHaveAttribute("data-state", "loaded");
	await expect(m.getByTestId("notes-version")).toHaveCount(2);
	expect(
		await m
			.getByTestId("notes-version")
			.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.version)),
	).toEqual([NEWER, "0.2.1"]);
	await expect(m.getByTestId("release-note")).toHaveCount(3);
	await expect(m.getByTestId("notes-dropped")).toHaveText(
		"2 notes couldn't be read",
	);
	await expect(m.getByRole("link", { name: "#118" })).toHaveAttribute(
		"href",
		"https://github.com/Gilthans/carbonless/pull/118",
	);
	await expect(m.locator("img")).toHaveCount(0);
	expect(
		await page.evaluate(() => (window as { pwned?: number }).pwned),
	).toBeUndefined();
}

/** Opens the fixture PR's review on `url`'s crb; its address. */
async function openReview(url: string): Promise<string> {
	const res = await fetch(`${url}/api/reviews`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pr: `${OWNER_REPO}#${PR_NUMBER}` }),
	});
	const body = (await res.json()) as { url?: string; error?: string };
	if (!body.url) throw new Error(`no review: ${JSON.stringify(body)}`);
	return body.url;
}

it("an update on offer: on Home and on a review, linking to the release; dismissed per version", async ({
	page,
	pr,
	installed,
	isMobile,
}) => {
	await pr();
	if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
	const { url } = await installed.start();
	await page.goto(`${url}/`);
	await expect(toast(page)).toHaveAttribute("data-state", "available");
	await expect(toast(page)).toContainText("Update available");
	await expect(toast(page)).toContainText(`v${NEWER}`);
	// What's new is the toast's one action: no release link, no Update.
	await expect(toast(page).getByRole("link")).toHaveCount(0);
	await expect(
		toast(page).getByRole("button", { name: /^Update( to|$)/ }),
	).toHaveCount(0);
	await expectNoPageOverflow(page);
	await shot(page, "update-home", isMobile);
	// The offer is one button, named by its text, opening What's new.
	await expect(toast(page).getByRole("button")).toHaveCount(2);
	await expect(toast(page).getByTestId("update-open")).toHaveAccessibleName(
		`Update available v${NEWER}`,
	);
	for (const target of [
		toast(page).getByTestId("update-open"),
		toast(page).getByRole("button", { name: "Dismiss" }),
	]) {
		const box = await target.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
	}
	// Looks pressable: a button's border, and the tooltip on hover (not on a phone).
	const open = toast(page).getByTestId("update-open");
	expect(
		await open.evaluate((el) => getComputedStyle(el).borderTopWidth),
	).not.toBe("0px");
	if (!isMobile) {
		await open.hover();
		await expect(
			page.locator('[role="tooltip"]:not([hidden])', {
				hasText: `What's new in v${NEWER}`,
			}),
		).toBeVisible();
		await page.mouse.move(0, 0);
	}
	const review = await openReview(url);
	await page.goto(review);
	await expect(toast(page)).toHaveAttribute("data-state", "available");
	await expectNoPageOverflow(page);
	await shot(page, "update-review", isMobile);
	if (isMobile) {
		// Below md the save notices share the toasts' spot: the toasts sit
		// above as far as the notices reach (--sync-notices).
		await page.evaluate(() =>
			document.documentElement.style.setProperty("--sync-notices", "300px"),
		);
		await expect
			.poll(async () => {
				const box = await toast(page).boundingBox();
				return box ? 740 - (box.y + box.height) : 0;
			})
			.toBeGreaterThanOrEqual(300);
		await page.evaluate(() =>
			document.documentElement.style.removeProperty("--sync-notices"),
		);
	}
	await toast(page).getByRole("button", { name: "Dismiss" }).click();
	await expect(toast(page)).toHaveCount(0);
	await page.goto(reviewPage(review, "files"));
	await page.goto("about:blank");
	// Home asks again; once answered (the offer still there), still dismissed.
	const answered = page.waitForResponse(
		(r) => new URL(r.url()).pathname === "/api/update",
	);
	await page.goto(`${url}/`);
	expect(
		((await (await answered).json()) as { available: string }).available,
	).toBe(NEWER);
	// Rendered with that answer (a commit comes within two frames).
	await page.evaluate(
		() =>
			new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
	);
	expect(await toast(page).count()).toBe(0);
	expect(existsSync(installed.npmLog)).toBe(false);
});

it("What's new lists the versions between; its Update installs exactly that version with npm, restarts crb on its port, and the page reloads on the new version", async ({
	page,
	workdir,
	pr,
	installed,
	isMobile,
	expectConsoleError,
}) => {
	test.skip(isMobile, "no layout of its own");
	await pr();
	installed.registry.manifests[NEWER] = { crbReleaseNotes: NEWER_NOTES };
	const { url } = await installed.start();
	await page.goto(`${url}/`);
	await page.evaluate(() => {
		(window as unknown as { beforeUpdate: boolean }).beforeUpdate = true;
	});
	const before = (await (await fetch(`${url}/api/version`)).json()) as {
		boot: string;
	};
	const restarted = expectConsoleError(CRB_DOWN);
	// The toast's What's new: every version between, newest first; Update below.
	await openWhatsNew(page);
	await expectNewerNotes(page);
	await modal(page)
		.getByRole("button", { name: `Update to v${NEWER}` })
		.click();
	await expect(modal(page)).not.toHaveAttribute("open", "");
	await expect(toast(page)).toHaveAttribute("data-state", "updating");
	await expect(toast(page)).toContainText(`Updating to v${NEWER}`);
	// Installed, restarted, reloaded: a new page, on the new version, with
	// nothing newer on offer. The grace, npm and a start on a loaded
	// machine: well past the default wait.
	await expect
		.poll(
			() =>
				page
					.evaluate(
						() =>
							(window as unknown as { beforeUpdate?: boolean }).beforeUpdate ??
							false,
					)
					.catch(() => true),
			{ timeout: 90_000 },
		)
		.toBe(false);
	restarted();
	const version = (await (await fetch(`${url}/api/version`)).json()) as {
		version: string;
		boot: string;
	};
	expect(version.version).toBe(NEWER);
	// Another crb process: what tells an updating page it isn't the old one
	// in its grace (CAR-177).
	expect(version.boot).toEqual(expect.any(String));
	expect(version.boot).not.toBe(before.boot);
	expect(readFileSync(installed.npmLog, "utf8").trim().split("\n")).toEqual([
		JSON.stringify([
			"install",
			"-g",
			"--prefix",
			join(workdir, "npm-prefix"),
			`carbonless-review@${NEWER}`,
		]),
	]);
	// Rendered with that answer (a commit comes within two frames).
	await page.evaluate(
		() =>
			new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
	);
	expect(await toast(page).count()).toBe(0);
});

it("a failed install: a distinct error with npm's output and the command; the old crb is back", async ({
	page,
	pr,
	installed,
	isMobile,
	expectConsoleError,
}) => {
	await pr();
	if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
	writeFileSync(installed.failFile, "");
	const { url } = await installed.start();
	await page.goto(`${url}/`);
	const restarted = expectConsoleError(CRB_DOWN);
	await clickUpdate(page);
	await expect(toast(page)).toHaveAttribute("data-state", "updating");
	await shot(page, "update-updating", isMobile);
	await expect(toast(page)).toHaveAttribute("data-state", "failed", {
		timeout: 90_000,
	});
	restarted();
	await expect(toast(page)).toContainText(`Update to v${NEWER} failed`);
	await expect(toast(page).getByTestId("update-output")).toContainText(
		"npm error 404 Not Found",
	);
	await expect(toast(page).getByTestId("update-command")).toHaveText(
		`npm install -g carbonless-review@${NEWER}`,
	);
	await expectNoPageOverflow(page);
	await shot(page, "update-failed", isMobile);
	const version = (await (await fetch(`${url}/api/version`)).json()) as {
		version: string;
	};
	expect(version.version).toBe(CURRENT);
});

it("unsaved work: Update asks first; crb back, Reload, and leaving asks as always", async ({
	page,
	pr,
	installed,
	isMobile,
	expectConsoleError,
}) => {
	test.skip(isMobile, "no layout of its own");
	await pr();
	// Storage refuses: a typed message is kept nowhere but the page.
	await page.addInitScript(() => {
		Storage.prototype.setItem = () => {
			throw new DOMException("full", "QuotaExceededError");
		};
	});
	const { url } = await installed.start();
	const review = await openReview(url);
	await page.goto(reviewPage(review, "verdict"));
	const card = page.getByTestId("verdict-card-tab");
	await card.getByRole("checkbox", { name: "Include a message" }).check();
	await card.getByRole("textbox", { name: "Message" }).fill("Half a thought");
	const asked: string[] = [];
	page.once("dialog", (d) => {
		asked.push(d.type());
		void d.dismiss();
	});
	await clickUpdate(page);
	await expect.poll(() => asked).toEqual(["confirm"]);
	await expect(toast(page)).toHaveAttribute("data-state", "available");
	expect(existsSync(installed.npmLog)).toBe(false);
	page.on("dialog", (d) => {
		asked.push(d.type());
		void d.accept();
	});
	const restarted = expectConsoleError(CRB_DOWN);
	await clickUpdate(page);
	await expect(toast(page)).toHaveAttribute("data-state", "updating");
	await expect
		.poll(
			async () =>
				(
					(await (
						await fetch(`${url}/api/version`).catch(() => null)
					)
						?.json()
						.catch(() => null)) as {
						version?: string;
					} | null
				)?.version,
			{ timeout: 90_000 },
		)
		.toBe(NEWER);
	// Not reloaded by itself: what is unsaved now (also what was typed
	// while crb was down) is the reviewer's to give up.
	await expect(toast(page)).toHaveAttribute("data-state", "back", {
		timeout: 20_000,
	});
	restarted();
	await expect(card.getByRole("textbox", { name: "Message" })).toHaveValue(
		"Half a thought",
	);
	await toast(page).getByRole("button", { name: "Reload" }).click();
	await expect(card.getByRole("textbox", { name: "Message" })).toHaveCount(0, {
		timeout: 20_000,
	});
	expect(asked).toEqual(["confirm", "confirm", "beforeunload"]);
});

it("an rc install under a service manager: stays on rc past a release; installs while serving, exits 75, the manager starts the new one", async ({
	page,
	workdir,
	pr,
	installed,
	isMobile,
	expectConsoleError,
}) => {
	test.skip(isMobile, "no layout of its own");
	await pr();
	// An RC user; rc has just moved onto the release.
	installed.setCurrent("0.3.0-rc.1");
	installed.tags.latest = "0.2.0";
	installed.tags.rc = NEWER;
	const port = String(await freePort());
	// crb.service: Restart=on-failure, or any manager CRB_SERVICE names.
	const service = { CRB_SERVICE: "1" };
	const first = await installed.start(["--port", port], service);
	const exited = new Promise<number | null>((r) =>
		first.child.once("exit", (code) => r(code)),
	);
	await page.goto(`${first.url}/`);
	await expect(toast(page)).toContainText(`v${NEWER}`);
	await page.evaluate(() => {
		(window as unknown as { beforeUpdate: boolean }).beforeUpdate = true;
	});
	const restarted = expectConsoleError(CRB_DOWN);
	await clickUpdate(page);
	await expect(toast(page)).toHaveAttribute("data-state", "updating");
	// Installed while it still served, then exited for the manager.
	expect(await exited).toBe(75);
	expect(readFileSync(installed.npmLog, "utf8").trim().split("\n")).toEqual([
		JSON.stringify([
			"install",
			"-g",
			"--prefix",
			join(workdir, "npm-prefix"),
			`carbonless-review@${NEWER}`,
		]),
	]);
	// No helper started one: the manager does, on its port.
	expect(serverPid(workdir)).toBeNull();
	installed.tags.latest = NEWER;
	installed.tags.rc = "0.4.0-rc.1";
	const second = await installed.start(["--port", port], service);
	expect(second.url).toBe(first.url);
	await expect
		.poll(
			() =>
				page
					.evaluate(
						() =>
							(window as unknown as { beforeUpdate?: boolean }).beforeUpdate ??
							false,
					)
					.catch(() => true),
			{ timeout: 60_000 },
		)
		.toBe(false);
	restarted();
	// A release now, still on rc: the next RC is offered, never latest's.
	await expect(toast(page)).toContainText("v0.4.0-rc.1");
});

const FAQ = "https://github.com/Gilthans/carbonless/blob/master/docs/faq.md";

/** All of an element's text shows: nothing cut off or scrolled away. */
async function expectWhole(el: Locator) {
	const { scroll, client } = await el.evaluate((node) => ({
		scroll: node.scrollWidth,
		client: node.clientWidth,
	}));
	expect(scroll).toBeLessThanOrEqual(client);
	expect(
		await el.evaluate((node) => getComputedStyle(node).textOverflow),
	).not.toBe("ellipsis");
}

it("by hand (a folder crb can't write): the toast says why with the FAQ's section, the command stays; Global settings says the same", async ({
	page,
	pr,
	installed,
	isMobile,
}) => {
	test.skip(process.getuid?.() === 0, "root writes anywhere");
	await pr();
	if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
	// GitHub's pages, served here: a link's popup never leaves the machine.
	await page
		.context()
		.route("https://github.com/**", (r) =>
			r.fulfill({ contentType: "text/html", body: "<p>GitHub</p>" }),
		);
	// The prefix's node_modules, root-owned after a sudo install.
	const modules = join(installed.pkg, "..");
	chmodSync(modules, 0o555);
	try {
		const { url } = await installed.start();
		await page.goto(`${url}/`);
		await expect(toast(page)).toHaveAttribute("data-state", "available");
		// The toast says nothing of it: the command and why are in What's new.
		await expect(toast(page).getByTestId("update-command")).toHaveCount(0);
		await expect(toast(page).getByTestId("update-by-hand")).toHaveCount(0);
		await openWhatsNew(page);
		const why = modal(page).getByTestId("update-by-hand");
		await expect(why).toContainText(
			"No auto-update: installed in a folder crb can't write",
		);
		const help = why.getByRole("link", { name: "How to set up updates" });
		await expect(help).toHaveAttribute(
			"href",
			`${FAQ}#installed-in-a-folder-crb-cant-write`,
		);
		await expect(modal(page).getByTestId("update-command")).toHaveText(
			`npm install -g carbonless-review@${NEWER}`,
		);
		await expect(
			modal(page).getByRole("button", { name: /^Update( to|$)/ }),
		).toHaveCount(0);
		await expectNoPageOverflow(page);
		for (const target of [
			help,
			modal(page).getByRole("button", { name: "Copy command" }),
			modal(page).getByRole("button", { name: "Close" }),
		]) {
			const box = await target.boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
			expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
		}
		// The whole reason shows: wrapped where narrow, never cut off.
		await expectWhole(why.getByTestId("update-by-hand-text"));
		await shot(page, "update-by-hand-not-writable", isMobile);

		if (isMobile) {
			// A tap on the help link opens the FAQ; its tip doesn't stay
			// behind over the command row.
			const faq = page.context().waitForEvent("page");
			await help.tap();
			expect((await faq).url()).toBe(
				`${FAQ}#installed-in-a-folder-crb-cant-write`,
			);
			await expect(
				page.locator('[role="tooltip"]', { hasText: "How to set up updates" }),
			).toBeHidden();
		}

		// The other reasons, as crb would answer them (a service manager
		// can't be faked here): the toast's words and links.
		for (const [reason, manager, text, anchor] of [
			[
				"no-install",
				null,
				"not an npm/pnpm global install",
				"not-an-npm-or-pnpm-global-install",
			],
			[
				"service",
				"systemd (crb.service)",
				"systemd won't restart crb",
				"systemd-wont-restart-crb",
			],
			[
				"service",
				"PID 1",
				"crb is PID 1, nothing restarts it",
				"crb-is-a-containers-pid-1",
			],
		] as const) {
			await page.route("**/api/update", async (r) => {
				try {
					const res = await r.fetch();
					await r.fulfill({
						response: res,
						json: {
							...(await res.json()),
							byHandReason: reason,
							byHandManager: manager,
						},
					});
				} catch {
					// A poll cut off by the reload: nothing to answer.
				}
			});
			await page.reload();
			await openWhatsNew(page);
			await expect(why).toContainText(`No auto-update: ${text}`);
			await expect(help).toHaveAttribute("href", `${FAQ}#${anchor}`);
			await expectWhole(why.getByTestId("update-by-hand-text"));
			await expectNoPageOverflow(page);
			if (manager?.startsWith("systemd")) {
				// The unit's name: in the tip a tap or a key opens, from a
				// target of 40px.
				const reasonText = why.getByTestId("update-by-hand-text");
				expect(await tapHeight(reasonText)).toBeGreaterThanOrEqual(40);
				if (isMobile) await reasonText.tap();
				else await reasonText.focus();
				await expect(
					page.locator('[role="tooltip"]', { hasText: "crb.service" }),
				).toBeVisible();
				await expect(
					page.locator('[role="tooltip"]', { hasText: "crb.service" }),
				).toHaveText("No auto-update: systemd (crb.service) won't restart crb");
				await reasonText.blur();
			}
			await shot(page, `update-by-hand-${anchor}`, isMobile);
			await page.unrouteAll({ behavior: "ignoreErrors" });
		}

		// Global settings: the same words and link.
		const version = await openGlobalSettings(page, url);
		const install = version.getByTestId("version-install");
		await expect(install).toContainText(
			"No auto-update: installed in a folder crb can't write",
		);
		await expectWhole(install.getByTestId("update-by-hand-text"));
		const settingsHelp = install.getByRole("link", {
			name: "How to set up updates",
		});
		await expect(settingsHelp).toHaveAttribute(
			"href",
			`${FAQ}#installed-in-a-folder-crb-cant-write`,
		);
		const box = await settingsHelp.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
		await expectNoPageOverflow(page);
		await shot(page, "global-settings-by-hand", isMobile);
	} finally {
		chmodSync(modules, 0o755);
	}
});

/** Home's gear → Global settings: the page, at `url`'s crb. */
async function openGlobalSettings(page: Page, url: string) {
	await page.goto(`${url}/`);
	await page.getByRole("button", { name: "Settings" }).click();
	const settings = page.getByTestId("settings");
	// Home's popover: Global settings alone.
	await expect(settings.getByRole("switch")).toHaveCount(0);
	await settings.getByRole("link", { name: "Global settings" }).click();
	await expect(page).toHaveURL(/\/settings$/);
	await expect(
		page.getByRole("heading", { name: "Global settings" }),
	).toBeVisible();
	return page.getByTestId("settings-version");
}

it("Global settings: the running version; Check for updates offers the newer one, and its Update installs and restarts like the toast's", async ({
	page,
	workdir,
	pr,
	installed,
	isMobile,
	expectConsoleError,
}) => {
	await pr();
	if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
	// Nothing newer yet.
	installed.tags.latest = CURRENT;
	installed.tags.rc = CURRENT;
	const { url } = await installed.start();
	const version = await openGlobalSettings(page, url);
	await expect(version.getByTestId("version-current")).toContainText(CURRENT);
	await expect(version.getByRole("link", { name: /^ccccccc/ })).toHaveAttribute(
		"href",
		`https://github.com/Gilthans/carbonless/commit/${"c".repeat(40)}`,
	);
	await expect(version.getByTestId("version-install")).toHaveText(
		/channel latest\s*· npm global/,
	);
	const check = version.getByRole("button", { name: "Check for updates" });
	// The click asks crb, which asks the registry now: a check newer than
	// the start's, its answer the page's.
	const before = Date.now();
	const checked = page.waitForResponse(
		(r) =>
			new URL(r.url()).pathname === "/api/update/check" &&
			r.request().method() === "POST",
	);
	await check.click();
	const answer = await checked;
	expect(answer.status()).toBe(200);
	const fresh = (await answer.json()) as {
		lastChecked: string;
		available: string | null;
	};
	expect(Date.parse(fresh.lastChecked)).toBeGreaterThanOrEqual(before);
	expect(fresh.available).toBeNull();
	const result = version.getByTestId("update-result");
	await expect(result).toHaveAttribute("data-state", "current");
	await expect(result).toContainText("Up to date");
	await expect(version.getByTestId("version-checked")).toContainText(
		"checked now",
	);
	await expect(toast(page)).toHaveCount(0);
	await expectNoPageOverflow(page);
	for (const target of [
		check,
		page.getByRole("link", { name: "Home" }),
		version.getByRole("link", { name: /^ccccccc/ }),
	]) {
		const box = await target.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
	}
	await shot(page, "global-settings-current", isMobile);

	// A release comes out: the page's check finds it (the hourly one hasn't).
	installed.tags.latest = NEWER;
	installed.tags.rc = NEWER;
	await check.click();
	await expect(result).toHaveAttribute("data-state", "available");
	await expect(result).toContainText(`v${NEWER}`);
	// The toast offers it too.
	await expect(toast(page)).toHaveAttribute("data-state", "available");
	await expectNoPageOverflow(page);
	await shot(page, "global-settings-available", isMobile);
	await page.evaluate(() => {
		(window as unknown as { beforeUpdate: boolean }).beforeUpdate = true;
	});
	const restarted = expectConsoleError(CRB_DOWN);
	await result.getByRole("button", { name: "Update" }).click();
	await expect(toast(page)).toHaveAttribute("data-state", "updating");
	await expect(
		result.getByRole("status", { name: `Updating to v${NEWER}` }),
	).toBeVisible();
	// Installed, restarted, reloaded on the new version (as the toast's
	// Update: npm, the grace and a start on a loaded machine).
	await expect
		.poll(
			() =>
				page
					.evaluate(
						() =>
							(window as unknown as { beforeUpdate?: boolean }).beforeUpdate ??
							false,
					)
					.catch(() => true),
			{ timeout: 90_000 },
		)
		.toBe(false);
	restarted();
	expect(readFileSync(installed.npmLog, "utf8").trim().split("\n")).toEqual([
		JSON.stringify([
			"install",
			"-g",
			"--prefix",
			join(workdir, "npm-prefix"),
			`carbonless-review@${NEWER}`,
		]),
	]);
	await expect(
		page.getByTestId("settings-version").getByTestId("version-current"),
	).toContainText(NEWER);
});

it("Global settings with checks off: the version, why it never checks, no Check button", async ({
	page,
	pr,
	installed,
	isMobile,
}) => {
	test.skip(isMobile, "the page's layout is the test above's");
	await pr();
	const { url } = await installed.start([], { CRB_NO_UPDATE_CHECK: "1" });
	const version = await openGlobalSettings(page, url);
	await expect(version.getByTestId("version-current")).toContainText(CURRENT);
	await expect(version.getByTestId("updates-off")).toContainText(
		"updates off: CRB_NO_UPDATE_CHECK",
	);
	await expect(
		version.getByRole("button", { name: "Check for updates" }),
	).toHaveCount(0);
	await shot(page, "global-settings-off", isMobile);
});

/** The boxes of the modal's header controls (a spinner showing must move none). */
const headerBoxes = async (page: Page) => {
	const m = modal(page);
	return Promise.all(
		[
			m.getByTestId("whats-new-spinner-slot"),
			m.getByRole("button", { name: "Close" }),
			m.getByTestId("whats-new-range"),
		].map((l) => l.boundingBox()),
	);
};

it("What's new while the registry holds the notes: skeleton and spinner in place, Update already there; then the notes, nothing moved", async ({
	page,
	pr,
	installed,
	isMobile,
}) => {
	await pr();
	if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
	installed.registry.manifests[NEWER] = { crbReleaseNotes: NEWER_NOTES };
	// Held from the start: the prefetch when the update is found waits too.
	installed.registry.hold();
	const { url } = await installed.start();
	await page.goto(`${url}/`);
	await expect(toast(page)).toHaveAttribute("data-state", "available");
	const m = await openWhatsNew(page);
	// Focus on the title: no button's tooltip pops over the notes.
	await expect(m.getByRole("heading", { name: "What's new" })).toBeFocused();
	await expect(
		page.locator('[role="tooltip"]:not([hidden])', { hasText: "Close" }),
	).toHaveCount(0);
	await expect(m).toHaveAttribute("data-state", "loading");
	await expect(m.getByTestId("whats-new-body")).toHaveAttribute(
		"aria-busy",
		"true",
	);
	await expect(m.getByRole("status", { name: "Loading notes" })).toBeVisible();
	await expect(m.getByTestId("notes-loading")).toBeVisible();
	await expect(m.getByText("No user-facing changes")).toHaveCount(0);
	await expect(m.getByTestId("notes-version")).toHaveCount(0);
	await expect(
		m.getByRole("button", { name: `Update to v${NEWER}` }),
	).toBeEnabled();
	await expect(m.getByTestId("whats-new-range")).toHaveText(
		isMobile ? `→ v${NEWER}` : `v${CURRENT} → v${NEWER}`,
		{ useInnerText: true },
	);
	await expectNoPageOverflow(page);
	await shot(page, "whats-new-loading", isMobile);
	const before = await headerBoxes(page);
	installed.registry.release();
	await expectNewerNotes(page);
	await expect(m.getByRole("status", { name: "Loading notes" })).toHaveCount(0);
	expect(await headerBoxes(page)).toEqual(before);
	expect(installed.registry.asked).toEqual([NEWER]);
	// A long note: its first sentence, the rest behind its own Show more.
	const long = m.getByTestId("release-note").first();
	await expect(long.getByTestId("release-note-text")).toHaveText(
		"Images show before and after side by side.",
	);
	await expectNoPageOverflow(page);
	await shot(page, "whats-new-loaded", isMobile);
	await long.getByRole("button", { name: /Show more/ }).click();
	await expect(long.getByTestId("release-note-text")).toContainText(
		"A per-file Show as switch picks the view.",
	);
	// 40px targets, and a phone's Update: full width, 44px.
	const targets = [
		m.getByRole("button", { name: "Close" }),
		m.getByRole("link", { name: "Release on GitHub" }).first(),
		m.getByRole("link", { name: "#118" }),
		long.getByRole("button", { name: /Show less/ }),
	];
	for (const t of [...targets, m.getByRole("img", { name: "New" }).first()]) {
		const box = await t.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
	}
	const update = await m
		.getByRole("button", { name: `Update to v${NEWER}` })
		.boundingBox();
	if (isMobile) {
		expect(update?.height ?? 0).toBeGreaterThanOrEqual(44);
		expect(update?.width ?? 0).toBeGreaterThan(300);
	} else {
		expect(update?.height ?? 0).toBeGreaterThanOrEqual(40);
	}
	await expectNoPageOverflow(page);
	// Escape closes it; focus back on the toast's What's new.
	await page.keyboard.press("Escape");
	await expect(m).not.toHaveAttribute("open", "");
	await expect(toast(page).getByTestId("update-open")).toBeFocused();
	// Opened again: the kept notes, no second read of the registry.
	await openWhatsNew(page);
	await expect(m).toHaveAttribute("data-state", "loaded");
	expect(installed.registry.asked).toEqual([NEWER]);
});

it("What's new when the notes fail: a warn notice with the reason, Update still there; Retry loads them", async ({
	page,
	pr,
	installed,
	isMobile,
	expectConsoleError,
}) => {
	// crb's answer while the registry fails: the notes' 502.
	expectConsoleError(/status of 502/);
	await pr();
	if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
	installed.registry.failWith = { status: 503 };
	const { url } = await installed.start();
	await page.goto(`${url}/`);
	const m = await openWhatsNew(page);
	await expect(m).toHaveAttribute("data-state", "failed");
	const alert = m.getByRole("alert");
	await expect(alert).toContainText("Notes didn't load");
	if (!isMobile) await expect(alert).toContainText("Registry answered 503");
	await expect(
		alert.getByRole("link", { name: "Release on GitHub" }),
	).toHaveAttribute(
		"href",
		`https://github.com/Gilthans/carbonless/releases/tag/v${NEWER}`,
	);
	await expect(m.getByText("No user-facing changes")).toHaveCount(0);
	await expect(
		m.getByRole("button", { name: `Update to v${NEWER}` }),
	).toBeEnabled();
	for (const t of [
		alert.getByRole("button", { name: "Retry" }),
		alert.getByRole("link", { name: "Release on GitHub" }),
	]) {
		expect((await t.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	}
	await expectNoPageOverflow(page);
	await shot(page, "whats-new-failed", isMobile);
	installed.registry.failWith = null;
	installed.registry.manifests[NEWER] = { crbReleaseNotes: NEWER_NOTES };
	await alert.getByRole("button", { name: "Retry" }).click();
	await expectNewerNotes(page);
	await expect(m.getByRole("alert")).toHaveCount(0);
});

it("What's new on rc: only what the running RC didn't have, under the offered RC, and the changes with no notes yet", async ({
	page,
	pr,
	installed,
	isMobile,
}) => {
	await pr();
	if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
	const RC = `${NEWER}-rc.5`;
	installed.setCurrent(`${NEWER}-rc.3`);
	installed.tags.latest = CURRENT;
	installed.tags.rc = RC;
	installed.setOwnNotes([
		{
			version: NEWER,
			date: null,
			notes: [note("CAR-1", 101, "Threads tab beside the file tree.")],
			none: [],
			uncovered: [102],
		},
	]);
	installed.registry.manifests[RC] = {
		crbReleaseNotes: [
			{
				version: NEWER,
				date: null,
				notes: [
					note("CAR-1", 101, "Threads tab beside the file tree."),
					note(
						"CAR-2",
						135,
						"Threads tab: j and k step through conversations.",
						"improved",
					),
				],
				none: [],
				uncovered: [102, 136, 137],
			},
			{
				version: CURRENT,
				date: "2026-11-01",
				notes: [],
				none: [],
			},
		],
	};
	const { url } = await installed.start();
	await page.goto(`${url}/`);
	const m = await openWhatsNew(page);
	await expect(m).toHaveAttribute("data-state", "loaded");
	await expect(m.getByTestId("whats-new-range")).toHaveText(
		isMobile ? `→ v${RC}` : `rc.3 → v${RC}`,
		{ useInnerText: true },
	);
	await expect(m.getByTestId("notes-version")).toHaveCount(1);
	await expect(m.getByTestId("notes-version")).toHaveAttribute(
		"data-version",
		RC,
	);
	await expect(m.getByTestId("release-note-text")).toHaveText([
		"Threads tab: j and k step through conversations.",
	]);
	const more = m.getByTestId("notes-uncovered");
	await expect(more).toHaveText("2 more changes, no notes yet");
	await expect(more).toHaveAttribute(
		"href",
		`https://github.com/Gilthans/carbonless/compare/v${NEWER}-rc.3...v${RC}`,
	);
	expect((await more.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	// Not released yet: no release page.
	await expect(m.getByRole("link", { name: "Release on GitHub" })).toHaveCount(
		0,
	);
	await expectNoPageOverflow(page);
	await shot(page, "whats-new-rc", isMobile);
});

it("Global settings: the running version's notes under Version; Show more opens older versions 5 at a time, each with its own Show more; What's new beside Update opens the same modal", async ({
	page,
	pr,
	installed,
	isMobile,
}) => {
	await pr();
	if (isMobile) await page.setViewportSize({ width: 360, height: 740 });
	installed.registry.manifests[NEWER] = { crbReleaseNotes: NEWER_NOTES };
	installed.setOwnNotes([
		{
			version: CURRENT,
			date: "2026-11-01",
			notes: [
				note(
					"CAR-110",
					110,
					"Files changed has a Threads tab. Every conversation, newest first.",
				),
				note("CAR-120", 120, "One agent conversation about the whole review."),
				note(
					"CAR-130",
					130,
					"Ignore whitespace applies to the verdict.",
					"fixed",
				),
				note("CAR-140", 140, "A fourth note."),
			],
			none: [],
		},
		// Seven earlier releases (the file carries every one), newest first.
		...Array.from({ length: 7 }, (_, i) => ({
			version: `0.1.${6 - i}`,
			date: "2026-10-01",
			notes: [
				note("CAR-10", 10 + i, `Release 0.1.${6 - i}, first. Its detail.`),
				note("CAR-11", 20 + i, "Second note."),
				note("CAR-12", 30 + i, "Third note."),
				note("CAR-13", 40 + i, "Fourth note."),
			],
		})),
	]);
	const { url } = await installed.start();
	const version = await openGlobalSettings(page, url);
	const notes = version.getByTestId("running-notes");
	await expect(notes.getByTestId("release-note-text")).toHaveText([
		"Files changed has a Threads tab.",
		"One agent conversation about the whole review.",
		"Ignore whitespace applies to the verdict.",
	]);
	await expectNoPageOverflow(page);
	await shot(page, "global-settings-notes", isMobile);
	const more = notes.getByTestId("running-notes-toggle");
	expect((await more.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	await more.click();
	// The running version in full, then 5 older versions, folded.
	await expect(notes.getByTestId("release-note-text").first()).toHaveText(
		"Files changed has a Threads tab. Every conversation, newest first.",
	);
	const versions = notes.getByTestId("notes-version");
	await expect(versions).toHaveCount(5);
	expect(
		await versions.evaluateAll((els) =>
			els.map((e) => (e as HTMLElement).dataset.version),
		),
	).toEqual(["0.1.6", "0.1.5", "0.1.4", "0.1.3", "0.1.2"]);
	const older = versions.first();
	await expect(older.getByTestId("release-note-text")).toHaveText([
		"Release 0.1.6, first.",
		"Second note.",
		"Third note.",
	]);
	await expect(older.getByTestId("release-date")).toBeVisible();
	await expectNoPageOverflow(page);
	await shot(page, "global-settings-notes-more", isMobile);
	// Its own Show more: all its notes, in full.
	await older.getByRole("button", { name: /Show more/ }).click();
	await expect(older.getByTestId("release-note-text")).toHaveText([
		"Release 0.1.6, first. Its detail.",
		"Second note.",
		"Third note.",
		"Fourth note.",
	]);
	// Show more versions: the next ones, until there are no more.
	const moreVersions = notes.getByTestId("more-versions");
	expect(
		(await moreVersions.boundingBox())?.height ?? 0,
	).toBeGreaterThanOrEqual(40);
	await moreVersions.click();
	await expect(versions).toHaveCount(7);
	await expect(moreVersions).toHaveCount(0);
	await expectNoPageOverflow(page);
	await shot(page, "global-settings-notes-all", isMobile);
	await notes.getByTestId("running-notes-toggle").click();
	await expect(notes.getByTestId("release-note-text")).toHaveCount(3);
	await expect(versions).toHaveCount(0);
	// The update on offer: What's new beside Update, the same modal.
	const result = version.getByTestId("update-result");
	await expect(result).toHaveAttribute("data-state", "available");
	await expectNoPageOverflow(page);
	await shot(page, "global-settings-whats-new", isMobile);
	const whatsNew = result.getByRole("button", { name: "What's new" });
	expect((await whatsNew.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
		40,
	);
	await whatsNew.click();
	await expect(modal(page)).toHaveAttribute("open", "");
	await expectNewerNotes(page);
	await expect(
		modal(page).getByRole("button", { name: `Update to v${NEWER}` }),
	).toBeVisible();
});

it("Global settings of a build without notes (a local build): nothing under Version", async ({
	page,
	pr,
	installed,
	isMobile,
}) => {
	test.skip(isMobile, "the page's layout is the test above's");
	await pr();
	installed.setOwnNotes(null);
	const { url } = await installed.start();
	const version = await openGlobalSettings(page, url);
	await expect(version.getByTestId("version-current")).toContainText(CURRENT);
	// Answered (the Install row renders with the same read), and empty.
	await expect(version.getByTestId("version-install")).toBeVisible();
	const answered = await page.evaluate(async () =>
		(await fetch("/api/release-notes")).json(),
	);
	expect(answered).toMatchObject({ file: false });
	await expect(version.getByTestId("running-notes")).toHaveCount(0);
	await expect(version.getByText("No user-facing changes")).toHaveCount(0);
});
