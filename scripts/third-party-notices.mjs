// THIRD-PARTY-NOTICES.md for the npm package: every package whose code or
// files end up in the build output (the web build's module graph: JS, CSS,
// and the fonts the CSS pulls in), each with its license text. Written by a
// small Vite plugin into dist/, next to the build it describes. No
// dependencies.
//
// The server and CLI (dist/*.js) are compiled by tsc file by file, not
// bundled: their dependencies are installed by npm from their own packages
// and carry their own notices.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

export const FILE_NAME = "THIRD-PARTY-NOTICES.md";

/**
 * Packages offered under a choice of licenses, and the one we use.
 */
export const LICENSE_CHOICES = {
	// "MPL-2.0 OR Apache-2.0"
	dompurify: "Apache-2.0",
};

/**
 * Packages that ship no license file of their own. Each entry names the
 * committed text under licenses/ that stands for it, and says where it
 * came from. Keep it short and explain every line.
 */
export const LICENSE_OVERRIDES = {};

/**
 * License files that also carry other packages' licenses, cut to the
 * package's own: vite's LICENSE.md appends the licenses of what vite bundles
 * into itself, none of which reaches our output (the helpers vite writes
 * into it, the modulepreload polyfill and preload helper, are Vite's own
 * code).
 */
export const LICENSE_CUTS = {
	vite: { file: "LICENSE.md", before: "# Licenses of bundled dependencies" },
};

/**
 * Virtual modules the bundler writes into the output (`\0<prefix>/...`), and
 * the package their code comes from. An unknown one fails the build.
 */
export const VIRTUAL_PACKAGES = {
	vite: "vite", // modulepreload polyfill, preload helper
	rolldown: "rolldown", // the chunks' runtime
};

/**
 * A file inside the package a bundled virtual module comes from, resolved
 * from the project (or, for the bundler's own dependencies, from vite).
 */
export function virtualPackageFile(id, root) {
	const prefix = id.slice(1).split("/")[0] ?? "";
	const name = VIRTUAL_PACKAGES[prefix];
	if (!name) {
		throw new Error(
			`third-party notices: unknown virtual module ${JSON.stringify(id)} in the output (add its package to VIRTUAL_PACKAGES, scripts/third-party-notices.mjs)`,
		);
	}
	const fromRoot = createRequire(join(root, "package.json"));
	try {
		return fromRoot.resolve(`${name}/package.json`);
	} catch {
		const vite = fromRoot.resolve("vite/package.json");
		return createRequire(vite).resolve(`${name}/package.json`);
	}
}

/** License, licence, copying, notice files (any extension or suffix). */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/**
 * The package directory a module path belongs to: the last `node_modules`
 * segment's package (`name` or `@scope/name`), or null for our own files
 * and virtual modules.
 */
export function packageRoot(id) {
	const file = id.split("?")[0] ?? "";
	if (file.startsWith("\0")) return null;
	const marker = `${sep}node_modules${sep}`;
	const at = file.lastIndexOf(marker);
	if (at < 0) return null;
	const after = file.slice(at + marker.length).split(sep);
	const parts = after[0]?.startsWith("@")
		? after.slice(0, 2)
		: after.slice(0, 1);
	if (parts.length === 0 || parts.some((p) => !p)) return null;
	return file.slice(0, at + marker.length) + parts.join(sep);
}

/** The text of `repository` (string or { url }), cleaned for display. */
function repositoryOf(pkg) {
	const raw =
		typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
	return raw ? raw.replace(/^git\+/, "").replace(/\.git$/, "") : undefined;
}

/** The SPDX expression of a package.json (`license`, or old `licenses`). */
function licenseOf(pkg) {
	if (typeof pkg.license === "string") return pkg.license;
	if (pkg.license?.type) return pkg.license.type;
	if (Array.isArray(pkg.licenses)) {
		return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
	}
	return "UNKNOWN";
}

/**
 * One entry per package@version used by the build: name, version, license
 * (the SPDX expression, and the one we use when it offers a choice),
 * repository or homepage, and every license, copying or notice text it
 * ships. Fails, naming the packages, when one has no license text and no
 * override.
 */
export function collectPackages(
	moduleIds,
	{
		choices = LICENSE_CHOICES,
		overrides = LICENSE_OVERRIDES,
		cuts = LICENSE_CUTS,
		overridesDir,
	} = {},
) {
	const roots = new Set();
	for (const id of moduleIds) {
		const root = packageRoot(id);
		if (root && existsSync(join(root, "package.json"))) roots.add(root);
	}
	const byKey = new Map();
	const missing = [];
	for (const root of roots) {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const key = `${pkg.name}@${pkg.version}`;
		if (byKey.has(key)) continue;
		const files = readdirSync(root)
			.filter((f) => LICENSE_FILE.test(f))
			.sort();
		const cut = cuts[pkg.name];
		const texts = files.map((f) => {
			let text = readFileSync(join(root, f), "utf8");
			if (cut?.file === f) {
				const at = text.indexOf(cut.before);
				if (at < 0) {
					throw new Error(
						`third-party notices: ${key}'s ${f} no longer has "${cut.before}" (check LICENSE_CUTS)`,
					);
				}
				text = text.slice(0, at);
			}
			return { file: f, text: text.trim() };
		});
		const override = overrides[pkg.name];
		if (override) {
			const file = join(overridesDir ?? "licenses", override.file);
			texts.push({
				file: `${override.file} (${override.source})`,
				text: readFileSync(file, "utf8").trim(),
			});
		}
		if (texts.every((t) => t.text === "")) missing.push(key);
		byKey.set(key, {
			name: pkg.name,
			version: pkg.version,
			license: licenseOf(pkg),
			chosen: choices[pkg.name],
			url: repositoryOf(pkg) ?? pkg.homepage,
			texts,
		});
	}
	if (missing.length > 0) {
		throw new Error(
			`third-party notices: no license text in ${missing.sort().join(", ")} (add a file under licenses/ and an entry in LICENSE_OVERRIDES, scripts/third-party-notices.mjs)`,
		);
	}
	return [...byKey.values()].sort(
		(a, b) =>
			a.name.localeCompare(b.name, "en") ||
			a.version.localeCompare(b.version, "en"),
	);
}

