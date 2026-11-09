import { spawn } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `pnpm release local`: build and pack the checkout it runs in, whatever its
// source (master, a branch, uncommitted edits), keep the tarball named by its
// build, and install it as the global crb. Nothing about services: what runs
// crb picks the new build up on its next start.
//
// Everything that runs a command goes through a Runner, so tests drive it
// without pnpm or tar.

export const PACKAGE = "carbonless-review";

/**
 * pnpm (11+) skips versions published less than a day ago
 * (minimumReleaseAge); our own package is exempt, its dependencies keep the
 * delay.
 */
export const NO_DELAY = `--config.minimumReleaseAgeExclude=${PACKAGE}`;

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (
	cmd: string,
	args: readonly string[],
	opts?: { cwd?: string },
) => Promise<RunResult>;

export type LocalIo = { run: Runner; log: (line: string) => void };

export type Build = { version: string; commit: string };

export type LocalOptions = {
	/** The checkout to pack (its package.json must be carbonless-review's). */
	root: string;
	/** Where the tarball is kept. */
	out: string;
	/** pnpm add -g it after packing. */
	install: boolean;
	/** An empty dir for pnpm pack's output. */
	scratch: string;
};

async function must(
	io: LocalIo,
	cmd: string,
	args: readonly string[],
	opts?: { cwd?: string },
): Promise<string> {
	const r = await io.run(cmd, args, opts);
	if (r.code !== 0) {
		throw new Error(
			`${cmd} ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
		);
	}
	return r.stdout;
}

/** `carbonless-review-<version>-<sha7>[-dirty].tgz`: one name per build. */
export function tarballName({ version, commit }: Build): string {
	const dirty = commit.endsWith("-dirty") ? "-dirty" : "";
	const sha = commit.replace(/-dirty$/, "").slice(0, 7);
	return `${PACKAGE}-${version}-${sha}${dirty}.tgz`;
}

/** dist/build-info.json's build, checked: a version and a commit sha. */
export function parseBuild(text: string): Build {
	const b = (JSON.parse(text) ?? {}) as Partial<Build>;
	if (
		typeof b.version !== "string" ||
		!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(b.version) ||
		typeof b.commit !== "string" ||
		!/^[0-9a-f]{7,40}(-dirty)?$/.test(b.commit)
	) {
		throw new Error(`not a build: ${text.trim()}`);
	}
	return { version: b.version, commit: b.commit };
}

/** `0.1.0 (abc1234)`, as crb --version prints a build. */
export const prettyBuild = ({ version, commit }: Build) =>
	`${version} (${commit.replace(/-dirty$/, "").slice(0, 7)}${commit.endsWith("-dirty") ? "-dirty" : ""})`;

/**
 * Packs the checkout (pnpm pack builds it first), moves the tarball to
 * `out` under its build's name and, unless told not to, installs it
 * globally. Returns the tarball's absolute path.
 */
export async function releaseLocal(
	io: LocalIo,
	opts: LocalOptions,
): Promise<string> {
	const pkg = JSON.parse(
		readFileSync(join(opts.root, "package.json"), "utf8"),
	) as { name?: string };
	if (pkg.name !== PACKAGE) {
		throw new Error(`${opts.root} is not a ${PACKAGE} checkout`);
	}
	io.log(`Building and packing ${opts.root}`);
	await must(io, "pnpm", ["pack", "--pack-destination", opts.scratch], {
		cwd: opts.root,
	});
	const packed = readdirSync(opts.scratch).filter((f) => f.endsWith(".tgz"));
	if (packed.length !== 1 || !packed[0]) {
		throw new Error(
			`pnpm pack left ${packed.length} tarballs in ${opts.scratch}`,
		);
	}
	const from = join(opts.scratch, packed[0]);
	// By its bare name, in its own dir: GNU tar (Git for Windows' comes first
	// on PATH there) reads the colon of a drive (E:\...) as a remote host.
	const build = parseBuild(
		await must(
			io,
			"tar",
			["-xzOf", packed[0], "package/dist/build-info.json"],
			{
				cwd: opts.scratch,
			},
		),
	);
	const out = resolve(opts.out);
	mkdirSync(out, { recursive: true });
	const tarball = join(out, tarballName(build));
	// Copy, then rename: never a partial tarball under its final name, and
	// the scratch dir may be on another filesystem.
	const tmp = `${tarball}.tmp`;
	try {
		copyFileSync(from, tmp);
		renameSync(tmp, tarball);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
	rmSync(from);
	io.log(`Packed ${prettyBuild(build)}: ${tarball}`);
	if (opts.install) {
		await must(io, "pnpm", ["add", "-g", tarball, NO_DELAY]);
		io.log(
			`Installed ${prettyBuild(build)} as the global crb (a running crb serve keeps its build until restarted)`,
		);
	}
	return tarball;
}

/** Runs a command, showing its output on stderr as it comes. */
const streaming: Runner = (cmd, args, opts) =>
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

const defaultOut = () =>
	join(
		process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
		"carbonless/releases",
	);

/**
 * `pnpm release local [--out <dir>] [--no-install]`: prints the tarball's
 * path as the last stdout line; everything else goes to stderr.
 */
export async function localCommand(
	rest: readonly string[],
	usage: () => never,
): Promise<void> {
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
	// pnpm runs scripts from the package root; a relative --out is the
	// caller's, as INIT_CWD keeps it.
	out = resolve(process.env.INIT_CWD || process.cwd(), out);
	const scratch = mkdtempSync(join(tmpdir(), "crb-release-"));
	try {
		const tarball = await releaseLocal(
			{ run: streaming, log: (line) => console.error(line) },
			{ root: process.cwd(), out, install, scratch },
		);
		console.log(tarball);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
