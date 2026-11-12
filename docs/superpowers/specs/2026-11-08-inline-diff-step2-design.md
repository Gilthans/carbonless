# Highlighting what changed inside a line, step 2: pairing by similarity

Status: approved by the owner (2026-11-12): "It sounds great. Let's move to implementation".
Mockups (desktop and phone, today's rows next to step 2's) were shared
with the owner in chat.

## Why

Step 1 (`2026-11-01-inline-diff-design.md`, merged as PR #13 on
2026-11-05) marks exactly what GitHub marks: only clusters with as many added
lines as removed ones, i-th line with i-th. Every other cluster is plain, and
side by side pairs its rows by position. The owner: "github line matching
is no good", and on step 2: "if we do that, let's [change] the line
positions as well."

The owner's cases where position pairing fails (2026-11-04 to 11-08): an
item added to a list, a comment added above a changed line, a line removed
from the middle of a change, and two from real work: a helper added above
a function whose doc comment was renamed (GitHub puts the old comment
beside the helper's comment: "looks really bad in the regular +
side-by-side view, even before considering the fact that it doesn't
highlight the fact that just the function name in the comment has
changed"), and Clear/Touch (below).

This is where carbonless starts to diverge from GitHub. The owner
(2026-11-08): "need to find cases where our diff still look bad so we can
fix them. Especially we need to make sure our changes don't break cases
that github normally handles well." And on scope: "Let's try to give
maximal value with minimal changes."

## Goals

- In a cluster with a different number of removed and added lines, pair
  lines that are clearly similar, mark each pair with step 1's word marks,
  and move the rows so a pair is read together, in both views.
- Never make a cluster GitHub handles well look worse.
- No noticeable cost on open.

## Non-goals (each a later step)

- **A different line diff.** carbonless keeps `--diff-algorithm=myers`
  (`src/server/diff/files.ts`). Histogram fixes Clear/Touch; the owner
  (2026-11-08): "Kept to a separate step."
- **Swapped or moved lines.** Pairs never cross; moved code is its own
  milestone ("a different beast", 2026-11-04).
- **One line drawing on two** (the owner's extract-method example, where one
  new line takes a variable from one old line and a constructor call from
  another). Each line has at most one partner here.
- **Equal clusters.** They keep step 1's i-th-with-i-th pairing, even when a
  similarity pairing would differ.
- Any change to what the server sends, to clusters, counts, keys or review
  state.

## Anti-goals

- **Hiding or reordering away a line.** Rows move only by where blank cells
  and removed lines sit; every line is still shown exactly once on its side,
  and each side keeps its own order (principle 2).
- **A pairing that looks confident and is wrong.** When in doubt, a line
  stays unpaired and plain. The owner on how much a wrong pair hurts: "I
  can pretty easily ignore the differences if I think they're incorrect.
  Though of course we should avoid it."
- **Slower opens** beyond the budget below.

## What carbonless does

### Which clusters

A cluster is carbonless's review unit (one git hunk at zero context): a
run of removed lines directly followed by a run of added lines. Step 1's
spec and code call it a block (`hunkPairs` in
`src/web/files/wordBlocks.ts`); the owner (2026-11-12): "Cluster is the
right terminology here, it's the same abstraction". Under Ignore
whitespace, a whitespace-only (`~`) row ends the stretch that pairs, as in
step 1. Step 2 acts only on clusters with at least one line on each side and
different counts. Equal clusters and one-sided clusters are unchanged.

### Pairing

Every removed line is compared with every added line of its cluster. A pair
is allowed only when the two lines are clearly similar (threshold below).
Among allowed pairs, choose the set that:

1. never crosses: if removed line a pairs with added line b, no removed
   line above a pairs with an added line below b;
2. gives each line at most one partner;
3. maximizes total similarity.

Ties go to the layout closest to today's (position pairing), so a cluster
that position already pairs well looks the same as before, plus marks
(case 1).

(Corrected 2026-11-12 during implementation.) The unit that pairs is a
stretch, not quite a cluster: a run of removed lines directly followed by a
run of added lines in the hunk's rows in git's order, ended by a context
line or a `~` row (`hunkPairs`). A stretch is usually one cluster, but may
span two adjacent cluster runs with no context between them; a pair across
them gets its marks and moves no row (each run keeps its own rows). Two
known edges, left as they are: an equal stretch spanning two runs pairs by
position, and unified then moves the pair inside one run together, though
that run alone is an unequal cluster (not seen to occur); and with Ignore
whitespace on, a stretch whose rows `pairRun` interleaves (a removed line
after an added one) keeps its order in unified while side by side still
puts its pairs on one row, so the two views can differ there. Either way,
every line still shows exactly once on its side, in order.

If no pair is allowed, the cluster looks exactly as it does today: side by
side keeps its position rows, with no marks (case 4).

**Similarity (left to the builder, with these constraints):** computed from
the same tokens step 1 marks (`tokenize` in `wordDiff.ts`), so "similar"
means what the marks will show; indentation and other whitespace don't
count toward similarity (a re-indented line still pairs; its whitespace is
still marked). The threshold is one named constant, set from the fixtures
and the real-PR comparison (below), strict enough that case 4 and
Clear/Touch's cluster 2 under Myers (an old `cacheFileGz :=` line against
`return c.baseDir.Join(…).Touch(ctx)`) are judged on purpose, with the
choice written in the report. (Corrected 2026-11-12 during
implementation: the constant is `PAIR_MIN_SIMILARITY = 0.5` in
`linePairing.ts`, provisional until the owner's pass over the real-PR
comparison.)

