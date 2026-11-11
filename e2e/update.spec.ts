import type { ChildProcess } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { delimiter, join, resolve } from "node:path";
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
	const bin = join(workdir, "fake-npm-bin");
	mkdirSync(bin);
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
const spec = args[2] ?? "";
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
	env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
	env.CRB_NPM_REGISTRY = registry;
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
		// One the helper started (after an update, or a failed one).
		const pid = serverPid(workdir);
		if (pid !== null) {
			try {
				process.kill(pid, "SIGTERM");
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
	await toast(page).getByRole("button", { name: "Dismiss" }).click();
	await expect(toast(page)).toHaveCount(0);
	await page.goto(reviewPage(review, "files"));
	await page.goto(`${url}/`);
	// Home asked again (its toast would be there by now): still dismissed.
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("crb:update-dismissed")),
		)
		.toBe(NEWER);
	await expect(toast(page)).toHaveCount(0);
	expect(existsSync(installed.npmLog)).toBe(false);
});

it("Update installs exactly that version with npm, restarts crb on its port, and the page reloads on the new version", async ({
	page,
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
		JSON.stringify(["install", "-g", `carbonless-review@${NEWER}`]),
	]);
	await expect(page.getByTestId("toast-stack")).toBeAttached();
	await expect(toast(page)).toHaveCount(0);
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

it("unsaved work: Update asks first, and the reload doesn't ask again", async ({
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
	// The page reloads (the message is gone with it) without a second ask.
	await expect(card.getByRole("textbox", { name: "Message" })).toHaveCount(0, {
		timeout: 20_000,
	});
	expect(asked).toEqual(["confirm", "confirm"]);
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
		JSON.stringify(["install", "-g", `carbonless-review@${NEWER}`]),
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
