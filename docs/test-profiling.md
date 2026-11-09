# Test profiling

Every test run traces itself, so slow parts can be found and compared over
time without anyone remembering to profile.

## Where traces live

`~/.cache/carbonless/test-traces/<run>/` (`<run>`: start time, `e2e` or
`unit`, runner pid), kept 7 days (older runs are pruned when a run starts).
Each process writes its own OTLP JSON Lines file (`<service>-<pid>-<id>.jsonl`;
each line an OTLP `ExportTraceServiceRequest`, like the collector's file
exporter); at the end of a run, files of finished processes are packed into
`packed-<id>.jsonl.gz`. `CRB_TEST_TRACES=0` turns it off.

| service | what | spans |
| --- | --- | --- |
| `e2e` | Playwright reporter (`e2e/trace-reporter.ts`) | one trace per test: the test, hooks, fixtures, `test.step`s, navigations, with `crb.phase` on setup ones |
| `playwright-worker` | e2e worker | fixture gits (`crb.fixture`) |
| `crb`, `crb-client` | `crb serve`, `crb <pr>` under test | the process, HTTP requests, git and gh calls, opening a review (clone, fetch, snapshot), overview reads |
| `fake-gh` | `test/fake-gh/gh` | one per call, process start to exit, under crb's `gh` span |
| `vitest` | unit worker (`test/setup.ts`) | one trace per file: the file, its tests, and crb's git and gh calls and fixture gits under the test |

The ids of an e2e test's span derive from the run and test id
(`testSpanContext`), so the worker passes them to crb as `TRACEPARENT`
before the reporter writes the span.

## crb outside tests

`CRB_TRACE_DIR=<dir> crb serve` traces a real server the same way (no
OpenTelemetry SDK: `src/server/trace.ts` writes the files). Unset, tracing
is off and costs a property check per git or gh call.

## Reading them

- `pnpm test-profile [run|latest|e2e|unit]`: wall and test time, setup phases
  (exclusive time; `body` is the rest of the test, `file` a unit file's time
  outside its tests), top files and tests, gh/git calls, crb's hot spots.
- `pnpm test-profile <run> --compare <older run>`: the deltas.
- `pnpm test-profile <run> --jaeger`: starts (or reuses) the `crb-jaeger`
  docker container (`jaegertracing/all-in-one`, UI on the Tailscale IP port
  16686, OTLP on loopback 4318), loads the run and prints the link.
  `docker rm -f crb-jaeger` drops it; its storage is in memory.

Phases of an e2e test: `setup.fixture` (the fixture repo), `setup.crb_serve`
(`crb serve` until it prints its URL), `setup.crb_open` (`crb <pr>`),
`setup.browser` (browser, context, page fixtures), `setup.first_load` (the
first navigation), `setup.other` (other before-hooks), `body`,
`teardown.crb_stop`, `teardown.other`.
