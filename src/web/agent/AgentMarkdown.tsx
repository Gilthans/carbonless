/**
 * An agent's reply: GitHub-flavored Markdown, rendered like a GitHub
 * comment. The prose goes through `marked` and then sanitizeGithubHtml
 * (GithubHtml), the same allowlist as GitHub's own HTML, so raw HTML,
 * handlers, `javascript:` links and non-https images in a reply are
 * stripped. Fenced code in a language the diff highlights is drawn as the
 * diff's code rows; a `diff` fence as added and deleted rows.
 */
import { Marked, type Token, type Tokens, type TokensList } from "marked";
import { useMemo } from "react";
import type { HunkLine } from "../../shared/diffHunk";
import { languageFor } from "../files/highlight";
import { GithubHtml } from "../GithubHtml";
import { CodeRows } from "../threads/CommentBody";

const md = new Marked({ gfm: true, breaks: false, async: false });

type Part =
	| { kind: "html"; html: string }
	| { kind: "code"; path: string; lines: HunkLine[] };

/** A fence's lines as rows: a `diff` fence by its signs, others as context. */
function fenceLines(text: string, diff: boolean): HunkLine[] {
	return text.split("\n").map((line) => {
		if (diff && line.startsWith("+") && !line.startsWith("+++")) {
			return { kind: "add", oldNo: null, newNo: null, text: line.slice(1) };
		}
		if (diff && line.startsWith("-") && !line.startsWith("---")) {
			return { kind: "del", oldNo: null, newNo: null, text: line.slice(1) };
		}
		return {
			kind: "context",
			oldNo: null,
			newNo: null,
			text: diff && line.startsWith(" ") ? line.slice(1) : line,
		};
	});
}

/** The reply as prose and code parts, in order. */
export function agentParts(text: string): Part[] {
	const tokens = md.lexer(text);
	const parts: Part[] = [];
	let prose: Token[] = [];
	const flush = () => {
		if (!prose.length) return;
		const list = Object.assign(prose, { links: tokens.links }) as TokensList;
		parts.push({ kind: "html", html: md.parser(list) });
		prose = [];
	};
	for (const token of tokens) {
		if (token.type === "code") {
			const code = token as Tokens.Code;
			const info = (code.lang ?? "").trim().split(/\s+/)[0]?.toLowerCase();
			const diff = info === "diff" || info === "patch";
			// The info string names a language, not a path: `x.<info>`.
			const path = info ? `x.${info}` : "";
			if (!code.codeBlockStyle && (diff || (info && languageFor(path)))) {
				flush();
				parts.push({ kind: "code", path, lines: fenceLines(code.text, diff) });
				continue;
			}
		}
		prose.push(token);
	}
	flush();
	return parts;
}

export function AgentMarkdown(props: { text: string }) {
	const parts = useMemo(() => agentParts(props.text), [props.text]);
	return (
		<div className="min-w-0">
			{parts.map((part, i) =>
				part.kind === "html" ? (
					// Parts keep their order while the text grows.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above.
					<GithubHtml key={i} html={part.html} />
				) : (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						key={i}
						className="my-2 min-w-0 overflow-x-auto rounded-md border border-line bg-code font-mono text-xs leading-5 text-code-ink [scrollbar-width:thin]"
					>
						<table className="w-full border-collapse">
							<CodeRows
								lines={part.lines}
								path={part.path}
								wrap={false}
								testId="agent-code-line"
							/>
						</table>
					</div>
				),
			)}
		</div>
	);
}
