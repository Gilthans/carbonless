# Telemetry mailbox

An optional way to diagnose a crb that runs on another machine (another
tailnet, a Windows box): crb pushes its traces, logs and a snapshot of its
state to a **git repo you own**, and you read them here. Off by default;
there is no default remote and no carbonless server in the middle
(principle 4): the mailbox is an ordinary git repo, and posting to it needs
write access to it, through the device's own git credentials.

## What is sent

Under `devices/<device>/` on the branch `device/<device>`:

- `traces/`: crb serve's trace files (`crb-<pid>-…jsonl`,
  [test-profiling.md](test-profiling.md), "crb outside tests"), newest
  first, up to 50 MB a push (older files left out first; `crb telemetry
  status` says how many). The file being written is cut at its last whole
  line.
- `logs/`: `serve.log`, `serve.log.1` and the updater's `update.log`, each
  its last 5 MB.
- `state.json`: crb's version and commit, OS and arch, node and git
  versions, the server's pid and uptime, the config, the trace directory's
  size, and for each clone in crb's cache: owner/repo, size on disk, refs
  under `refs/crb/` and reviews, last fetch, `git count-objects -v`.
- `state-history.jsonl`: a short line per push (version, uptime, trace and
  clone sizes), the last 7 days.

Repo names, paths and hosts stay (it's your private repo). What
authenticates never leaves: the access key (also scrubbed from logs and
traces), anything named like a key, token, secret, password, credential,
auth, cookie or session, an agent's `env` values, URLs' userinfo, and
GitHub tokens or API keys wherever they appear.

## How it's stored

Each push is **one parentless commit**, a full snapshot, force-pushed with
a lease over the device's last one. A snapshot already holds every trace
file kept, so history would only repeat them: the branch stays one
snapshot (≤ ~50 MB) however long crb runs, and the state's history rides
inside it (`state-history.jsonl`). Git still sends only what changed (the
remote's last snapshot is the thin pack's base: the growing trace file goes
as a delta). crb writes only `device/<device>`, never another branch or a
tag; when that branch moved (a reinstall, two devices with one name) it
takes it over, still with a lease on what it saw.

Locally: `<state dir>/telemetry/` (`mailbox.git`, the `outbox/` work tree,
`status.json`), separate from the review clones; no `refs/crb/` involved.

crb serve looks once a minute whether a push is due (the config is read
each time: `on`/`off` apply without a restart) and pushes once `every`
minutes (default 15) have passed since the last attempt, failed or not:
a failing remote (auth, network) is tried again an interval later, logged
in `serve.log` once per change of outcome, and never stops serving. One
push at a time across crb serve and `crb telemetry send` (a lock file).
crb serve never prompts for credentials (`GIT_TERMINAL_PROMPT=0`); the
remote URL goes to git through the environment, never argv (so not into
traces).

**Tracing follows**: with the mailbox on and `$CRB_TRACE_DIR` unset, crb
serve traces into `<state dir>/traces` (the same rotation and retention).
That's decided when crb serve starts: turning the mailbox on while it runs
pushes logs and state at once, and traces from its next restart.

## Setting up a device

1. Create a private repo (GitHub or any git host), e.g. `crb-mailbox`.
2. On the device, check `git push` to it works without a prompt there
   (Windows: Git Credential Manager; elsewhere `gh auth setup-git`, SSH
   keys…). crb never stores or asks for credentials.
3. `crb telemetry on <repo URL> [--device <name>] [--every <minutes>]`:
   saves it in `config.json` (`telemetry: { mailbox, device, every }`) and
   pushes once, saying whether that worked. The device defaults to the
   machine's name.
4. `crb telemetry status`: on or off, the trace directory, the last push
   (time, ok or why not, files and size). `crb telemetry send` pushes now.

## Reading it here

```sh
pnpm telemetry pull <repo URL> [--device <name>] [--dir <cache dir>]
pnpm test-profile <printed dir>/traces --since 1d
```

`pull` fetches only `device/*` into a cache
(`~/.cache/carbonless/telemetry-mailbox/<id>`, or `--dir`), lays each
device's snapshot out under `devices/<device>/` and prints its trace
directory. The URL comes from the command line or
`$CRB_TELEMETRY_MAILBOX`: never write it in a tracked file (this repo is
public). The files' mtimes are the checkout's, so `--since` keeps them all;
the spans' own times still place them.

## Turning it off and removing the data

`crb telemetry off` stops pushing (crb serve within a minute). What was
pushed stays: `git push <repo URL> --delete device/<device>` removes the
device's branch (the host drops the objects in its own time), and the
local copy is `<state dir>/telemetry/`. The default trace directory
stays, pruned as before; delete it by hand if you like.
