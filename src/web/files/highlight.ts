import type {
	HighlighterCore,
	LanguageRegistration,
	ThemedToken,
} from "shiki/core";

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

const THEME = "github-light";

/** Shiki language for a path, or null for plain text. */
export function languageFor(path: string): string | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

let highlighter: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
	highlighter ??= (async () => {
		const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] =
			await Promise.all([
				import("shiki/core"),
				import("shiki/engine/javascript"),
				import("shiki/themes/github-light.mjs"),
			]);
		return createHighlighterCore({
			themes: [theme.default],
			langs: [],
			engine: createJavaScriptRegexEngine(),
		});
	})();
	return highlighter;
}

async function loadLanguage(
	core: HighlighterCore,
	lang: string,
): Promise<void> {
	let pending = loading.get(lang);
	if (!pending) {
		const load = LANGUAGES[lang];
		if (!load) throw new Error(`No grammar for ${lang}`);
		pending = load().then((module) => core.loadLanguage(module.default));
		loading.set(lang, pending);
	}
	return pending;
}

/**
 * Tokens of one line. Lines are highlighted on their own, so constructs that
 * span lines (block comments, strings) may lose their state.
 */
export async function highlightLine(
	text: string,
	lang: string | null,
): Promise<ThemedToken[]> {
	if (!lang || !LANGUAGES[lang]) return [{ content: text, offset: 0 }];
	const core = await getHighlighter();
	await loadLanguage(core, lang);
	return core.codeToTokensBase(text, { lang, theme: THEME })[0] ?? [];
}
