# Shared by scripts/devbox/install and scripts/devbox/update (sourced).
#
# Every path is overridable, so tests run these against temp dirs:
#   XDG_CONFIG_HOME     config.json (carbonless/) and, by default, the unit dir
#   XDG_STATE_HOME      the access key and server.json (carbonless/)
#   SYSTEMD_USER_DIR    where crb.service goes (default $XDG_CONFIG_HOME/systemd/user)
#   PNPM_HOME           pnpm's global dir; the global crb is $PNPM_HOME/bin/crb
#   CRB_NODE_BIN        Node 24's bin dir (default: ~/.nvm/versions/node/v24*/bin)
#   CRB_DEVBOX_PKG_DIR  the installed package's dir (default: from pnpm ls -g)
#   CRB_DEVBOX_DRY_RUN=1  print systemctl, journalctl and pnpm add instead of running them
#   CRB_DEVBOX_DRY_MAINPID  under dry run, the service's MainPID (unset: not checked)
#   CRB_DEVBOX_TIMEOUT  seconds to wait for the restarted server (default 60)
#   XDG_DATA_HOME       releases/ (carbonless/), the tarballs follow builds and keeps
#   CRB_DEVBOX_HOME     the copy of these scripts crb-follow.service runs
#                       (default $XDG_DATA_HOME/carbonless/devbox)
#   CRB_DEVBOX_REPO     the repo follow fetches master into (default: this checkout's)
#   CRB_DEVBOX_BUILD_TREE  follow's build worktree (default <repo>/.worktrees/follow)
#   CRB_DEVBOX_UPDATE   the update script follow runs (default: update, here)
#   CRB_DEVBOX_HEALTH_WAIT  seconds follow waits for crb to serve the installed build (30)
#   CRB_DEVBOX_RETRY_DELAYS  seconds before follow retries a failed build ("300 1800 7200")
#   CRB_DEVBOX_LOCK_WAIT  seconds update and install wait for the devbox lock (900)
#   CRB_DEVBOX_LOCKED   set by follow for the update it runs under its lock

UNIT=crb
PACKAGE=carbonless-review
DRY_RUN="${CRB_DEVBOX_DRY_RUN:-}"
DEVBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
# crb-follow.service runs a copy of these scripts, not a checkout's, so it
# never depends on what a checkout has checked out (install_scripts).
SCRIPTS_HOME="${CRB_DEVBOX_HOME:-$DATA_HOME/carbonless/devbox}"
SCRIPT_FILES=(follow update lib.sh crb.service.template crb-follow.service.template crb-follow.timer)

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
UNIT_DIR="${SYSTEMD_USER_DIR:-$CONFIG_HOME/systemd/user}"
UNIT_FILE="$UNIT_DIR/$UNIT.service"
export PNPM_HOME="${PNPM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/pnpm}"

die() {
	echo "error: $*" >&2
	exit 1
}

# Runs a command, or only prints it under CRB_DEVBOX_DRY_RUN.
run() {
	if [[ -n "$DRY_RUN" ]]; then
		echo "dry-run: $*"
	else
		"$@"
	fi
}

# Node 24's bin dir: $CRB_NODE_BIN, else the newest ~/.nvm/versions/node/v24*,
# else the node on PATH if it is 24.
find_node_bin() {
	local dir="${CRB_NODE_BIN:-}"
	if [[ -z "$dir" ]]; then
		dir="$(ls -d "$HOME"/.nvm/versions/node/v24*/bin 2>/dev/null | sort -V | tail -1 || true)"
	fi
	if [[ -z "$dir" ]] && command -v node >/dev/null; then
		dir="$(dirname "$(command -v node)")"
	fi
	[[ -n "$dir" && -x "$dir/node" ]] || die "Node 24 not found: install it (nvm install 24) or set CRB_NODE_BIN"
	local version
	version="$("$dir/node" --version)"
	[[ "$version" == v24.* ]] || die "$dir/node is $version, crb needs Node 24 (or set CRB_NODE_BIN)"
	echo "$dir"
}

NODE_BIN="$(find_node_bin)"
# Node 24 and its pnpm first, then the global bin dir pnpm insists be on PATH.
export PATH="$NODE_BIN:$PNPM_HOME/bin:$PATH"
command -v pnpm >/dev/null || die "pnpm not found next to Node 24 ($NODE_BIN): corepack enable pnpm"

