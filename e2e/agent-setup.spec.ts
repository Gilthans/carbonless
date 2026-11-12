import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { releaseAcp } from "../test/fake-acp/scenario";
import { ask, CALC, chip, expect, fixture, openFile, test } from "./agent-ui";
import { reviewPage } from "./fixtures";

// Its own crb serve: the setup writes the agent config.
test.use({ crbServer: "own" });

/**
 * Setting up the reviewer's agent through the modal, against the fake ACP
 * agent on PATH (named like Claude Code's adapter, `claude-agent-acp`).
 */

const shots = process.env.DESIGN_SHOTS;
async function shot(page: Page, name: string, isMobile: boolean) {
	if (!shots) return;
	await page.screenshot({
		path: `${shots}/${name}-${isMobile ? "phone" : "desktop"}.png`,
	});
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Your agent" });

test("ask with no agent: it waits; set one up from the thread, and the backlog is answered", async ({
	page,
	pr,
	agentCrb,
	acpScenario,
	workdir,
	isMobile,
}) => {
	// Files, Overview and Files again, a Check, a Save and the agent's first
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
	const setUp = card.getByRole("button", { name: "Set up an agent" });
	await expect(setUp).toBeVisible();
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
	const d = dialog(page);
	await expect(d.getByRole("radio", { name: "Claude Code" })).toBeChecked();
	await expect(d.getByRole("textbox", { name: "Command" })).toHaveValue(
		"claude-agent-acp",
	);
	await expect(d.getByRole("textbox", { name: "Install" })).toHaveValue(
		"npm i -g @agentclientprotocol/claude-agent-acp",
	);
	const save = d.getByRole("button", { name: "Save" });
	await expect(save).toBeDisabled();
	await shot(page, "agent-setup", isMobile);
	// Check runs the command once; held in its handshake, it spins.
	await d.getByRole("button", { name: "Check" }).click();
	await expect(d.getByRole("status", { name: "Checking" })).toBeVisible();
	await expect(d.getByTestId("agent-check-ok")).toHaveCount(0);
	releaseAcp(acpScenario, "initialize");
	await expect(d.getByTestId("agent-check-ok")).toHaveText("Fake Agent 9.9.9");
	await expect(save).toBeEnabled();
	await save.click();
	await expect(d).toBeHidden();
	const config = JSON.parse(
		readFileSync(join(workdir, "config", "carbonless", "config.json"), "utf8"),
	);
	expect(config.agent).toEqual({
		command: "claude-agent-acp",
		args: [],
		env: {},
		leash: "open",
	});
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
	const thread = again.getByTestId("agent-thread");
	await expect(thread).toHaveAttribute("aria-label", "Agent thread, answered");
	await expect(thread.getByTestId("agent-message-ai")).toHaveText(
		"Answered from the backlog",
	);
});

test("Check says why an agent can't start, with its stderr; Save stays off", async ({
	page,
	pr,
	agentCrb,
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
	await page.goto(s.url);
	await chip(page).click();
	const d = dialog(page);
	await d.getByRole("button", { name: "Check" }).click();
	await expect(d.getByTestId("agent-check-error")).toBeVisible();
	await expect(d.locator("pre")).toContainText(
		"Not logged in. Run claude /login",
	);
	await expect(d.getByRole("button", { name: "Save" })).toBeDisabled();
	await shot(page, "agent-setup-error", isMobile);
	// Cancel: nothing written, the chip still off.
	await d.getByRole("button", { name: "Cancel" }).click();
	await expect(d).toBeHidden();
	await expect(chip(page)).toHaveAttribute("data-state", "off");
});

test("the modal shows what is set up; Remove turns the agent off; Escape closes", async ({
	page,
	pr,
	agentCrb,
	workdir,
}) => {
	await pr(fixture);
	const s = await agentCrb();
	await page.goto(s.url);
	await expect(chip(page)).toHaveAttribute("data-state", "ready");
	await chip(page).click();
	const d = dialog(page);
	await expect(d.getByRole("radio", { name: "Claude Code" })).toBeChecked();
	await page.keyboard.press("Escape");
	await expect(d).toBeHidden();
	await expect(chip(page)).toBeFocused();
	await chip(page).click();
	await d.getByRole("button", { name: "Remove" }).click();
	await expect(d).toBeHidden();
	await expect(chip(page)).toHaveAttribute("data-state", "off");
	const config = JSON.parse(
		readFileSync(join(workdir, "config", "carbonless", "config.json"), "utf8"),
	);
	expect(config.agent).toBeNull();
	await chip(page).click();
	await expect(d.getByRole("button", { name: "Remove" })).toHaveCount(0);
});
