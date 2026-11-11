# Running crb on a remote machine

An always-on `crb serve` on a machine you open from other devices (e.g. over
Tailscale):

1. Install it: in a checkout, `pnpm install`, then `pnpm release local`
   (builds, packs into `~/.local/share/carbonless/releases/` and installs
   the global `crb`; `--no-install` only packs), or from npm:
   `pnpm add -g carbonless-review` (`@rc` for the release candidates).
2. Bind it, in `~/.config/carbonless/config.json`:
   `{ "serve": { "host": "<the machine's Tailscale IP>", "port": 4747 } }`.
   Off loopback, pages need the access key (`~/.local/state/carbonless/key`);
   the printed link carries it as `?key=`. The key is like an SSH key: whoever
   holds it can set (and Check) the agent's command, which the server runs
   as your user. On loopback with no key (and no `publicUrl`, below), so can
   any local process.

   To open it by the machine's Tailscale name instead: `*.ts.net` names
   are HTTPS-only in browsers (HSTS preload), so put `tailscale serve` in
   front (`tailscale serve --bg --https=8443 http://127.0.0.1:4747`), keep
   `host` on `127.0.0.1` and add `"publicUrl":
   "https://<machine>.<tailnet>.ts.net:8443"` to `serve`. Links then use the
   public URL; the key is required on loopback too, and writes are accepted
   from that origin.
3. Run it as a systemd user service, `~/.config/systemd/user/crb.service`
   (`PATH` must reach Node 24, the global `crb`, `git` and `gh`; don't set
   `XDG_CONFIG_HOME`, so it sees your `gh` login and config):

   ```ini
   [Unit]
   Description=carbonless review server (crb serve)
   StartLimitIntervalSec=0

   [Service]
   Environment="PATH=<Node 24 bin dir>:%h/.local/share/pnpm/bin:/usr/local/bin:/usr/bin:/bin"
   ExecStart=%h/.local/share/pnpm/bin/crb serve
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

   Then `systemctl --user daemon-reload && systemctl --user enable --now crb`,
   and `sudo loginctl enable-linger $USER` so it runs without a login and
   starts at boot. After `pnpm release local`: `systemctl --user restart crb`.
   Logs: `journalctl --user -u crb`.
