import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { acpLog, releaseAcp } from "../test/fake-acp/scenario";
import { testGitEnv } from "../test/git-fixture";
import {
	ask,
	CALC,
	chip,
	expect,
	fixture,
	openFile,
	setupDialog,
	statusDialog,
	test,
} from "./agent-ui";
import { expectNoPageOverflow } from "./files-ui";
import { reviewPage } from "./fixtures";
import type { Pr } from "./pr-setup";

// Its own crb serve: the setup writes the agent config.
test.use({ crbServer: "own" });

/**
 * The agent modal (CAR-141): Setup Review Agent (Invite, Spawn) while no
 * agent is connected, Review Agent once one is, against the fake ACP agent
 * on PATH (named like Claude Code's adapter, `claude-agent-acp`). A
 * configured agent never starts by itself: only Spawn starts one, in its
 * own review.
 */

const shots = process.env.DESIGN_SHOTS;
async function shot(page: Page, name: string, isMobile: boolean) {
	if (!shots) return;
	await page.screenshot({
		path: `${shots}/${name}-${isMobile ? "phone" : "desktop"}.png`,
	});
}

const configPath = (workdir: string) =>
	join(workdir, "config", "carbonless", "config.json");

/** The fake agent's processes so far (each logs `spawn` first). */
const spawns = (log: string) =>
	acpLog(log).filter((e) => e.method === "spawn").length;

/**
 * The footer's Close: a text button, so not the header's icon-only X
 * (named Close too), whatever their order.
 */
const closeButton = (dialog: Locator) =>
	dialog
		.getByRole("button", { name: "Close", exact: true })
		.filter({ hasText: "Close" });

/** The next answer of the review's status poll (GET /api/r/:id/agent). */
const statusPoll = (page: Page) =>
	page.waitForResponse((r) =>
		/\/api\/r\/[^/]+\/agent$/.test(new URL(r.url()).pathname),
	);

