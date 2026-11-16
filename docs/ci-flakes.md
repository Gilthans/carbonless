# CI flakes

The target: CI green on at least 98% of runs when the code has no bug. A
failed run with no bug in the code is a flake. This is how CI tells them
apart and how the rate is tracked.

## A verdict for every failure

Each test job in `ci.yml` (`checks`, `windows-agent`, each `e2e (n/4)`
shard) ends with "Label failures flaky or consistent"
(`scripts/test-outcomes.mjs`). When the tests step failed, it reruns only
the failed tests once, at the same commit (Vitest: the failed files;
Playwright: each failed test's `file:line` in its projects, unsharded, on
the shard's build), and labels each failure:

| verdict | meaning |
| --- | --- |
| flaky | failed, then passed on rerun |
| consistent | failed again: a bug, or a flake that fails twice |
| not-rerun | the rerun never ran it, or didn't finish; over 10 failures there is no rerun (a real bug: no 20-minute rerun) |

**The job stays failed either way.** The rerun is diagnosis, not a retry:
the tests step already failed the job, and the labelling step's own result
is ignored (`continue-on-error`). No test is retried into a pass
(CLAUDE.md, "No automatic retries").

The job's verdict, worst first: `consistent`; `non-test` (a step other than
the tests failed: install, lint, typecheck, build, the pack smoke test, a
global setup, a tests step that failed with no failed test, such as a
hang); `not-rerun`; `flaky` (every failure passed on rerun); `passed`.

Where to see it:

- The run's **summary** page: a table per job of the failed tests, their
  verdicts and error heads.
- Artifact `test-outcomes-<job>-<attempt>` (kept 90 days): `test-outcomes.json`
  with the run id, attempt, job, sha, branch, event, the job's verdict and
  each failed test's file, title, project (`chromium`/`phone`, or none for
  Vitest), verdict, error and rerun error.

The tests step writes its JSON report to `$CRB_TEST_JSON`, which
`vitest.config.ts` and `playwright.config.ts` add as a reporter when set.

## The flake rate

```sh
pnpm ci-flakes                      # last 7 days
pnpm ci-flakes --since 30d --branch master
pnpm ci-flakes --json               # everything, for scripts
```

It lists `ci.yml`'s runs in the window with every attempt (the runs API
shows only a run's last attempt; a rerun that turned green would hide the
failure), and for each failed attempt reads its jobs and outcome artifacts.
A failed attempt is:

- **flaky** when each failed test job's failures all passed on rerun, or a
  later attempt of the same run passed (same commit);
- **consistent** when a test failed again;
- **non-test** when something other than a test failed;
- **unknown** when a failed job left no outcome (runs from before this, a
  lost runner, a rerun not done).

Flake rate = flaky attempts ÷ completed attempts (cancelled and running
ones aside), and the same for pushes to master alone. Consistent,
non-test and unknown failures are counted apart. Then the top flaky tests:
how often, last seen, the job, a link to the last run. The `e2e` job only
sums up the shards, so its failure is never counted on its own.

## Tracking

The `Flake report` workflow (`.github/workflows/flake-report.yml`) runs
every Monday morning (UTC) and on demand: the 30- and 7-day reports in its
summary, and it fails when the 7-day rate is over 2%. It runs no tests and
is the only workflow job with a token (read-only Actions).
