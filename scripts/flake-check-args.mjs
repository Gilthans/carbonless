// pnpm flake-check's arguments (scripts/flake-check.mjs).

/**
 * Reads `<files…> [--runs N] [--load L] [-g title] [--project name]`, each
 * option as `--x=v` or `--x v`. Returns `{ error }` for anything it can't
 * use: an unknown option, a count that isn't a whole number in range, no
 * test files.
 */
export function parseFlakeArgs(argv) {
	const out = {
		runs: 5,
		// Busy loops are opt-in: the devbox is loaded by other agents already,
		// and loops held inside the queue slow their unqueued runs too.
		load: 0,
		grep: undefined,
		projects: [],
		units: [],
		specs: [],
	};
	const count = (name, value, min) => {
		const n = /^\d+$/.test(value ?? "") ? Number(value) : Number.NaN;
		if (!(n >= min && n <= 1000)) {
			return `--${name} needs a whole number from ${min}, got ${value ?? "nothing"}`;
		}
		out[name] = n;
		return null;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const eq = arg.indexOf("=");
		const flag = arg.startsWith("-") ? (eq > 0 ? arg.slice(0, eq) : arg) : null;
		const value = () => (eq > 0 ? arg.slice(eq + 1) : argv[++i]);
		let error = null;
		if (flag === "--runs") error = count("runs", value(), 1);
		else if (flag === "--load") error = count("load", value(), 0);
		else if (flag === "-g" || flag === "--grep") {
			out.grep = value();
			if (!out.grep) error = `${flag} needs a title`;
		} else if (flag === "--project") {
			const p = value();
			if (!p) error = "--project needs a name";
			else out.projects.push(p);
		} else if (flag) error = `unknown option ${arg}`;
		else if (/\.test\.tsx?$/.test(arg)) out.units.push(arg);
		else if (/\.spec\.ts$/.test(arg)) out.specs.push(arg);
		else error = `not a unit test or e2e spec file: ${arg}`;
		if (error) return { error };
	}
	if (!out.units.length && !out.specs.length) return { error: "no test files" };
	return out;
}
