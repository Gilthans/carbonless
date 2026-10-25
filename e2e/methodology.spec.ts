import { writeScenario } from "../test/fake-gh/scenario";
import {
	createMethodologyRepo,
	METHODOLOGIES,
	type Stage,
} from "../test/methodology-fixture";
import { fileSection, openFiles } from "./files-ui";
import { CrbExitError, expect, OWNER_REPO, PR_NUMBER, test } from "./fixtures";

/**
 * The git-methodology matrix end to end (docs/git-methodology.md): the
 * updated PR shows only its own files whatever the history shape, and once
 * landed crb refuses it exactly when GitHub says merged.
 */
for (const m of METHODOLOGIES) {
	test(`git methodology ${m.name}: only the PR's own files; merged per GitHub`, async ({
		page,
		startCrb,
		workdir,
	}) => {
		const repo = createMethodologyRepo(m, PR_NUMBER);
		try {
			const stage = (s: Stage) => {
				repo.setStage(s);
				writeScenario(workdir, {
					repoPath: repo.path,
					user: { login: "Octo_Cat" },
					nameWithOwner: OWNER_REPO,
					prs: { [PR_NUMBER]: repo.prEntry(s) },
				});
			};
			const expectPrFiles = async (url: string) => {
				await openFiles(page, url);
				for (const path of repo.prPaths) {
					await expect(fileSection(page, path)).toBeVisible();
				}
				for (const path of ["base-x.txt", "base-y.txt"]) {
					await expect(fileSection(page, path)).toHaveCount(0);
				}
			};

			stage("updated");
			const crb = await startCrb();
			await expectPrFiles(crb.url);
			await crb.stop();

			stage("landed");
			if (m.landing === "open") {
				await expectPrFiles((await startCrb()).url);
			} else {
				const exit = await startCrb().then(
					() => null,
					(e: unknown) => e,
				);
				expect(exit).toBeInstanceOf(CrbExitError);
				expect((exit as CrbExitError).output).toContain(
					`PR ${OWNER_REPO}#${PR_NUMBER} is already merged; nothing to review`,
				);
			}
		} finally {
			repo.cleanup();
		}
	});
}
