import type { ChildProcess } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expectNoPageOverflow } from "./files-ui";
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

/** A registry answering `tags` (the test may change them as it goes). */
async function fakeRegistry(
	tags: Record<string, string>,
): Promise<{ url: string; server: Server }> {
	const server = createServer((req, res) => {
		if (req.url === "/-/package/carbonless-review/dist-tags") {
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify(tags));
		} else res.writeHead(404).end("{}");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		server,
	};
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
		await use({
			...inst,
			tags,
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

/** Screenshots for the report, when DESIGN_SHOTS names a folder. */
async function shot(page: Page, name: string, isMobile: boolean) {
	const dir = process.env.DESIGN_SHOTS;
	if (!dir) return;
	await page.screenshot({
		path: `${dir}/${name}-${isMobile ? "phone" : "desktop"}.png`,
	});
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
	await expect(
		toast(page).getByRole("link", { name: `v${NEWER}` }),
	).toHaveAttribute(
		"href",
		`https://github.com/Gilthans/carbonless/releases/tag/v${NEWER}`,
	);
	await expect(
		toast(page).getByRole("button", { name: "Update" }),
	).toBeVisible();
	await expectNoPageOverflow(page);
	await shot(page, "update-home", isMobile);
	for (const name of ["Update", "Dismiss"]) {
		const box = await toast(page).getByRole("button", { name }).boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
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

it("Update installs exactly that version with npm, restarts crb on its port, and the page reloads on the new version", async ({
	page,
	workdir,
	pr,
	installed,
	isMobile,
	expectConsoleError,
}) => {
	test.skip(isMobile, "no layout of its own");
	// The page's requests while crb is down.
	expectConsoleError(/ERR_CONNECTION_REFUSED/);
	await pr();
	const { url } = await installed.start();
	await page.goto(`${url}/`);
	await page.evaluate(() => {
		(window as unknown as { beforeUpdate: boolean }).beforeUpdate = true;
	});
	await toast(page).getByRole("button", { name: "Update" }).click();
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
	const version = (await (await fetch(`${url}/api/version`)).json()) as {
		version: string;
	};
	expect(version.version).toBe(NEWER);
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
	// The page's polls while crb is down.
	expectConsoleError(/ERR_CONNECTION_REFUSED/);
	writeFileSync(installed.failFile, "");
	const { url } = await installed.start();
	await page.goto(`${url}/`);
	await toast(page).getByRole("button", { name: "Update" }).click();
	await expect(toast(page)).toHaveAttribute("data-state", "updating");
	await shot(page, "update-updating", isMobile);
	await expect(toast(page)).toHaveAttribute("data-state", "failed", {
		timeout: 90_000,
	});
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
	expectConsoleError(/ERR_CONNECTION_REFUSED/);
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
	await toast(page).getByRole("button", { name: "Update" }).click();
	await expect.poll(() => asked).toEqual(["confirm"]);
	await expect(toast(page)).toHaveAttribute("data-state", "available");
	expect(existsSync(installed.npmLog)).toBe(false);
	page.on("dialog", (d) => {
		asked.push(d.type());
		void d.accept();
	});
	await toast(page).getByRole("button", { name: "Update" }).click();
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
	expectConsoleError(/ERR_CONNECTION_REFUSED/);
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
	await expect(
		toast(page).getByRole("link", { name: `v${NEWER}` }),
	).toBeVisible();
	await page.evaluate(() => {
		(window as unknown as { beforeUpdate: boolean }).beforeUpdate = true;
	});
	await toast(page).getByRole("button", { name: "Update" }).click();
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
	// A release now, still on rc: the next RC is offered, never latest's.
	await expect(
		toast(page).getByRole("link", { name: "v0.4.0-rc.1" }),
	).toBeVisible();
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
	// The page's requests while crb stops (one may be cut off) and is down.
	expectConsoleError(/ERR_CONNECTION_(REFUSED|RESET)/);
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
	await check.click();
	const result = version.getByTestId("update-result");
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
	await expect(result.getByRole("link", { name: `v${NEWER}` })).toHaveAttribute(
		"href",
		`https://github.com/Gilthans/carbonless/releases/tag/v${NEWER}`,
	);
	// The toast offers it too.
	await expect(toast(page)).toHaveAttribute("data-state", "available");
	await expectNoPageOverflow(page);
	await shot(page, "global-settings-available", isMobile);
	await page.evaluate(() => {
		(window as unknown as { beforeUpdate: boolean }).beforeUpdate = true;
	});
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
