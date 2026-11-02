// pnpm release: build and install carbonless-review.
//
//   pnpm release local [--out <dir>] [--no-install]
//       builds and packs this checkout as it is (any branch, uncommitted
//       edits too) into <dir> (default ~/.local/share/carbonless/releases)
//       as carbonless-review-<version>-<sha7>[-dirty].tgz, and installs it as
//       the global crb (pnpm add -g). The last stdout line is the tarball's
//       path; everything else goes to stderr.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalIo, type Runner, releaseLocal } from "./release-local.js";

/** Runs a command, showing its output on stderr as it comes. */
const runner: Runner = (cmd, args, opts) =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
			if (cmd !== "tar") process.stderr.write(d);
		});
		child.stderr.on("data", (d) => {
			stderr += d;
			process.stderr.write(d);
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});

const io: LocalIo = {
	run: runner,
	log: (line) => console.error(line),
};

function usage(): never {
	console.error("usage: pnpm release local [--out <dir>] [--no-install]");
	process.exit(2);
}

const defaultOut = () =>
	join(
		process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
		"carbonless/releases",
	);

async function main(argv: string[]) {
	const [command, ...rest] = argv;
	switch (command) {
		case "local": {
			let out = defaultOut();
			let install = true;
			for (let i = 0; i < rest.length; i++) {
				const a = rest[i] ?? "";
				if (a === "--out") out = rest[++i] ?? usage();
				else if (a.startsWith("--out=")) out = a.slice(6);
				else if (a === "--no-install") install = false;
				else usage();
			}
			if (!out) usage();
			const scratch = mkdtempSync(join(tmpdir(), "crb-release-"));
			try {
				// pnpm runs package scripts from the package's root.
				const tarball = await releaseLocal(io, {
					root: process.cwd(),
					out,
					install,
					scratch,
				});
				console.log(tarball);
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
			return;
		}
		default:
			usage();
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`error: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