# serve.host and serve.port from config.json (defaults as crb serve's).
serve_address() {
	node -e '
		const fs = require("fs");
		let serve = {};
		try { serve = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).serve ?? {}; } catch {}
		const host = typeof serve.host === "string" && serve.host.trim() ? serve.host.trim() : "127.0.0.1";
		const port = Number.isInteger(serve.port) ? serve.port : 4747;
		if (port === 0) {
			console.error(`error: serve.port is 0 in ${process.argv[1]}: the service needs a fixed port (e.g. 4747)`);
			process.exit(1);
		}
		console.log(`${host} ${port}`);' "$CONFIG_HOME/carbonless/config.json"
}
address="$(serve_address)"
SERVE_HOST="${address% *}"
SERVE_PORT="${address##* }"

# The global crb's path (it may not exist yet).
global_crb() {
	echo "$(pnpm bin -g)/crb"
}

# The installed package's dir, or nothing when it isn't installed.
installed_dir() {
	if [[ -n "${CRB_DEVBOX_PKG_DIR:-}" ]]; then
		echo "$CRB_DEVBOX_PKG_DIR"
		return
	fi
	{ pnpm ls -g --json 2>/dev/null || true; } | node -e '
		let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
			let roots = []; try { roots = JSON.parse(s); } catch {}
			for (const r of roots) {
				const p = r.dependencies?.[process.argv[1]];
				if (p?.path) { console.log(p.path); return; }
			}
		});' "$PACKAGE"
}

# The installed build as "<version> <commit>", or nothing.
installed_build() {
	local dir
	dir="$(installed_dir)"
	[[ -n "$dir" && -f "$dir/dist/build-info.json" ]] || return 0
	node -e 'const b = require(process.argv[1]); console.log(`${b.version} ${b.commit}`)' \
		"$dir/dist/build-info.json"
}

# "<version> <commit>" as crb --version prints it: 0.1.0 (abc1234).
pretty_build() {
	[[ -n "$1" ]] || { echo "nothing"; return; }
	local version="${1%% *}" commit="${1#* }" dirty=""
	[[ "$commit" == *-dirty ]] && dirty="-dirty" && commit="${commit%-dirty}"
	echo "$version (${commit:0:7}$dirty)"
}

# The PATH a unit runs with: Node 24, the global bin dir, then wherever git
# and gh live, then the system dirs.
unit_path() {
	local service_path="$NODE_BIN:$PNPM_HOME/bin" tool dir
	for tool in git gh; do
		command -v "$tool" >/dev/null || die "$tool not found on PATH"
		dir="$(dirname "$(command -v "$tool")")"
		[[ ":$service_path:" == *":$dir:"* ]] || service_path="$service_path:$dir"
	done
	for dir in /usr/local/bin /usr/bin /bin; do
		[[ ":$service_path:" == *":$dir:"* ]] || service_path="$service_path:$dir"
	done
	echo "$service_path"
}

# Writes a unit from its template (in this dir) when it differs, replacing
# each @NAME@ given as NAME=value. The values are escaped for systemd (% is a
# specifier) and for bash's replacement (& is the match). Returns 0 when it
# wrote the file, 1 when the file was already so.
render_unit() {
	local template="$1" file="$2" pair name value unit
	shift 2
	unit="$(<"$DEVBOX_DIR/$template")"
	for pair in "$@"; do
		name="${pair%%=*}"
		value="${pair#*=}"
		value="${value//%/%%}"
		unit="${unit//@"$name"@/"$value"}"
	done
	if [[ -f "$file" && "$(<"$file")" == "$unit" ]]; then
		return 1
	fi
	mkdir -p "$(dirname "$file")"
	printf '%s\n' "$unit" >"$file"
	echo "Wrote $file"
}

# Writes crb.service from the template when it differs (Node 24 and the
# global crb may have moved), and reloads systemd then. Sets UNIT_CHANGED.
write_unit() {
	local path
	path="$(unit_path)"
	UNIT_CHANGED=""
	if render_unit crb.service.template "$UNIT_FILE" "PATH=$path" "CRB=$1"; then
		UNIT_CHANGED=1
		run systemctl --user daemon-reload
	fi
}

# The page's address: http://host:port/, with ?key= unless the host is loopback.
# A wildcard bind (0.0.0.0, ::) is shown under this machine's name.
service_url() {
	local host="$SERVE_HOST" key=""
	case "$host" in
	127.0.0.1 | ::1 | localhost) ;;
	*)
		local key_file="$STATE_HOME/carbonless/key"
		[[ -s "$key_file" ]] && key="?key=$(tr -d '[:space:]' <"$key_file")"
		;;
	esac
	case "$host" in
	0.0.0.0 | ::) host="$(hostname)" ;;
	*:*) host="[$host]" ;;
	esac
	echo "http://$host:$SERVE_PORT/$key"
}

