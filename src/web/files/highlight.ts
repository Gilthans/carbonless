import type {
	HighlighterCore,
	LanguageRegistration,
	ThemedToken,
} from "shiki/core";
import { syntaxTheme } from "./syntaxTheme";

type LangModule = { default: LanguageRegistration[] };

/** Every grammar is its own chunk, loaded the first time a file needs it. */
const LANGUAGES: Record<string, () => Promise<LangModule>> = {
	csharp: () => import("shiki/langs/csharp.mjs"),
	xml: () => import("shiki/langs/xml.mjs"),
	powershell: () => import("shiki/langs/powershell.mjs"),
	markdown: () => import("shiki/langs/markdown.mjs"),
	typescript: () => import("shiki/langs/typescript.mjs"),
	tsx: () => import("shiki/langs/tsx.mjs"),
	javascript: () => import("shiki/langs/javascript.mjs"),
	json: () => import("shiki/langs/json.mjs"),
	yaml: () => import("shiki/langs/yaml.mjs"),
	css: () => import("shiki/langs/css.mjs"),
	html: () => import("shiki/langs/html.mjs"),
	shellscript: () => import("shiki/langs/shellscript.mjs"),
	python: () => import("shiki/langs/python.mjs"),
	go: () => import("shiki/langs/go.mjs"),
	rust: () => import("shiki/langs/rust.mjs"),
	java: () => import("shiki/langs/java.mjs"),
	sql: () => import("shiki/langs/sql.mjs"),
};

const EXTENSIONS: Record<string, string> = {
	cs: "csharp",
	xml: "xml",
	wxs: "xml",
	wxl: "xml",
	csproj: "xml",
	props: "xml",
	targets: "xml",
	ps1: "powershell",
	psm1: "powershell",
	md: "markdown",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	json: "json",
	yml: "yaml",
	yaml: "yaml",
	css: "css",
	html: "html",
	htm: "html",
	sh: "shellscript",
	bash: "shellscript",
	py: "python",
	go: "go",
	rs: "rust",
	java: "java",
	sql: "sql",
};

const THEME = syntaxTheme.name ?? "carbonless-dark";

/** Shiki language for a path, or null for plain text. */
export function languageFor(path: string): string | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Caches what `load` resolves to. A rejection is forgotten, so the next call
 * tries again (a chunk that failed to load once isn't failed forever).
 */
export function cacheUntilRejected<T>(
	load: () => Promise<T>,
): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () => {
		pending ??= load().catch((error: unknown) => {
			pending = undefined;
			throw error;
		});
		return pending;
	};
}

const getHighlighter = cacheUntilRejected(
	async (): Promise<HighlighterCore> => {
		const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
			await Promise.all([
				import("shiki/core"),
				import("shiki/engine/javascript"),
			]);
		return createHighlighterCore({
			themes: [syntaxTheme],
			langs: [],
			engine: createJavaScriptRegexEngine(),
		});
	},
);

const languageLoaders = new Map(
	Object.entries(LANGUAGES).map(([lang, load]) => [
		lang,
		cacheUntilRejected(async () => {
			const [core, module] = await Promise.all([getHighlighter(), load()]);
			await core.loadLanguage(module.default);
			return core;
		}),
	]),
);

/**
 * Tokens of one line. Lines are highlighted on their own, so constructs that
 * span lines (block comments, strings) may lose their state.
 */
export async function highlightLine(
	text: string,
	lang: string | null,
): Promise<ThemedToken[]> {
	const loadLanguage = lang ? languageLoaders.get(lang) : undefined;
	if (!lang || !loadLanguage) return [{ content: text, offset: 0 }];
	const core = await loadLanguage();
	return core.codeToTokensBase(text, { lang, theme: THEME })[0] ?? [];
}
