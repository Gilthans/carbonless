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
| not-rerun | the rerun never ran it, or didn't finish; over 10 failures (or 10 files to rerun) there is no rerun (a real bug: no 20-minute rerun) |

Vitest's **unhandled errors** (a rejection or a timer that fires after its
test ended) fail the run with every test passed, and its JSON report leaves
them out. `scripts/vitest-unhandled-reporter.mjs` writes them next to the
report, each with the test file Vitest traced it to (when the timing lets
it). It makes the report's folder itself (Vitest may call it before the
JSON reporter has), and a write it can't make is logged, never thrown: it
is diagnostics, and a throw would fail a green run (CAR-214). Each is labelled like a test (title `(unhandled error)`): its file
reruns. Since the same error may be traced on one run and not the other,
any unhandled error in the rerun counts against every such failure it could
be (consistent), and one passes (flaky) only when the rerun had none that
could be it and ran its file. One Vitest couldn't trace (file
`(unknown file)`) reruns every file the run had, and is flaky only when the
rerun ran all of them with no unhandled error: so only a small run
(windows-agent's) gets a verdict; a full unit run is over the cap and stays
not-rerun.

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
- Artifact `test-outcomes-<job>-<attempt>-<verdict>` (kept 90 days; `<job>`
  is `checks`, `windows-agent` or `e2e-<n>`, `<verdict>` the job's, `none`
  when the step didn't finish): `test-outcomes.json` with the run id,
  attempt, job, sha, branch, event, the job's verdict and each failed
  test's file, title, project (`chromium`/`phone`, or none for Vitest),
  verdict, error and rerun error. The verdict in the name lets
  `pnpm ci-flakes` read most jobs without downloading anything.

The tests step writes its JSON report to `$CRB_TEST_JSON`, which
`vitest.config.ts` and `playwright.config.ts` add as a reporter when set.

## The flake rate

```sh
pnpm ci-flakes                      # last 7 days
pnpm ci-flakes --since 7d,30d       # both, from one collection
pnpm ci-flakes --since 30d --branch master
pnpm ci-flakes --json               # everything, for scripts
```

It lists `ci.yml`'s runs in the window a day at a time (the API answers at
most 1,000 runs per query: a day whose count is over that is halved before
its pages are read, and a listing shorter than its count fails the report), with every attempt (the
runs API shows only a run's last attempt; a rerun that turned green would
hide the failure). For each run with a failed attempt it lists the
artifacts once: their names carry each job's verdict. It downloads only a
flaky job's document (for its tests; a document whose verdict disagrees
with its name counts unknown) and lists the jobs only when they can change
the verdict (not when a later attempt passed, nor when an outcome already
says consistent or non-test). The jobs show a failed job with no outcome,
one that failed after its label step (non-test), and the `e2e` summary job
failing in a step other than "A shard failed" (non-test).

**Runs from forks** (a pull request whose head is another repository) run
the fork's own `ci.yml`, which can upload any outcome: they are counted on
their own line and never read, so they never move the rate or the top
flaky tests.

Any read that fails (a rate limit, a 404, a 5xx after three tries) fails
the report: missing data never counts as "unknown". Only a run with no
outcome artifacts, or expired ones, has none. A document that is malformed
or names another run (artifacts are a run's own data, a fork's PR too) is
warned about and counted unknown. It prints the API calls it used
(stderr). On 2026-11-16 one `--since 7d,30d` took 344 calls in about 4
minutes (443 runs; most failed ones from before the outcomes existed, so
each needed a jobs listing). Once failed attempts have outcomes, it is
about one listing per day of the window, one artifact listing per run
with a failed attempt, one download per flaky job, and the jobs only for
re-run attempts that didn't pass or missing outcomes: well inside the
weekly job's 1,000 an hour at today's pace. If it ever runs out, the
report fails (red), it doesn't undercount.

A failed attempt is:

- **flaky** when each failed test job's failures all passed on rerun, or a
  later attempt of the same run passed (same commit);
- **consistent** when a test failed again;
- **non-test** when something other than a test failed;
- **unknown** when a failed job left no outcome (runs from before this, a
  lost runner), or one without a verdict: not rerun (over the cap, or cut
  short), or a malformed document.

Flake rate = flaky attempts ÷ attempts that passed or failed (cancelled,
skipped, awaiting approval, neutral or stale ones, and running ones, aside),
and the same for pushes to master alone. Consistent,
non-test and unknown failures are counted apart. Then the top flaky tests:
how often, last seen, the job, a link to the last run. The `e2e` job only
sums up the shards: its failure counts on its own only when it failed in
another step than "A shard failed".

## Tracking

The `Flake report` workflow (`.github/workflows/flake-report.yml`) runs
every Monday morning (UTC) and on demand: the 7- and 30-day reports (one
collection) in its summary, and it fails when the 7-day rate is over 2%,
or when the report can't read what it needs. It runs no tests and is the
only workflow job with a token (read-only Actions, 1,000 API calls an
hour).