# Whether the server at service_url answers GET /api/version with the build
# "<version> <commit>". A wildcard bind is asked on loopback.
serves_build() {
	local url
	url="$(service_url)"
	url="${url/\/\/0.0.0.0:/\/\/127.0.0.1:}"
	url="${url/\/\/\[::\]:/\/\/127.0.0.1:}"
	local base="${url%%\?*}" query=""
	[[ "$url" == *\?* ]] && query="?${url#*\?}"
	node -e '
		const [url, want] = process.argv.slice(1);
		fetch(url, { signal: AbortSignal.timeout(2000) })
			.then((r) => (r.ok ? r.json() : null))
			.then((b) => process.exit(b && `${b.version} ${b.commit}` === want ? 0 : 1))
			.catch(() => process.exit(1));' "${base}api/version$query" "$1"
}

# The pid of the crb serve that wrote server.json, or nothing.
server_pid() {
	node -e '
		try {
			const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
			if (Number.isInteger(s.pid)) console.log(s.pid);
		} catch {}' "$STATE_HOME/carbonless/server.json"
}

# Whether crb.service is active (under dry run: unless
# CRB_DEVBOX_DRY_MAINPID is 0).
service_active() {
	if [[ -n "$DRY_RUN" ]]; then
		[[ "${CRB_DEVBOX_DRY_MAINPID:-}" != 0 ]]
	else
		systemctl --user is-active --quiet "$UNIT"
	fi
}

# crb.service's MainPID when it is active, else 0.
service_main_pid() {
	if [[ -n "$DRY_RUN" ]]; then
		echo "${CRB_DEVBOX_DRY_MAINPID:-0}"
	elif systemctl --user is-active --quiet "$UNIT"; then
		systemctl --user show -p MainPID --value "$UNIT"
	else
		echo 0
	fi
}

# Whether the crb serve answering is crb.service itself, not a hand-started
# one holding the port while the service fails to bind it.
service_serves() {
	[[ -n "$DRY_RUN" && -z "${CRB_DEVBOX_DRY_MAINPID:-}" ]] && return 0
	local main pid
	main="$(service_main_pid)"
	pid="$(server_pid)"
	[[ -n "$pid" && "$main" != 0 && "$main" == "$pid" ]]
}

# Waits until crb.service serves the build "<version> <commit>"; on timeout,
# fails with the reason and the service's last log lines.
wait_for_build() {
	local want="$1" timeout="${CRB_DEVBOX_TIMEOUT:-60}" start=$SECONDS
	until serves_build "$want" && service_serves; do
		if ((SECONDS - start >= timeout)); then
			if serves_build "$want"; then
				local stray
				stray="$(server_pid)"
				stray="${stray:+pid $stray}"
				echo "error: after ${timeout}s, $(service_url) is served by ${stray:-an unknown process}, not by $UNIT.service (MainPID $(service_main_pid)): stop that crb serve. Last log lines:" >&2
			else
				echo "error: after ${timeout}s, $(service_url) does not serve $(pretty_build "$want"). Last log lines:" >&2
			fi
			run journalctl --user -u "$UNIT" -n 30 --no-pager >&2 || true
			exit 1
		fi
		sleep 1
	done
}

# The repo whose origin/master is followed: the main checkout of the one
# these scripts are in, unless CRB_DEVBOX_REPO says otherwise.
follow_repo() {
	if [[ -n "${CRB_DEVBOX_REPO:-}" ]]; then
		echo "$CRB_DEVBOX_REPO"
		return
	fi
	# In the main worktree, its toplevel (--separate-git-dir included); in a
	# linked one, the first worktree git lists, which is the main one (git
	# can't tell where a separate git dir's main worktree is from a linked
	# worktree: set CRB_DEVBOX_REPO there).
	local main="" git_dir common
	git_dir="$(git -C "$DEVBOX_DIR" rev-parse --path-format=absolute --git-dir 2>/dev/null)" ||
		die "$DEVBOX_DIR is not in a git checkout: set CRB_DEVBOX_REPO"
	common="$(git -C "$DEVBOX_DIR" rev-parse --path-format=absolute --git-common-dir)"
	if [[ "$git_dir" == "$common" ]]; then
		main="$(git -C "$DEVBOX_DIR" rev-parse --show-toplevel)"
	else
		main="$(git -C "$DEVBOX_DIR" worktree list --porcelain | sed -n '1s/^worktree //p')"
	fi
	[[ -n "$main" ]] || die "can't find the main checkout of $DEVBOX_DIR: set CRB_DEVBOX_REPO"
	echo "$main"
}

