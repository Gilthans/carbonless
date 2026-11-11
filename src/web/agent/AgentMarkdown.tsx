/**
 * An agent's reply: GitHub-flavored Markdown, rendered like a GitHub
 * comment. The prose goes through `marked` and then sanitizeGithubHtml
 * (GithubHtml), the same allowlist as GitHub's own HTML, so raw HTML,
 * handlers, `javascript:` links and non-https images in a reply are
 * stripped. Fenced code in a language the diff highlights is drawn as the
 * diff's code rows; a `diff` fence as added and deleted rows. `path:line`
 * refs to files of the PR become router links to Files changed at the
 * answer's `head` (codeLinks.ts).
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Marked, type Token, type Tokens, type TokensList } from "marked";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { HunkLine } from "../../shared/diffHunk";
import { reviewQuery, sessionQuery } from "../api";
import { languageFor } from "../files/highlight";
import type { FilesSearch } from "../files/landing";
import { GithubHtml } from "../GithubHtml";
import { CodeRows } from "../threads/CommentBody";
import { codeLinkSearch, linkCodeRefs } from "./codeLinks";

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

const LINK_CLASS =
	"rounded-sm text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent";

/**
 * Turns the code refs in the rendered prose into router links: the hrefs
 * are the router's own for a FilesSearch built from the matched path and
 * numbers, and a plain click navigates through the router.
 */
function useCodeLinks(
	root: React.RefObject<HTMLDivElement | null>,
	text: string,
	head: string | undefined,
) {
	const router = useRouter({ warn: false });
	const review = useQuery({ ...reviewQuery(), enabled: false }).data;
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	const files = useMemo(
		() => new Set(review?.files.map((f) => f.path) ?? []),
		[review],
	);
	const patchsets = session?.patchsets;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `text` is what re-renders the prose.
	useLayoutEffect(() => {
		const el = root.current;
		if (!el || !router || files.size === 0) return;
		// The review the page shows (`/r/$id`); none outside a review.
		const id = router.state.matches
			.map((m) => (m.params as { id?: string }).id)
			.find((x) => x);
		if (!id) return;
		const targets = new WeakMap<HTMLElement, FilesSearch>();
		for (const prose of el.querySelectorAll<HTMLElement>(".markdown-body")) {
			linkCodeRefs(prose, (ref) => {
				const search = codeLinkSearch(ref, head, files, patchsets ?? []);
				if (!search) return null;
				const link = el.ownerDocument.createElement("a");
				link.dataset.testid = "agent-code-link";
				link.className = LINK_CLASS;
				link.href = router.buildLocation({
					to: "/r/$id/files",
					params: { id },
					search,
				} as never).href;
				targets.set(link, search);
				return link;
			});
		}
		const onClick = (e: MouseEvent) => {
			const link = (e.target as Element | null)?.closest<HTMLElement>("a");
			const search = link && targets.get(link);
			if (!search || e.button !== 0) return;
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			e.preventDefault();
			void router.navigate({
				to: "/r/$id/files",
				params: { id },
				search,
			} as never);
		};
		el.addEventListener("click", onClick);
		return () => el.removeEventListener("click", onClick);
	}, [root, router, files, patchsets, head, text]);
}

export function AgentMarkdown(props: {
	text: string;
	/** The commit the answer was written on: its code links open there. */
	head?: string;
}) {
	const parts = useMemo(() => agentParts(props.text), [props.text]);
	const root = useRef<HTMLDivElement>(null);
	useCodeLinks(root, props.text, props.head);
	return (
		<div ref={root} className="min-w-0">
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
