# Thread carry corpora (`pnpm score-carry`)

A corpus is a set of threads, each made on one snapshot of a PR, with where
a reviewer expects it in a later one. `pnpm score-carry` places every entry
with the current tracer, the server's way (`ThreadPlacer` over the target's
snapshot, no stored placements), and scores it, so a tracer change is
measured before it ships (CAR-95).

```
pnpm score-carry <corpus.json> [--repo <dir>] [--out <dir>] [--compare <previous score-carry.json>]
```

It prints right/total (right + unplaced-ok), each verdict's count, and the
same per tag. `--out` writes `score-carry.json` (every entry's verdict and
placement); `--compare` takes an earlier one and lists every entry whose
verdict changed, with both placements. Verdicts:

| Verdict | Meaning |
| --- | --- |
| `right` | placed or changed on the new side with every line of its range expected or also acceptable, and at least one expected (also acceptable, for `"gone"`); a file comment on its file |
| `wrong-line` | placed somewhere else, or a range spread past those lines |
| `unplaced-ok` | expected `gone`, and listed under its file or outside the comparison |
| `unplaced-wrong` | expected on a line, but unplaced |

## Format

```json
{
  "version": 1,
  "repo": "repo.git",
  "base": "main",
  "entries": [
    {
      "id": "t1@ps2",
      "madeAt": { "commit": "ps1", "path": "a.go", "side": "RIGHT", "startLine": 4, "line": 5 },
      "target": { "commit": "ps2" },
      "expected": { "path": "a.go", "lines": [7] },
      "alsoAcceptable": [{ "path": "a.go", "lines": [8] }],
      "tags": ["moved-inside-rewrite"]
    }
  ]
}
```

- `repo`: the repository, relative to the corpus file (`--repo` overrides
  it, relative to the working directory). A bare clone is enough.
- `base`: the base branch's revision. A snapshot's base is the merge base
  of its `commit` and `base`, unless the snapshot gives its own `base`.
- Commits are any revision git resolves there (a sha, a tag, a branch).
- `id`: unique per entry; one thread carried into two patch sets is two
  entries.
- `madeAt`: where the thread was written: its commit, path, and lines
  (`side`, `startSide` default `side`, `startLine` default `line`). No
  `line`: a file comment.
- `expected`: new-side lines in the target, `"gone"` (the code it was about
  no longer exists) or `"file"` (a file comment, on its file).
- `alsoAcceptable`: other lines that count as right, also for `"gone"`.
- `tags`: optional labels to break the score down by.

A malformed corpus is refused before anything runs, each problem named
(exit 2).

`test/fixtures/score-carry/corpus.json` is a synthetic example on a throwaway
repo (`scripts/score-carry.test.ts` builds it). Corpora from real reviews
stay out of this repository.