/** The notices file for those packages. */
export function renderNotices(packages) {
	const lines = [
		"# Third-party notices",
		"",
		"carbonless-review's web page bundles the packages below (code, styles",
		"and fonts). Each is listed with its license and the license, copying or",
		"notice texts it ships. The server's dependencies are installed by npm",
		"from their own packages, with their own notices.",
		"",
	];
	for (const p of packages) {
		lines.push(`## ${p.name}@${p.version}`, "");
		lines.push(
			p.chosen
				? `License: ${p.license}; used under ${p.chosen}.`
				: `License: ${p.license}`,
		);
		if (p.url) lines.push(`Source: ${p.url}`);
		lines.push("");
		for (const t of p.texts) {
			// A fence longer than any run of backticks in the text.
			const longest = Math.max(
				0,
				...(t.text.match(/`+/g) ?? []).map((r) => r.length),
			);
			const fence = "`".repeat(Math.max(3, longest + 1));
			lines.push(`### ${t.file}`, "", `${fence}text`, t.text, fence, "");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** The specifiers of a CSS text's `@import`s. */
export function cssImports(css) {
	const out = [];
	for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
		if (m[1]) out.push(m[1]);
	}
	return out;
}

/**
 * The package files a CSS file pulls in through `@import`, followed through
 * imported CSS files: Tailwind resolves these itself (`@import
 * "tailwindcss"`, the fonts' CSS), so they never show up as modules of the
 * build. Returns a file inside each package reached (enough to find its
 * root).
 */
export function cssPackageFiles(file, seen = new Set()) {
	const found = [];
	if (seen.has(file) || !existsSync(file)) return found;
	seen.add(file);
	const require = createRequire(file);
	for (const spec of cssImports(readFileSync(file, "utf8"))) {
		if (/^(https?:)?\/\//.test(spec)) continue;
		if (spec.startsWith(".") || spec.startsWith("/")) {
			found.push(...cssPackageFiles(resolve(dirname(file), spec), seen));
			continue;
		}
		const parts = spec.split("/");
		const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
		const manifest = require.resolve(`${name}/package.json`);
		found.push(manifest);
		const rest = spec.slice(name.length + 1);
		const target = rest
			? join(dirname(manifest), rest)
			: join(dirname(manifest), readCssEntry(manifest));
		if (target.endsWith(".css")) found.push(...cssPackageFiles(target, seen));
	}
	return found;
}

/** A package's CSS entry: `style`, else index.css. */
function readCssEntry(manifest) {
	const pkg = JSON.parse(readFileSync(manifest, "utf8"));
	return typeof pkg.style === "string" ? pkg.style : "index.css";
}

/**
 * The Vite plugin: after the build, writes THIRD-PARTY-NOTICES.md into the
 * output's parent (dist/, so it is in the npm package). What it counts:
 * every module of the build, the packages CSS files reach through
 * `@import`, and the original files of emitted assets (fonts).
 */
export function thirdPartyNotices({ overridesDir } = {}) {
	let root = "";
	let outDir = "";
	const ids = new Set();
	return {
		name: "carbonless-third-party-notices",
		apply: "build",
		enforce: "pre",
		configResolved(config) {
			root = config.root;
			outDir = resolve(config.root, config.build.outDir);
		},
		transform(_code, id) {
			const file = id.split("?")[0] ?? "";
			if (file.endsWith(".css") && !file.startsWith("\0")) {
				for (const f of cssPackageFiles(file)) ids.add(f);
			}
			return null;
		},
		generateBundle(_options, bundle) {
			for (const id of this.getModuleIds()) ids.add(id);
			for (const out of Object.values(bundle)) {
				if (out.type === "chunk") {
					for (const [id, mod] of Object.entries(out.modules)) {
						if (id.startsWith("\0") && mod.renderedLength > 0) {
							ids.add(virtualPackageFile(id, root));
						}
					}
					continue;
				}
				for (const name of out.originalFileNames ?? []) {
					ids.add(resolve(root, name));
				}
			}
		},
		writeBundle() {
			const packages = collectPackages(ids, {
				overridesDir: overridesDir ?? join(dirname(outDir), "..", "licenses"),
			});
			writeFileSync(join(dirname(outDir), FILE_NAME), renderNotices(packages));
		},
	};
}
