import { type ChildProcess, spawn } from "node:child_process";
import { test as base } from "@playwright/test";
import {
	createGitFixture,
	type FixtureCommit,
	type GitFixture,
} from "../test/git-fixture";

export interface CarbonlessServer {
	url: string;
	output: () => string;
}

type StartOptions = { args?: string[] };

/** Starts the built CLI (dist/cli.js) and resolves once it prints its URL. */
async function startCarbonless(
	repoPath: string,
	args: string[],
): Promise<{ child: ChildProcess; server: CarbonlessServer }> {
	const child = spawn(
		process.execPath,
		["dist/cli.js", repoPath, ...args, "--no-open"],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	const server = await new Promise<CarbonlessServer>((resolve, reject) => {
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			const match = output.match(/listening on (http:\/\/\S+)/);
			if (match?.[1]) resolve({ url: match[1], output: () => output });
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("exit", (code) =>
			reject(new Error(`carbonless exited with ${code}:\n${output}`)),
		);
	});
	return { child, server };
}

export const test = base.extend<{
	makeRepo: (commits: FixtureCommit[]) => GitFixture;
	startCarbonless: (
		repoPath: string,
		options?: StartOptions,
	) => Promise<CarbonlessServer>;
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
	makeRepo: async ({}, use) => {
		const repos: GitFixture[] = [];
		await use((commits) => {
			const repo = createGitFixture(commits);
			repos.push(repo);
			return repo;
		});
		for (const repo of repos) repo.cleanup();
	},
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
	startCarbonless: async ({}, use) => {
		const children: ChildProcess[] = [];
		await use(async (repoPath, options = {}) => {
			const { child, server } = await startCarbonless(
				repoPath,
				options.args ?? [],
			);
			children.push(child);
			return server;
		});
		for (const child of children) child.kill();
	},
});

export { expect } from "@playwright/test";