test("a new review opens on Setup Review Agent", async ({
	page,
	pr,
	agentCrb,
	acpLogPath,
}) => {
	await pr(fixture);
	// Configured, never spawned: the review has no agent.
	const s = await agentCrb({ spawn: false });
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await expect(chip(page)).toHaveAccessibleName(
		"Your agent: No agent · spawn or invite",
	);
	await chip(page).click();
	const d = setupDialog(page);
	await expect(d).toBeVisible();
	await expect(d.getByRole("tab", { name: "Invite" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(
		d.getByText("Invite a session you already created to join the review."),
	).toBeVisible();
	await expect(d.getByTestId("join-request-none")).toHaveText(
		"No agent requesting to join",
	);
	// One more status poll answered with the modal open: still off, and the
	// fake agent was never started.
	await statusPoll(page);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	expect(spawns(acpLogPath)).toBe(0);
});

test("Spawn shows the Review Agent status, Detach returns to setup", async ({
	page,
	pr,
	agentCrb,
	acpLogPath,
	workdir,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 760 });
	await pr(fixture);
	const s = await agentCrb({ configured: false });
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await chip(page).click();
	const setup = setupDialog(page);
	await expect(setup).toBeVisible();
	await expectNoPageOverflow(page);
	await setup.getByRole("tab", { name: "Spawn" }).click();
	await expect(
		setup.getByText("Spawn a session to serve as your review agent"),
	).toBeVisible();
	await setup.getByRole("radio", { name: "Other" }).check();
	const command = setup.getByRole("textbox", { name: "Command" });
	await expect(command).toHaveValue("");
	await command.fill("claude-agent-acp");
	await expectNoPageOverflow(page);
	await shot(page, "agent-setup-spawn", isMobile);
	await setup.getByTestId("agent-spawn").click();
	// Connected: the status view, its state from the server.
	const status = statusDialog(page);
	await expect(status).toBeVisible();
	await expect(setupDialog(page)).toHaveCount(0);
	const card = status.getByTestId("agent-status-card");
	await expect(card).toContainText("Spawned · ACP");
	await expect(card).toContainText("Fake Agent 9.9.9");
	await expect(status.getByTestId("agent-state")).toHaveText("Ready");
	await expect(card).toContainText("claude-agent-acp");
	await expect(status.getByText("Idle")).toBeVisible();
	await expect(
		status.getByRole("button", { name: "Stop current" }),
	).toBeDisabled();
	await expectNoPageOverflow(page);
	await shot(page, "agent-status", isMobile);
	// Saved as typed.
	expect(JSON.parse(readFileSync(configPath(workdir), "utf8")).agent).toEqual({
		command: "claude-agent-acp",
		args: [],
		env: {},
		leash: "open",
	});
	// Detach: back to setup, the agent off and its process gone.
	await status.getByRole("button", { name: "Detach" }).click();
	await expect(setupDialog(page)).toBeVisible();
	await expect(statusDialog(page)).toHaveCount(0);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await expect(chip(page)).toHaveAccessibleName(
		"Your agent: No agent · spawn or invite",
	);
	// It stays off: another status poll, no new process.
	const started = spawns(acpLogPath);
	await statusPoll(page);
	await expect(setupDialog(page)).toBeVisible();
	expect(spawns(acpLogPath)).toBe(started);
	await expectNoPageOverflow(page);
	// Close gives focus back to the chip.
	await closeButton(setupDialog(page)).click();
	await expect(setupDialog(page)).toBeHidden();
	await expect(chip(page)).toBeFocused();
});

test("a failed Spawn shows the error and saves nothing", async ({
	page,
	pr,
	agentCrb,
	acpLogPath,
	workdir,
	isMobile,
}) => {
	await pr(fixture);
	const s = await agentCrb({
		configured: false,
		scenario: {
			agent: { name: "Fake Agent", version: "9.9.9" },
			initializeError: "Not logged in. Run claude /login",
		},
	});
	const before = existsSync(configPath(workdir))
		? readFileSync(configPath(workdir))
		: null;
	await page.goto(s.url);
	await chip(page).click();
	const d = setupDialog(page);
	await d.getByRole("tab", { name: "Spawn" }).click();
	await expect(d.getByRole("radio", { name: "Claude Code" })).toBeChecked();
	await expect(d.getByRole("textbox", { name: "Command" })).toHaveValue(
		"claude-agent-acp",
	);
	await d.getByTestId("agent-spawn").click();
	await expect(d.getByTestId("agent-check-error")).toBeVisible();
	await expect(d.locator("pre")).toContainText(
		"Not logged in. Run claude /login",
	);
	// Spawn can be pressed again; the view is still Setup.
	await expect(d.getByTestId("agent-spawn")).toHaveText("Spawn");
	await expect(statusDialog(page)).toHaveCount(0);
	await shot(page, "agent-setup-error", isMobile);
	// Nothing written, and no agent started: the check's one run of the
	// command never got past its handshake (no session, no prompt).
	expect(
		acpLog(acpLogPath).filter((e) =>
			["session/new", "session/prompt"].includes(e.method),
		),
	).toHaveLength(0);
	const after = existsSync(configPath(workdir))
		? readFileSync(configPath(workdir))
		: null;
	expect(after).toEqual(before);
	await closeButton(d).click();
	await expect(d).toBeHidden();
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await expect(chip(page)).toHaveAccessibleName(
		"Your agent: No agent · set one up",
	);
});

/** PR 8: the same commits as `p`, another review (serve.spec.ts's). */
function addSecondPr(p: Pr): void {
	const head = p.repo.shas.at(-1) ?? "";
	execFileSync("git", ["update-ref", "refs/pull/8/head", head], {
		cwd: p.repo.path,
		env: testGitEnv(),
	});
	p.editScenario((s) => {
		const first = s.prs[p.number];
		if (!first) throw new Error(`no PR ${p.number}`);
		s.prs[8] = {
			...first,
			view: {
				...first.view,
				number: 8,
				title: "Second PR",
				url: `https://github.com/${p.ownerRepo}/pull/8`,
			},
		};
	});
}

test("a config saved in one review doesn't start the agent in another", async ({
	page,
	pr,
	agentCrb,
	acpLogPath,
	workdir,
}) => {
	const p = await pr(fixture);
	addSecondPr(p);
	const s = await agentCrb({ configured: false });
	// Review A: Spawn through the modal (Claude Code's preset).
	await page.goto(s.url);
	await chip(page).click();
	const setup = setupDialog(page);
	await setup.getByRole("tab", { name: "Spawn" }).click();
	await expect(setup.getByRole("textbox", { name: "Command" })).toHaveValue(
		"claude-agent-acp",
	);
	await setup.getByTestId("agent-spawn").click();
	await expect(statusDialog(page).getByTestId("agent-state")).toHaveText(
		"Ready",
	);
	expect(existsSync(configPath(workdir))).toBe(true);
	const started = spawns(acpLogPath);
	// Review B, on the same server and config: no agent.
	const a = new URL(s.url);
	await page.goto(
		`${a.origin}/pr/${p.ownerRepo}/8${a.search /* the access key, if any */}`,
	);
	await expect(page).toHaveURL(/\/r\/[0-9a-z]{26}/);
	expect(new URL(page.url()).pathname).not.toBe(a.pathname);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Second PR");
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await expect(chip(page)).toHaveAccessibleName(
		"Your agent: No agent · spawn or invite",
	);
	await statusPoll(page);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await chip(page).click();
	await expect(setupDialog(page)).toBeVisible();
	expect(spawns(acpLogPath)).toBe(started);
	// Review A still has its agent.
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
});

test("the tab is remembered across reloads", async ({ page, pr, agentCrb }) => {
	await pr(fixture);
	const s = await agentCrb({ configured: false });
	await page.goto(s.url);
	await chip(page).click();
	const d = setupDialog(page);
	const invite = d.getByRole("tab", { name: "Invite" });
	const spawn = d.getByRole("tab", { name: "Spawn" });
	await expect(invite).toHaveAttribute("aria-selected", "true");
	await spawn.click();
	await expect(spawn).toHaveAttribute("aria-selected", "true");
	await expect(d.getByRole("radiogroup", { name: "Harness" })).toBeVisible();
	expect(
		await page.evaluate(() => localStorage.getItem("crb.agentSetup.tab")),
	).toBe("spawn");
	await page.reload();
	await chip(page).click();
	await expect(spawn).toHaveAttribute("aria-selected", "true");
	await expect(invite).toHaveAttribute("aria-selected", "false");
	// And back: Invite is remembered too.
	await invite.click();
	await page.reload();
	await chip(page).click();
	await expect(invite).toHaveAttribute("aria-selected", "true");
	await expect(d.getByTestId("join-line")).toBeVisible();
});

test("ask with no agent: it waits; set one up from the thread, Spawn, and the backlog is answered", async ({
	page,
	pr,
	agentCrb,
	acpScenario,
	workdir,
	isMobile,
}) => {
	// Files, Overview and Files again, a Spawn's check and the agent's first
	// spawn: past 30 s on a loaded machine.
	test.slow();
	await pr(fixture);
	const s = await agentCrb({
		configured: false,
		scenario: {
			agent: { name: "Fake Agent", version: "9.9.9" },
			answers: [{ text: "Answered from the backlog" }],
			hold: ["initialize"],
		},
	});
	const section = await openFile(page, s.url, CALC);
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	await expect(chip(page)).toHaveAccessibleName(
		"Your agent: No agent · set one up",
	);
	const card = await ask(page, section, 3, "Anyone there?");
	await expect(card).toHaveAttribute("aria-label", "Agent thread, waiting");
	await expect(
		card.getByRole("button", { name: "Set up an agent" }),
	).toBeVisible();
	// The Overview counts it, with the way to set one up.
	await page.goto(reviewPage(s.url, ""));
	const band = page.getByTestId("agent-overview-row");
	await expect(band.getByTestId("agent-overview-counts")).toHaveText(
		"1 open · 1 waiting",
	);
	await expect(
		band.getByRole("button", { name: "Set up an agent" }),
	).toBeVisible();
	const again = await openFile(page, s.url, CALC);
	await again.getByTestId("agent-bubble").click();
	await again
		.getByTestId("agent-thread")
		.getByRole("button", { name: "Set up an agent" })
		.click();
	const d = setupDialog(page);
	await d.getByRole("tab", { name: "Spawn" }).click();
	await expect(d.getByRole("radio", { name: "Claude Code" })).toBeChecked();
	await expect(d.getByRole("textbox", { name: "Command" })).toHaveValue(
		"claude-agent-acp",
	);
	await expect(d.getByRole("textbox", { name: "Install" })).toHaveValue(
		"npm i -g @agentclientprotocol/claude-agent-acp",
	);
	await shot(page, "agent-setup", isMobile);
	// Spawn checks the command first; held in its handshake, it spins, and
	// nothing is saved yet.
	const spawn = d.getByTestId("agent-spawn");
	await spawn.click();
	await expect(spawn).toHaveText("Spawning…");
	await expect(spawn).toHaveAttribute("aria-disabled", "true");
	expect(existsSync(configPath(workdir))).toBe(false);
	releaseAcp(acpScenario, "initialize");
	const status = statusDialog(page);
	await expect(status.getByTestId("agent-status-card")).toContainText(
		"Spawned · ACP",
	);
	expect(JSON.parse(readFileSync(configPath(workdir), "utf8")).agent).toEqual({
		command: "claude-agent-acp",
		args: [],
		env: {},
		leash: "open",
	});
	await closeButton(status).click();
	await expect(status).toBeHidden();
	const thread = again.getByTestId("agent-thread");
	await expect(thread).toHaveAttribute("aria-label", "Agent thread, answered");
	await expect(thread.getByTestId("agent-message-ai")).toHaveText(
		"Answered from the backlog",
	);
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
});

test("ask with a config but nothing spawned: the thread's button opens the modal on setup", async ({
	page,
	pr,
	agentCrb,
	acpLogPath,
}) => {
	await pr(fixture);
	const s = await agentCrb({ spawn: false });
	const section = await openFile(page, s.url, CALC);
	await expect(chip(page)).toHaveAccessibleName(
		"Your agent: No agent · spawn or invite",
	);
	const card = await ask(page, section, 3, "Anyone there?");
	await expect(card).toHaveAttribute("aria-label", "Agent thread, waiting");
	await card.getByRole("button", { name: "Spawn or invite an agent" }).click();
	await expect(setupDialog(page)).toBeVisible();
	expect(spawns(acpLogPath)).toBe(0);
});
