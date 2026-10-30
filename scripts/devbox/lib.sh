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

UNIT=crb
PACKAGE=carbonless-review
DRY_RUN="${CRB_DEVBOX_DRY_RUN:-}"
DEVBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# Writes crb.service from the template when it differs (Node 24 and the
# global crb may have moved), and reloads systemd then. Sets UNIT_CHANGED.
# The values are escaped for systemd (% is a specifier) and for bash's
# replacement (& is the match).
write_unit() {
	local crb="$1" service_path="$NODE_BIN:$PNPM_HOME/bin" tool dir
	# PATH for the service: Node 24, the global bin dir, then wherever git and gh live.
	for tool in git gh; do
		command -v "$tool" >/dev/null || die "$tool not found on PATH"
		dir="$(dirname "$(command -v "$tool")")"
		[[ ":$service_path:" == *":$dir:"* ]] || service_path="$service_path:$dir"
	done
	for dir in /usr/local/bin /usr/bin /bin; do
		[[ ":$service_path:" == *":$dir:"* ]] || service_path="$service_path:$dir"
	done
	service_path="${service_path//%/%%}"
	crb="${crb//%/%%}"
	local unit
	unit="$(<"$DEVBOX_DIR/crb.service.template")"
	unit="${unit//@PATH@/"$service_path"}"
	unit="${unit//@CRB@/"$crb"}"
	UNIT_CHANGED=""
	if [[ ! -f "$UNIT_FILE" || "$(<"$UNIT_FILE")" != "$unit" ]]; then
		mkdir -p "$UNIT_DIR"
		printf '%s\n' "$unit" >"$UNIT_FILE"
		UNIT_CHANGED=1
		echo "Wrote $UNIT_FILE"
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
