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
| `crb`, `crb-client` | `crb serve`, `crb <pr>` under test | the process, HTTP requests, git and gh calls, opening a review (clone, fetch, snapshot), overview reads |
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
merges their files into one run, `test-traces-e2e` (its wall time is the
slowest shard's). To read one:

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
(`crb serve` until it prints its URL), `setup.crb_open` (`crb <pr>`),
`setup.browser` (browser, context, page fixtures), `setup.first_load` (the
first navigation), `setup.other` (other before-hooks), `body`,
`teardown.crb_stop`, `teardown.other`.
