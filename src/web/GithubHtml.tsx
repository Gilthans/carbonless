import "github-markdown-css/github-markdown-light.css";
import "./githubHtml.css";
import { useMemo } from "react";
import { sanitizeGithubHtml } from "./githubHtml";

/**
 * GitHub-rendered HTML styled like on GitHub. github-markdown-css scopes every
 * rule to `.markdown-body`, so it stays inside this container. The HTML is
 * always sanitized first (see githubHtml.ts).
 */
export function GithubHtml(props: { html: string; className?: string }) {
	const safe = useMemo(() => sanitizeGithubHtml(props.html), [props.html]);
	return (
		<div
			className={`markdown-body min-w-0 ${props.className ?? ""}`}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by sanitizeGithubHtml just above.
			dangerouslySetInnerHTML={{ __html: safe }}
		/>
	);
}
