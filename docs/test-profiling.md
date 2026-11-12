# Test profiling

Every test run traces itself, so slow parts can be found and compared over
time without anyone remembering to profile.

## Where traces live

`~/.cache/carbonless/test-traces/<run>/` (`<run>`: start time, `e2e` or
`unit`, runner pid), kept 7 days (older runs are pruned when a run starts).
Each process writes its own OTLP JSON Lines file (`<service>-<pid>-<id>.jsonl`;
each line an OTLP `ExportTraceServiceRequest`, like the collector's file
exporter); at the end of a run, files of finished processes are packed into
`packed-<id>.jsonl.gz`. Tests run crb with tracing on; `CRB_TEST_TRACES=0`
turns it off, running crb as it ships.

| service | what | spans |
| --- | --- | --- |
| `e2e` | Playwright reporter (`e2e/trace-reporter.ts`) | one trace per test: the test, hooks, fixtures, `test.step`s, navigations, with `crb.phase` on setup ones |
| `playwright-worker` | e2e worker | fixture gits (`crb.fixture`) |
| `crb`, `crb-client` | `crb serve` under test; `crb <pr>` only in tests that run the CLI (`crbClient: "cli"`; the others open over HTTP, `e2e/crb-open.ts`) | the process, HTTP requests, git and gh calls, opening a review (clone, fetch, snapshot), overview reads |
| `fake-gh` | `test/fake-gh/gh` (its server, `serve.mjs`, in the test process) | one per call, from the server taking it to its answer (`process.pid`: the shim's), under crb's `gh` span |
| `vitest` | unit worker (`test/setup.ts`) | one trace per file: the file, its tests, and crb's git and gh calls and fixture gits under the test |

The ids of an e2e test's span derive from the run and test id
(`testSpanContext`), so the worker passes them to crb as `TRACEPARENT`
before the reporter writes the span.

## CI

CI traces its unit run (`checks`) and its e2e run into
`$CRB_TEST_TRACE_ROOT` and always uploads it, kept 14 days: artifacts
`test-traces-unit` and `test-traces-e2e`. The e2e run is four Playwright
shards (`e2e-shard`, each uploading `test-traces-e2e-<n>`); the `e2e` job
merges their files into one run, `test-traces-e2e` (its wall time is
about the slowest shard's: the latest end minus the earliest start across
all shards). To read one:

```sh
gh run download <run-id> -R Gilthans/carbonless -n test-traces-e2e -D /tmp/ci-traces
pnpm test-profile /tmp/ci-traces            # or --compare it with a local run
```

A path names a run directory or a directory of runs (its newest).

## crb outside tests

`CRB_TRACE_DIR=<dir> crb serve` traces a real server the same way (no
OpenTelemetry SDK: `src/server/trace.ts` writes the files). Unset, tracing
is off and costs a property check per git or gh call.

## Reading them

- `pnpm test-profile [run|latest|e2e|unit]` (the newest match with traces,
  this tree's first): wall and test time, setup phases
  (exclusive time; `body` is the rest of the test, `file` a unit file's time
  outside its tests), top files and tests, gh/git calls, crb's hot spots.
- `pnpm test-profile <run> --compare <older run>`: the deltas (either may be a path).
- `pnpm test-profile <run> --jaeger`: starts (or reuses) the `crb-jaeger`
  docker container (`jaegertracing/all-in-one`, UI on the Tailscale IP port
  16686, OTLP on loopback 4318), loads the run and prints the link.
  `docker rm -f crb-jaeger` drops it; its storage is in memory.

Phases of an e2e test: `setup.fixture` (the fixture repo), `setup.crb_serve`
(`crb serve` until it prints its URL), `setup.crb_open` (opening the review:
the harness's `POST /api/reviews`, or `crb <pr>` in a test with
`crbClient: "cli"`),
`setup.browser` (browser, context, page fixtures), `setup.first_load` (the
first navigation), `setup.other` (other before-hooks), `body`,
`teardown.crb_stop`, `teardown.other`.

Cold start (CAR-102): before the workers start, `e2e/global-setup.ts`
warms up once, alone: a `crb serve`, a `crb <pr>` on a fixture PR and a
browser launch (skipped with one worker). Its span, `e2e: warm-up`
(`crb.kind` `warmup`, the crb processes under it), runs before any test,
so no test's time includes it. `pnpm test-profile` prints it under
"cold start", with the first wave (the tests that started before any test
ended: every worker's first) against the rest, as median test time and
median `crb serve: listening` ("–": nothing to measure). The first wave is
approximate: a worker that boots after the fastest first test ends counts
its cold first test in "rest".

Global setup also points `NODE_COMPILE_CACHE` at one temp directory per
run (removed at its end), so every crb of the run shares one compile
cache, which the warm-up fills. Without it each test's own
`XDG_CACHE_HOME` would leave crb's default cache
(`$XDG_CACHE_HOME/carbonless/compile-cache`) empty at every start;
`e2e/fixtures.spec.ts` checks both paths.

## Unit file order

Vitest starts the slowest unit files first, so none starts last and runs
alone at the end (`scripts/test-profile/sequencer.mjs`): failed last time
first, then the longest duration from Vitest's cache
(`node_modules/.vite/vitest`), else from the checked-in list
`scripts/test-profile/unit-durations.json`, then unlisted files largest
first. A fresh tree and CI have no cache, so the list is what orders them.
Refresh it after a full unit run (`pnpm test`) when files were added or
their times moved: `pnpm test-profile --write-durations` (the newest unit
run, or name one) merges that run's file times into it, keeps files it
didn't run and drops deleted ones, and prints the biggest changes; commit
the result. It refuses a run that looks filtered or partial (under 90% of
the listed files, or many times below a third of the listed ones: a `-t`
or flake-check run); `--force` writes it anyway. Keys use forward slashes
on every OS.