**Size guard:** a cluster whose removed × added count is above a cap keeps
today's layout and no marks. The builder sets the cap from the budget.
(Corrected 2026-11-12 during implementation: three guards per cluster and
one per hunk, all in `linePairing.ts`.) A cluster keeps today's layout and
no marks when its removed × added count is above `ALIGN_CAP` (2,500), its
lines' characters above `ALIGN_CHARS` (120,000), or its estimated word
steps (Σ ⌈old tokens / 32⌉ × Σ new tokens, the bit-parallel LCS's cost)
above `ALIGN_WORD_OPS` (3,000,000). A hunk's unequal clusters share
`HUNK_ALIGN_WORD_OPS` (4 × `ALIGN_WORD_OPS`) between them: once one
doesn't fit what is left, it and every later unequal cluster of the hunk
keep today's layout. A cluster over its own guards spends nothing. (Find
in unified pairs every hunk with a removed-line hit on its first search,
so the hunk's total, not just a cluster's, must stay bounded.)

### Gaps between pairs

The pairs cut a cluster into gaps: the unpaired lines before the first pair,
between two pairs, and after the last. A gap is laid out exactly as today
lays out a cluster, as if it were a cluster of its own: side by side, its
removed and added lines share rows by position, the surplus one-sided, no
marks; unified, its removed lines then its added lines. So in unified a
cluster never grows taller than today's; side by side, a pair off the
diagonal costs up to one extra row per gap: the cluster takes Σ over its
gaps of max(removed, added), plus one row per pair. (Corrected 2026-11-12
during implementation: this said no cluster grows taller, in either view.)
A gap with lines on one side only (cases 2, 3 and 5) gives those lines
their own rows with a blank cell opposite. (This spec's call.)

### Side by side

A paired line shares a row with its partner. Gaps as above. With no pairs,
the whole cluster is one gap: today's rows.

### Unified (owner, 2026-11-08: option B)

A removed line moves down to sit directly above the added line it pairs
with. The cluster is shown in order as gaps and runs of pairs, each removed
lines first, then added lines, like GitHub:

- a gap: its removed lines, then its added lines (−dX +aY);
- consecutive pairs with no gap between them form one group
  (−a −b +a′ +b′), like an equal cluster today.

So `d1 dX d2` / `a1 aY a2` with pairs d1–a1 and d2–a2 shows
−d1 +a1 −dX +aY −d2 +a2.

(The grouping is this spec's call; case 3 on the mockups.) Line numbers
don't change; only the order of rows inside the cluster does.

### Threads

Threads stay on their line's row wherever that row goes
(`threadPlacement.ts`). Multi-line thread ranges and line picks keep
today's behaviour over moved rows, as they already do over the rows Ignore
whitespace reorders (`pairRun` in `whitespace.ts`): a range may paint
non-adjacent rows, and a drag picks lines in GitHub's order. (This spec's
call; no new work in `threadPlacement.ts` or `linePicks.ts`.)

### Marks

Each pair gets `wordMarks(old, new)`, unchanged from step 1, including the
1,024-character cut and everything about hidden characters.

## Performance

Budget (call, like step 1's): pairing and marking the worst case DiffBody
meets within the size guard stays under 100 ms of CPU time
(`process.threadCpuUsage`, a unit test). Step 1's 2,000-pair equal-cluster
budget still holds unchanged. (Corrected 2026-11-12 during implementation:
speed is tested as CPU ratios against a reference measured in the same
test, never as absolute milliseconds, CAR-67, `test/cpu.ts`; step 1's
budget is a ratio too. The worst cluster inside the guards, and a hunk of
40 of them (in `hunkPairs` and in Find with Ignore whitespace off), are
measured against plain word steps that share no code with the LCS.) First-open time of a file full of unequal
clusters is measured before and after and reported, not gated. Work happens
lazily per hunk in the browser like step 1's. If it ever moves off the main
thread, a pending cluster shows the spinner, never plain lines that read as
"no pairs" (the loading rule).

## Cases (fixtures and gallery)

1. **List item added:** `'beta'` → `'beta',` + `'gamma'`. Rows as today;
   the comma marked.
2. **Comment above a change:** `const timeout = 30;` → comment +
   `const timeout = 60;`. The old line moves down beside its new version.
3. **Line removed from the middle:** `retry(getUser, 3)`, `log(…)`,
   `retry(getOrders, 3)` → the two retries with 5. `log` gets its own row.
4. **Nothing similar:** `sendEmail(user);` → `queue.push(job);`,
   `metrics.inc('jobs');`. Unchanged from today.
5. **Helper above a renamed function** (the owner's Go code; the owner
   approved it verbatim for the gallery, 2026-11-08): a 1/8 cluster whose old
   doc comment pairs with the 8th added line; only the names marked.
6. **Clear/Touch** (the owner's Go code, approved for the gallery verbatim
   2026-11-09; a Myers mess:
   clusters 1/15, 3/5, 3/1): must look no worse than today. Its real fix is
   the histogram step.
7. **Extract method** (made-up code of the owner's example's shape, never
   the original): new line 1 pairs with old line 1; old lines 5–8 unpaired.

Plus regression cases where today's position rows are already right (case
1's shape at several sizes) and whitespace-only rows inside a cluster.

One gallery PR holds all seven (`base/similarity-pairing`,
`case/similarity-pairing`, a description of what to look at, a README row).

## Tests

- **Unit, properties (pairing):** pairs never cross, one partner each,
  every pair at or above the threshold; equal clusters give exactly step 1's
  pairs; no allowed pair gives today's rows. Property-tested over random
  clusters.
- **Unit, properties (layout):** side by side: every line of the hunk in
  the layout exactly once per side, in order, on its own side (extend the
  existing `sideBySide.test.ts` property); unified: every line exactly
  once, removed lines in old order and added in new order, rows never leave
  their cluster.
- **Unit, cases:** the seven cases above, expected pairs and rows.
- **Unit, the step 1 GitHub fixture:** unequal clusters now get marks where
  they pair. That grows the known-differences list, which step 1's spec
  says only shrinks except by an owner decision: this spec is that
  decision (2026-11-08, "This is the point where we start diverging from
  github"); each new entry names step 2 as its reason. Equal-cluster entries
  must not change.
- **Unit, budget:** the CPU-time test above.
- **e2e** (desktop and phone, both views): cases 2, 3 and 5 from a
  throwaway repo; check which lines share a row, the unified order, and the
  marked text; a thread on a moved line stays with it.
- **Real-PR comparison (before merge, not CI; part of the owner's QA):** a script runs the pairing
  over a corpus of public PRs (like step 1's 178) and writes one page of
  every unequal cluster where step 2's layout differs from today's, GitHub's
  next to ours, worst-first (barely-passing pairs, far moves, big clusters).
  The owner marks each fine or bad; bad ones become gallery cases and tests
  or a threshold change; the corpus data stays out of the repo. Step 1's
  178-PR corpus wasn't kept: building a new one (public PRs fetched
  read-only, diffed with carbonless's own diff args) is a task of the plan.
  The PR asks the owner to merge only after their pass over this page.

## Decided by the owner

- **Pair by similarity and move the rows** (2026-11-01): "let's [change]
  the line positions as well."
- **The five rules** (2026-11-08, on the mockups: pairs never cross; pair
  only when clearly similar; nothing pairs = today's rows; equal clusters keep
  step 1; unified gains marks): "All 5 are the desired result."
- **Unified B** (2026-11-08), replacing "unified keeps git's order": "B is
  much preferrable."
- **Histogram is a separate step; keep step 2 minimal** (2026-11-08).
- **The helper/renamed-comment case goes in the gallery verbatim**
  (2026-11-08): "I want to have this example handy." Clear/Touch too
  (2026-11-09): "It can go in the gallery". The unit fixtures read the
  gallery's case files, as step 1's do.

## Calls made here (the owner may overrule)

- Unified B's grouping at unpaired lines (case 3).
- At most one partner per line (extract-method is later).
- A cluster over the size cap keeps today's layout.
- Ties go to today's layout.
- Whitespace doesn't count toward similarity.
- A gap between pairs is laid out like today's cluster (position rows, no
  marks), so no cluster grows taller in unified. (Corrected 2026-11-12
  during implementation: side by side, a pair off the diagonal may add up
  to one row per gap.)
- Thread ranges and line picks over moved rows behave as they do over
  Ignore whitespace's reordered rows.
- The real-PR comparison is part of the owner's QA before merge.

## Appendix: cases 5 and 6 verbatim (approved for the gallery)

### Case 5

Old:

```go
// IsCacheSkippedForDomain reports whether planning requests for domain must bypass the cache entirely, per the
// skip_cache_domains list of the ff_gpo_planning_cache feature flag.
func IsCacheSkippedForDomain(domain string) bool {
    return domainInList(GetFeatureFlags().Value.SkipCacheDomains, domain)
}
```

New:

```go
// flagsOr lets a handler's own flags replace the process-wide ones, so tests can run in parallel.
func flagsOr(flags *PlanningCacheFeatureFlags) PlanningCacheFeatureFlags {
    if flags != nil {
        return *flags
    }
    return GetFeatureFlags()
}
// SkipsCacheFor reports whether planning requests for domain must bypass the cache entirely, per the
// skip_cache_domains list of the ff_gpo_planning_cache feature flag.
func (ff PlanningCacheFeatureFlags) SkipsCacheFor(domain string) bool {
    return domainInList(ff.Value.SkipCacheDomains, domain)
}
```

### Case 6

Old (lines 12 and 13 end in 8 spaces):

```go
func (c *PlanningCache[CacheKey]) Clear(ctx context.Context, key CacheKey, ext string) error {
    name, err := key.FileName()
    if err != nil {
        return err
    }
    cacheFileGz := c.baseDir.Join(fmt.Sprintf("%s.%s.gz", name, ext))
    err = cacheFileGz.RemoveFile(ctx)
    if err != nil && !errors.Is(err, cloudpath.ErrFileDoesNotExist) {
        return err
    }
    // TODO: Remove this logic after the version has been deployed - XMLs are only relevant for 1 day
    cacheFile := c.baseDir.Join(fmt.Sprintf("%s.%s", name, ext))        
    err = cacheFile.RemoveFile(ctx)        
    if err != nil && !errors.Is(err, cloudpath.ErrFileDoesNotExist) {
        return err
    }
    return nil
}
```

New:

```go
func (c *PlanningCache[CacheKey]) GetFingerprint(ctx context.Context, key CacheKey) (string, error) {
    value, err := c.Get(ctx, key, FingerprintExt)
    if err != nil {
        return "", err
    }
    return string(value), nil
}
// SetFingerprint with "" removes the stored one, so a report without a fingerprint is never revalidated.
func (c *PlanningCache[CacheKey]) SetFingerprint(ctx context.Context, key CacheKey, fingerprint string) error {
    if fingerprint == "" {
        return c.Clear(ctx, key, FingerprintExt)
    }
    return c.Put(ctx, key, FingerprintExt, []byte(fingerprint))
}
func (c *PlanningCache[CacheKey]) Touch(ctx context.Context, key CacheKey, ext string) error {
    name, err := key.FileName()
    if err != nil {
        return err
    }
    return c.baseDir.Join(fmt.Sprintf("%s.%s.gz", name, ext)).Touch(ctx)
}
func (c *PlanningCache[CacheKey]) Clear(ctx context.Context, key CacheKey, ext string) error {
    name, err := key.FileName()
    if err != nil {
        return err
    }
    err = c.baseDir.Join(fmt.Sprintf("%s.%s.gz", name, ext)).RemoveFile(ctx)
    if err != nil && !errors.Is(err, cloudpath.ErrFileDoesNotExist) {
        return err
    }
    return nil
}
```