# follow and update take turns: two pnpm add -g in the global dir, or two
# restarts of crb.service, must never overlap. follow sets CRB_DEVBOX_LOCKED
# for the update it runs, which then doesn't take the lock its parent holds.
LOCK_FILE="$STATE_HOME/carbonless/devbox.lock"
# take_lock wait: waits up to CRB_DEVBOX_LOCK_WAIT seconds (default 900) for
# the lock; take_lock nowait: returns 1 at once when it is taken.
take_lock() {
	[[ -z "${CRB_DEVBOX_LOCKED:-}" ]] || return 0
	mkdir -p "$(dirname "$LOCK_FILE")"
	exec 9>"$LOCK_FILE"
	flock -n 9 && return 0
	[[ "$1" == wait ]] || return 1
	echo "Waiting for another scripts/devbox follow or update to finish ($LOCK_FILE)"
	flock -w "${CRB_DEVBOX_LOCK_WAIT:-900}" 9 ||
		die "another scripts/devbox follow or update still holds $LOCK_FILE"
}

# Whether $SCRIPTS_HOME holds exactly the scripts in this dir.
scripts_current() {
	local src="$1" f
	for f in "${SCRIPT_FILES[@]}"; do
		cmp -s "$src/$f" "$SCRIPTS_HOME/$f" || return 1
	done
}

# Copies the scripts in dir $1 to $SCRIPTS_HOME, atomically: they go into a
# new dir next to it, then a symlink to that dir is renamed over
# $SCRIPTS_HOME, so a run never sees half old, half new scripts (a running
# follow keeps the files it has open). The dir it replaced is removed.
# Scripts that bash can't parse are never installed: the copy stays as it
# was. Prints a line when it changed anything; fails when $1 lacks a script
# or one doesn't parse.
install_scripts() {
	local src="$1" parent name new old="" f entry
	for f in "${SCRIPT_FILES[@]}"; do
		[[ -f "$src/$f" ]] || { echo "error: $src/$f not found" >&2; return 1; }
	done
	scripts_current "$src" && return 0
	parent="$(dirname "$SCRIPTS_HOME")"
	name="$(basename "$SCRIPTS_HOME")"
	mkdir -p "$parent"
	[[ -L "$SCRIPTS_HOME" ]] && old="$(readlink "$SCRIPTS_HOME")"
	# Leftovers of a copy that stopped half way.
	for entry in "$parent/.$name".*; do
		[[ -e "$entry" || -L "$entry" ]] || continue
		[[ "$(basename "$entry")" == "$old" ]] || rm -rf "$entry"
	done
	new="$(mktemp -d "$parent/.$name.XXXXXX")"
	chmod 755 "$new"
	for f in "${SCRIPT_FILES[@]}"; do
		cp "$src/$f" "$new/$f" || { rm -rf "$new"; return 1; }
	done
	chmod +x "$new/follow" "$new/update"
	for f in follow update lib.sh; do
		if ! bash -n "$new/$f"; then
			echo "error: $src/$f doesn't parse: keeping $SCRIPTS_HOME as it was" >&2
			rm -rf "$new"
			return 1
		fi
	done
	[[ -L "$SCRIPTS_HOME" || ! -e "$SCRIPTS_HOME" ]] || rm -rf "$SCRIPTS_HOME"
	ln -s "$(basename "$new")" "$new.link"
	mv -T "$new.link" "$SCRIPTS_HOME"
	[[ -z "$old" || "$old" == */* ]] || rm -rf "${parent:?}/$old"
	echo "Copied the devbox scripts to $SCRIPTS_HOME"
}

# What pnpm add -g installs for a spec: a tarball's absolute path, or
# carbonless-review@<rc | latest | version>.
package_spec() {
	local spec="$1"
	if [[ -f "$spec" ]]; then
		echo "$(cd "$(dirname "$spec")" && pwd)/$(basename "$spec")"
	elif [[ "$spec" =~ ^(rc|latest|[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$ ]]; then
		echo "$PACKAGE@$spec"
	else
		die "not a tarball, rc, latest or a version: $spec"
	fi
}
