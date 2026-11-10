import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGhEnv, type Scenario, writeScenario } from "./fake-gh/scenario";
import { settleGh } from "./settle-gh";

export interface HomeFixture {
	/** The scenario file ($CRB_FAKE_GH), for bumpHomePr. */
	path: string;
	/** Rewrites the scenario: the current one with these overrides. */
	scenario: (over: Partial<Scenario>) => void;
	current: () => Scenario;
	/** Every gh call so far, one per line. */
	ghLog: () => string;
	cleanup: () => Promise<void>;
}

/**
 * The fake gh serving Home's queries from `s` (test/fake-gh/scenario.ts,
 * `repos`): PATH, CRB_FAKE_GH and XDG_CACHE_HOME point at throwaway
 * locations until cleanup.
 */
export function createHomeFixture(s: Partial<Scenario> = {}): HomeFixture {
	const tmp = mkdtempSync(join(tmpdir(), "crb-home-"));
	const saved: Record<string, string | undefined> = {};
	const setEnv = (vars: Record<string, string>) => {
		for (const [k, v] of Object.entries(vars)) {
			if (!(k in saved)) saved[k] = process.env[k];
			process.env[k] = v;
		}
	};
	let current: Scenario = {
		repoPath: join(tmp, "no-repo"),
		user: { login: "Octo", avatarUrl: "https://avatars.example/Octo" },
		prs: {},
		...s,
	};
	const path = writeScenario(tmp, current);
	setEnv({
		...fakeGhEnv(),
		CRB_FAKE_GH: path,
		CRB_FAKE_GH_LOG: join(tmp, "gh.log"),
		XDG_CACHE_HOME: join(tmp, "cache"),
	});
	return {
		path,
		scenario: (over) => {
			current = {
				...(JSON.parse(readFileSync(path, "utf8")) as Scenario),
				...over,
			};
			writeScenario(tmp, current);
		},
		current: () => JSON.parse(readFileSync(path, "utf8")) as Scenario,
		ghLog: () => {
			const log = join(tmp, "gh.log");
			return existsSync(log) ? readFileSync(log, "utf8") : "";
		},
		cleanup: async () => {
			try {
				await settleGh(path);
			} finally {
				for (const [k, v] of Object.entries(saved)) {
					if (v === undefined) delete process.env[k];
					else process.env[k] = v;
				}
				rmSync(tmp, { recursive: true, force: true });
			}
		},
	};
}
