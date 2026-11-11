import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
	type AcpScenario,
	FAKE_ACP_BIN,
	writeAcpScenario,
} from "../test/fake-acp/scenario";
import { fileSection, openFiles } from "./files-ui";
import {
	test as base,
	CrbExitError,
	expect,
	OWNER_REPO,
	PR_NUMBER,
	type PrOptions,
	runCli,
	type Served,
	startServe,
	stopChild,
} from "./fixtures";
import { crbEnv } from "./pr-setup";

/**
 * The reviewer's agent in e2e: a crb serve with the fake ACP agent
 * (test/fake-acp) first on PATH, its scenario and log in the test's
 * workdir, and (unless `configured: false`) a config.json naming it.
 */

/** A .ts file whose lines are highlighted (selectText waits for a token). */
export const CALC = "src/calc.ts";
const base_ = Array.from(
	{ length: 12 },
	(_, i) => `export const v${i + 1} = ${i + 1};`,
);
export const fixture: PrOptions = {
	base: { [CALC]: `${base_.join("\n")}\n` },
	files: [
		{
			message: "calc",
			files: {
				[CALC]: `${base_
					.map((l, i) => (i === 2 ? "export const total = v1 + v2;" : l))
					.join("\n")}\n`,
			},
		},
	],
};

export interface AgentCrb {
	/** The review's URL (`crb <pr>`'s). */
	url: string;
	served: Served;
	/** Stops this serve (pages first go blank, so nothing polls it). */
	stop: () => Promise<void>;
}

export interface AgentOptions {
	scenario?: AcpScenario;
	/** Write config.json naming the fake agent (default true). */
	configured?: boolean;
	/** Another state dir: a second server on the same cache and config. */
	state?: string;
	/** crb <pr>'s own flags (--viewer, --as-of). */
	args?: string[];
	/** Extra environment for the serve (e.g. test-only CRB_JOIN_GRACE_GATE). */
	env?: NodeJS.ProcessEnv;
}

export const DEFAULT_SCENARIO: AcpScenario = {
	agent: { name: "Fake Agent", version: "9.9.9" },
	answers: [{ text: "ok" }],
};

export const test = base.extend<{
	/** Starts a crb serve with the fake agent and opens the PR on it. */
	agentCrb: (opts?: AgentOptions) => Promise<AgentCrb>;
	/** The fake agent's scenario file (written by the first agentCrb). */
	acpScenario: string;
	/** The fake agent's log. */
	acpLogPath: string;
}>({
	acpScenario: async ({ workdir }, use) => {
		await use(join(workdir, "fake-acp-scenario.json"));
	},
	acpLogPath: async ({ workdir }, use) => {
		await use(join(workdir, "fake-acp.log"));
	},
	agentCrb: async ({ workdir, context, acpLogPath }, use) => {
		const servers: Served[] = [];
		await use(async (opts = {}) => {
			const scenario = writeAcpScenario(
				workdir,
				opts.scenario ?? DEFAULT_SCENARIO,
			);
			if (opts.configured !== false) {
				const dir = join(workdir, "config", "carbonless");
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "config.json"),
					JSON.stringify({
						agent: {
							command: "claude-agent-acp",
							args: [],
							env: {},
							leash: "open",
						},
					}),
				);
			}
			const env: NodeJS.ProcessEnv = {
				...crbEnv(workdir),
				...(opts.state ? { XDG_STATE_HOME: join(workdir, opts.state) } : {}),
				...opts.env,
			};
			env.PATH = `${FAKE_ACP_BIN}:${env.PATH ?? ""}`;
			env.CRB_FAKE_ACP = scenario;
			env.CRB_FAKE_ACP_LOG = acpLogPath;
			const served = await startServe(workdir, [], env);
			servers.push(served);
			const run = await runCli(
				workdir,
				[`${OWNER_REPO}#${PR_NUMBER}`, ...(opts.args ?? [])],
				env,
			);
			const url = run.stdout.trim().split("\n").at(-1) ?? "";
			if (run.code !== 0 || !/^http:\/\//.test(url)) {
				throw new CrbExitError(run.code, `${served.output()}${run.output}`);
			}
			return {
				url,
				served,
				stop: async () => {
					await Promise.all(
						context.pages().map((p) => p.goto("about:blank").catch(() => {})),
					);
					await stopChild(served.child);
				},
			};
		});
		await Promise.all(
			context.pages().map((p) => p.goto("about:blank").catch(() => {})),
		);
		await Promise.all(servers.map((s) => stopChild(s.child)));
	},
});

export { expect };

/** Opens Files changed and expands `path`. */
export async function openFile(page: Page, url: string, path: string) {
	await openFiles(page, url);
	const section = fileSection(page, path);
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.getByTestId("diff-line").first()).toBeVisible();
	return section;
}

/** A row by its new number. */
export const row = (section: Locator, n: number) =>
	section.locator(`tr[data-testid="diff-line"][data-new-no="${n}"]`);

export const bar = (page: Page) => page.getByTestId("selection-bar");

/**
 * Selects characters `from`..`to` of new line `n` the way a drag would
 * (new-threads.spec.ts's), once the line's highlighting is in.
 */
export async function selectText(
	page: Page,
	path: string,
	n: number,
	from: number,
	to: number,
) {
	const cell = `[data-path="${path}"] tr[data-new-no="${n}"] > [data-code-cell][data-side="RIGHT"] [data-code]`;
	await page.locator(`${cell} span[style]`).first().waitFor();
	await page.evaluate(
		({ cell, from, to }) => {
			const code = document.querySelector(cell);
			if (!code) throw new Error("no line");
			const at = (col: number): [Node, number] => {
				const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
				let left = col;
				for (let t = walker.nextNode(); t; t = walker.nextNode()) {
					const len = (t as Text).data.length;
					if (left <= len) return [t, left];
					left -= len;
				}
				throw new Error("past the line");
			};
			(document.activeElement as HTMLElement | null)?.blur();
			const pointerType = navigator.maxTouchPoints > 0 ? "touch" : "mouse";
			document.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, pointerType }),
			);
			const range = document.createRange();
			range.setStart(...at(from));
			range.setEnd(...at(to));
			const selection = document.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			document.dispatchEvent(
				new PointerEvent("pointerup", { bubbles: true, pointerType }),
			);
		},
		{ cell, from, to },
	);
}

/**
 * Asks the agent `text` about new line `n`: the line picked by its number
 * (no wait for the highlighting), or characters `span` of it selected.
 */
export async function ask(
	page: Page,
	section: Locator,
	n: number,
	text: string,
	span?: [number, number],
) {
	if (span) {
		await selectText(page, CALC, n, span[0], span[1]);
	} else {
		const number = row(section, n).getByTestId("new");
		// A phone picks by a tap, as a reviewer's finger would.
		if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
			await number.tap();
		} else await number.click();
		await expect(row(section, n)).toHaveAttribute("data-picked", "true");
	}
	await bar(page).getByRole("button", { name: "Ask agent" }).click();
	const composer = section.getByTestId("agent-composer");
	const box = composer.getByRole("textbox", { name: "Ask your agent" });
	await expect(box).toBeFocused();
	await box.fill(text);
	await composer.getByTestId("agent-composer-ask").click();
	await expect(composer).toHaveCount(0);
	return section.getByTestId("agent-thread").filter({ hasText: text });
}

/** The header's agent chip. */
export const chip = (page: Page) => page.getByTestId("agent-chip");
