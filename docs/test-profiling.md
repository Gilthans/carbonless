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

A server runs for weeks, so its tracing is meant to stay on (the service
unit in [remote-machine.md](remote-machine.md) sets it):

- Spans reach the file about 2 s after they end (an unref'd timer, besides
  every 256 spans and at exit), so a crash loses seconds and the files can
  be read while it runs (real timers: a test's fake clock never holds
  them). A directory deleted while it runs is made again; any other write
  that fails is reported once on stderr and tracing stops; crb goes on.
- Its file rolls at a size limit and at the UTC day change:
  `crb-<pid>-<random>.<yyyymmdd>.<seq, 6 digits>.jsonl`.
- At start and on each roll it deletes its own files (`crb-<pid>-…`, old
  unrotated names too) older than the days kept, then the oldest while
  they pass the total cap, never one written in the last 5 minutes (another
  live crb serve's, during an update's restart). Nothing else in the
  directory is touched.
- Defaults, overridable in the environment: `CRB_TRACE_FILE_MB` (32 per
  file), `CRB_TRACE_KEEP_DAYS` (14), `CRB_TRACE_MAX_MB` (1024 in all),
  raised to at least 1 MiB, 1 day and one file's size.

`pnpm test-profile <the trace dir> [--since 1d] [--top N]` reads it as a
server (a directory with crb serve's files and no `run.json`): the span
count and time window, the slowest routes by p95 (n, total, p50, p95,
max, failures: 5xx or aborted), gh and git calls, and gh/git by command
(most time first). `--since` takes `30m`, `6h`, `1d`, `2w` or a date
(default `7d`, said in the header); files last written before it aren't
read. A test run refuses `--since`. `--jaeger` loads the same
window into Jaeger (service `crb`). A server's directory is never packed.

Every file says which build wrote it: each line's resource has
`service.version` (package.json's version) and `service.commit` (the full
SHA, `-dirty` kept), as `crb --version` and `server.json` have them
(`src/server/version.ts`). Run from source (tests, `pnpm dev`) that is
package.json's version and the checkout's HEAD. The server summary lists
the builds in the window ("unknown": files from before builds were
recorded); `--only <build>` keeps one, and `--compare-version <a> <b>`
puts two side by side: n, p50 and p95 per route, per gh/git kind and per
command, the biggest p95 change weighed by calls first. A build is named
exactly: as listed (`0.5.0-rc.3 (93fe843)`), by its version (`0.5.0` is
the release, never its RCs) or by its commit's start (4+ hex); a name
that fits more than one build is refused, listing them. A row missing on
one side shows `–`, not a 0. `--only` goes with neither
`--compare-version` nor `--jaeger`, and test runs refuse all three.
The tracer reads the build only when tracing is on.

### Loading steps (CAR-296)

What a slow load says beside its spinner (`docs/product-rules.md`, "A
slow wait says what it waits on") is the span name of the step the
request is on, through a fixed map (`stepLabel`, `src/shared/activity.ts`),
so what the reviewer sees is what `pnpm test-profile` shows. Steps are
kept whether tracing is on or not (`src/server/activity.ts`).

| Span | Shown |
| --- | --- |
| `gh <cmd>` (`gh pr view`) | `GitHub: <cmd>` (`GitHub: pr view`) |
| `gh api <path>` | `GitHub: api <path>`, any segment but crb's API words as `…` |
| `git <cmd>` | `git <cmd>` |
| `crb: clone` | `Cloning <owner/repo>…` (the first clone; the page and `crb <pr>` keep CAR-291's wording) |
| `crb: fetch pr` | `Fetching the PR` |
| `crb: snapshot` | `Reading the diff` |
| `crb: split carries` | `Carrying review marks` |
| `crb: fetch commits` | `Fetching dropped commits` |
| `crb: home list` | `GitHub: PR list, page <n>` |
| `crb: home details` | `GitHub: PR details <n> of <m>` |
| `crb: since` | `Computing the since view` |
| `crb: repo lock` (a wait, no span) | `Waiting for the repo lock` (held by another crb) |
| `crb: working` (a wait, no span) | `Working…` (shared work showing no step) |

A named phase (`crb: …`) hides the gh and git calls under it; the
innermost step shown is the newest phase or wait, else the newest call.
The `crb: …` phases are spans too while tracing, the calls under them
nested. Since CAR-296, `crb: clone` spans only a first clone (it used to
wrap every open's `ensureClone`, its lock and checks included: an open
of a cloned repo now has no `crb: clone` span), and `crb: fetch pr` is
fetchPr's own, under the repo lock, so a head check's fetch has one too.
Compare runs from before that change by `git fetch` rather than by
these spans.

### Browser spans (CAR-288)

While `crb serve` traces, the pages it serves record what the reviewer
waits for and send it to the same trace files (`$CRB_TRACE_BROWSER=0`
turns just the page's spans off; the unit and e2e harnesses do, so test
traces have none but `e2e/browser-trace.spec.ts`'s). The server says so
with a `<meta name="crb-trace">` in its page (a page is then never served
as "not modified", and `no-cache`, so it stays in the back-forward
cache); without it the page installs nothing (one `querySelector`): no
observer, no wrapped `fetch`, no listener, no request. The install is
synchronous: the first render never waits on it. `pnpm dev`'s Vite page
has no meta, so no page spans. Tracing never breaks the page: its
callbacks run guarded, and an error in them turns it off for the page's
life. In the trace files the page's spans are their own service,
`crb-browser` (the same build attributes as `crb`'s).

One trace per page load (`src/web/trace/`), the size of its loads:

| span | what it is |
| --- | --- |
| `browser.navigation` | the trace's root: the document's load, 0 to `loadEventEnd`; `type`, `ttfb_ms`, `dom_interactive_ms`, `dcl_ms`, `load_ms`, `transfer_bytes`, `viewport_w`, `route` |
| `browser.page` | a page shown (the first from the document's start, each later route from its move) to its last milestone (`complete: true`); left first, `complete: false` at the move; failed (a threads or Home repo read), `complete: false` with an error; given up after 5 minutes, `abandoned: true`, ending at its last milestone reached. `route` (`home`, `overview`, `files`, `verdict`, `settings`, `opening`), `review` (its id), `spa` (a move in the app: its shell, the header, was already up), `restored` (back from the back-forward cache), `hidden`, `cls` |
| `browser.ui.*` | a milestone, from the page's start to when it is on screen: `header`; overview `threads` (the list, skeleton gone; an error when the read failed) and `threads_code` (no thread's code pending); files `first_file` (the first file with nothing busy, where the page ends) and `diff_rows` (the first diff line on screen); Home `home_rows`, `home_done`, and per view repo `repo_rows`, `repo_done` (`repo.index`: its place in the view, never its name) |
| `browser.fetch` | an API request, from `fetch` to its headers; `api` (a template: `/api/r/:id/threads`), `stage`, `status`, `body_ms` (to its body read), `painted_ms` (to the frame after) |
| `browser.longtask`, `browser.layout_shift` | while a page loads: a long task (`duration_ms`); a layout shift of 0.05 or more (`value`; every shift counts in its page's `cls`) |
| `browser.lcp` | 0 to the largest contentful paint, once the first page is complete or the page goes away |
| `browser.dropped` | written by the server: `count` spans of the page it turned away (its budget), so the gap shows |

Filter before aggregating: `hidden: true` (the page was in a background
tab at some point: no frames, so its times include the wait to be shown),
`user: true` (a milestone the reviewer's pace sets: `diff_rows`, as files
open collapsed unless the address lands on one), `late: true` (it came
after its page's span ended), `spa: true` (a move, not a document load).
Only `complete: true` pages are load times.

Milestones are read off the page (`src/web/trace/milestones.ts`: test ids,
`aria-busy`, the thread list's `data-trace`/`data-state`, Home's
`data-repo`), so they hold however a page loads; the DOM is watched only
while one is pending. Each `browser.fetch` sends a `traceparent`: the
server's `GET /api/r/:id/...` span, with its git and gh, is its child, so
a slow milestone reads down to the request and the command behind it.
Once a page's span has ended its reads (polls, refetches) aren't traced,
and a write (the reviewer's action) is a small trace of its own
(`after_page: true`): a tab left open adds nothing while it only polls.
So a Files page's expand loads its diff with no span (and no server
request span under one); only its `diff_rows` milestone says when.

Spans go out when a page is complete and every 5 s (plain POSTs), and by
`sendBeacon` (else a keepalive POST) in batches of 50 when the tab hides
(it may be closed with no other event; the page stays open) and when the
page goes away, a best effort: a beacon sent while the document is
replaced may be lost. `POST /api/trace` (`src/server/browserTrace.ts`,
itself not traced) keeps only known names, checked ids, times within a
day of now, 16 short attributes a span, 200 spans a batch, 1,500 spans a
minute per page load and 3,000 in all (then 429; the page counts what was
turned away in its next batch, written as `browser.dropped`). The page's
clock is moved onto the server's by its smallest offset seen (a batch's
`sentAt`, and each traced request's arrival against its span's start:
latency only adds), when that is over 30 ms; the smallest holds a minute,
so a clock that steps (a device that slept) is placed again.

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
`teardown.crb_reset` (a shared server's reset and leak checks, below),
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

## One server for many tests (CAR-106)

A Playwright worker's tests share one `crb serve` (`e2e/shared-server.ts`),
started by its first test (that test's `setup.crb_serve`). Each test gets
a repo and PR number of its own (`acme/widget-<worker>-<seq>#<100+seq>`:
the `ownerRepo` and `prNumber` fixtures, `p.ownerRepo`/`p.number`; never
hard-code `acme/widget#7`). After it, `teardown.crb_reset`: pages go blank,
the server is reset (below), its clones deleted, and these checks run. Any
that fires fails the test, and the server is replaced:

- `the reset left these running: …`: an open, gh or git call outlived the
  test (often a `hold` never released, or an open GitHub still holds);
- `the fake gh still runs N call(s)`: the same, seen from the fake gh;
- `sessions open after the reset`: the reset missed one;
- `stray gh call: …`, one per call: a gh call for a finished test's repo
  (a late read of an earlier test), named in the line. A stray that lands
  between tests, or after a worker's last, fails the run at the worker's
  teardown instead of an innocent test: it shows as a worker-teardown
  error, possibly minutes after its cause, tagged with the test that began
  next;
- `crb serve's config dir changed`: the test writes config;
- `the shared crb serve died`: its last output follows;
- `could not delete the clones`: something still writes in them.

`e2e/fixtures.spec.ts` has canaries for a held open, a stray, a config
write, a server's death, and an undeclared leak failing its test
(`expectCrbLeak` declares the leak a canary expects; only that spec may
use it).

**`test.use({ crbServer: "own" })`** gives a test its own `crb serve`, as
before; serve flags (`--host`, `--port`, `--new-key`) always do. Use it
when a test stops or restarts crb (`stop()` on a shared server throws),
writes config (Home views, agent setup), reads the server's files under
`workdir` (its cache, `server.json`, `serve.log`), runs the CLI with
`runCli(workdir, …)` against the server, or uses fixed names across tests
(Home's `acme/api`). Home, home-api, methodology and the agent specs are
own throughout.

The server's own span (`e2e: shared crb serve`) is a trace of its own, so
every test's requests nest under that test (its `traceparent`: the HTTP
open's and the page's). The test hooks write the server's buffered spans
at each reset. Per test, a `crb shared state` span records the server's
RSS and open sessions; a server whose RSS grows 256 MiB past its first
test's is restarted.

The pieces:

**Fake gh router.** `$CRB_FAKE_GH` may name a router file
(`test/fake-gh/route.mjs`, `writeRouter` in `test/fake-gh/scenario.ts`)
instead of a scenario: `{ router: 1, current: { test, scenario, log,
repos }, finished: { "<owner/repo>": "<test title>" }, strays? }`. The
fake gh finds each call's repo (`-R`/`--repo`, `repo clone <o/r>`,
`repos/<o>/<r>/…` paths, GraphQL `owner`/`name` variables and inline
`repository(owner: "…", name: "…")`):

- a current test's repo (the router's `repos`, its scenario's
  `nameWithOwner`, `repos` and `viewerRepos`), or no repo (`auth status`,
  `api user`, `repo view`, nodes by id, the viewer's queries): the current
  scenario and log;
- a finished test's repo, any other repo, any call with no test running,
  and a form the router doesn't know: a stray. It exits 1, naming the repo
  and its test, and adds a line to the stray log (`strays`, else
  `$CRB_FAKE_GH_LOG`). Nothing answers it from another test's scenario.

The fake gh server asks the shim to log a call with `log <path>`, so each
test's gh log stays its own. Gates, `failNext` and writes act on the
test's own scenario file. `src/server/fake-gh-route.test.ts` has a sample
of every form gh.mjs answers, and reads gh.mjs's recognizers to fail when
a new form has none.

**Test hooks.** Off unless `crb serve` starts with `$CRB_TEST_HOOKS` set
to a 32-hex token; without it the routes don't exist (404). Each request
needs the header `x-crb-test-hook: <token>` (else 403), and passes the
host and key checks like any other (`src/server/testHooks.ts`):

- `POST /api/_test/reset` closes every session (`SessionRegistry.reset()`:
  no gh or git of theirs runs after, the registry stays open). An open
  under way closes the session it lands with, and opens are refused while
  the reset runs. It drops Home's caches and the snapshot caches, and waits
  up to 5 s in all for opens, closes, gh calls and processes, and git
  processes to end. It answers `{ closed, ghInFlight, ghChildren,
  gitChildren, leftovers }`; `leftovers` names what still ran (an open
  GitHub holds: `open <pr> (pending)`).
- `GET /api/_test/state`: open sessions, Home's cached repos, RSS, and the
  gh and git running.

**Traces.** `crb <pr>` sends its `$TRACEPARENT` as a `traceparent` header.
A request whose `traceparent` is of another trace than the server's own
goes under that span, so on a shared server each test's requests nest
under that test, not under the test that started the server. A request in
the server's own trace stays under `crb serve`, as before.

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

## Mutation testing (CAR-263)

`pnpm mutation` runs Stryker (`stryker.config.mjs`) on the code that
decides what is reviewed and unreviewed (CLAUDE.md principle 2): the
coverage join and fold, the carry engine, clusters, pieces and the
page's counts. It plants small bugs (a flipped condition, an off-by-one)
and reports each one no unit test catches, in `reports/mutation/`
(`mutation.html`, `mutation.json`; git-ignored). It takes the queue's
full slot (`scripts/queue.mjs`), one Stryker runner per worker the slot
gets, each running Vitest with one worker; `testFiles` keeps it to the
unit tests of those files. Measured on the devbox, loaded, 5 runners: about
5,300 mutants in 4 h 10 min. Too slow for CI or every PR: run it by hand
after changing that logic, and read the survivors of the files you
touched. A survivor that could make coverage look more complete is a
missing test; one that can't (an equivalent mutant, a message, an order
of display) needs none.
