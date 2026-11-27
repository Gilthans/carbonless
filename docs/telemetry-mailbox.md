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
  [test-profiling.md](test-profiling.md), "crb outside tests") of the last
  7 days, up to 300 MB in all (beyond that the oldest are left out). The
  file being written is sent up to its last whole line.
- `logs/`: `serve.log`, `serve.log.1`, `serve-own.log`, `serve-own.log.1`
  and the updater's `update.log`, each its last 5 MB (up to 10 MB while it
  grows: the tail is cut anew only past twice that, so a growing log is read
  incrementally too), as text (bytes that aren't UTF-8, e.g. a Windows
  console code page, become U+FFFD). `serve.log` has crb serve's output only
  when crb started it (`crb <pr>`, the updater); started by hand, by systemd
  or a Windows service, its output goes elsewhere (a terminal, the journal,
  which crb never reads). So while the mailbox is on, crb serve also writes
  its own stderr lines to `serve-own.log` in the state dir (rolled to `.1`
  past 1 MB), however it was started; not when its stderr already is
  `serve.log`, so no line is sent twice (and `serve.log` keeps what only it
  catches, like a crash's last words).
- `state.json`: crb's version and commit, OS and arch, node and git
  versions, the server's pid and uptime, the config, the trace directory's
  size, and for each clone in crb's cache: owner/repo, size on disk, refs
  under `refs/crb/` and reviews, last fetch, `git count-objects -v`.
- `state-history.jsonl`: a short line per push (version, uptime, trace and
  clone sizes), the last 7 days.

Repo names, paths and hosts stay (it's your private repo). What
authenticates never leaves: the access key (also scrubbed from logs and
traces), anything named like a key, token, secret, password, credential,
auth, cookie or session, an agent's `env` values, a command-line option's
value named so (`--api-key=…`, `--token …`), URLs' userinfo, and GitHub
tokens or API keys wherever they appear. The key is scrubbed as its current
value and as any `?key=…`: a log line with a key rotated away since
(`crb serve --new-key`) is caught by the latter only. In trace files, an
option and its value recorded as separate items of a JSON array
(`"--token","abc"`) aren't recognised; crb's own spans record git and gh
argv as one summarised string, where `--token abc` is.

## How it's stored

Each push is **one parentless commit**, a full snapshot, force-pushed with
a lease over the device's last one: the branch never grows a history, and
its size is the window's (≤ 300 MB of traces, a few MB of logs and state;
JSON Lines pack about tenfold). A trace file stays in every snapshot as
the same blob until it is 7 days old, so a file is sent once; the state's
history rides inside the snapshot (`state-history.jsonl`). Git sends only
what changed (the remote's last snapshot is the thin pack's base).

What one push **adds** is capped (50 MB), measured against what the remote
already has (recorded only after a push lands, `pushed.json`): pushes that
failed for a while (an expired login) never pile up into one big push. On a
backlog (the first push of a busy device, the branch deleted or taken over)
the newest trace files go first, a file over the room left goes in part
(whole lines), and the rest follow on the next pushes; a newer file is
never skipped for an older one. `crb telemetry status` says how many wait.

Copies are incremental: a trace file only grows, so each push reads and
scrubs just the lines added since the last one (in 4 MB chunks, letting
crb serve's requests through between them).

crb writes only `device/<device>`, never another branch or a tag. When
that branch moved since its last push (a reinstall, or two machines with
one device name), it takes the branch over, still with a lease on what it
saw, and says so: in `crb telemetry status`, and once in `serve.log`.
A push that landed but wasn't recorded (crb stopped right after it) is
recognised as this device's own and isn't reported as a takeover.
`state.json` names the machine (`machine.hostname`, `machine.stateDir`),
so the reader can tell two apart. Give each machine its own `--device`.

Locally: `<state dir>/telemetry/` (`mailbox.git`, the `outbox/` work tree,
`status.json`), separate from the review clones; no `refs/crb/` involved.
The user's global git settings don't change what's stored: no global
ignores (a `*.log` rule), attributes, hooks, autocrlf or signing apply.

crb serve looks once a minute whether a push is due (the config is read
each time: `on`/`off` apply without a restart) and pushes once `every`
minutes (default 15) have passed since the last attempt, failed or not:
a failing remote (auth, network) is tried again an interval later, logged
in `serve.log` once per change of outcome, and never stops serving. One
push at a time across crb serve and `crb telemetry send` (a lock file);
stopping crb serve stops a push under way.

**Nothing prompts in the background.** crb serve's pushes run with no
terminal prompt, no askpass program (`GIT_ASKPASS`, `core.askPass`,
`SSH_ASKPASS`), no Git Credential Manager UI (`GCM_INTERACTIVE=never`,
`credential.interactive=false`) and ssh in batch mode (`-o
BatchMode=yes`, appended to your `GIT_SSH_COMMAND` or `core.sshCommand`
when it is OpenSSH's; another client, or a `$GIT_SSH` program, is left as
is). Credentials that need a login fail the push, and `status` says so.
`crb telemetry on` and `send`, run in a terminal, may prompt there (their
push runs in the terminal's session; a credential helper's own window works
too): that's your own action, and how a first login happens. The remote URL reaches git
through the environment, never argv (so not into traces or process lists).

**Tracing follows**: with the mailbox on and `$CRB_TRACE_DIR` unset, crb
serve traces into `<state dir>/traces` (the same rotation and retention).
That's decided when crb serve starts: turning the mailbox on while it runs
pushes logs and state at once, and traces from its next restart.

## Setting up a device

1. Create a private repo (GitHub or any git host), e.g. `crb-mailbox`. Don't
   put a token in its URL (`https://user:token@…`): it would sit in
   `config.json` (it's scrubbed from what's sent, not from there).
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
