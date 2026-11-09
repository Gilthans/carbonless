import "github-markdown-css/github-markdown-dark.css";
import "./githubHtml.css";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { sanitizeGithubHtml } from "./sanitizeGithubHtml";

/**
 * Called when an image inside GitHub HTML fails to load. Private-repo images
 * use signed URLs that expire after a few minutes; the page provides a handler
 * that fetches fresh HTML (see overview/imageRefresh.ts).
 */
export const ImageErrorContext = createContext<(() => void) | undefined>(
	undefined,
);

/**
 * GitHub-rendered HTML styled like on GitHub. github-markdown-css scopes every
 * rule to `.markdown-body`, so it stays inside this container. The HTML is
 * always sanitized first (see sanitizeGithubHtml.ts).
 */
export function GithubHtml(props: { html: string; className?: string }) {
	const safe = useMemo(() => sanitizeGithubHtml(props.html), [props.html]);
	const onImageError = useContext(ImageErrorContext);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el || !onImageError) return;
		// `error` doesn't bubble; listen in the capture phase.
		const listener = (e: Event) => {
			if (e.target instanceof HTMLImageElement) onImageError();
		};
		el.addEventListener("error", listener, true);
		return () => el.removeEventListener("error", listener, true);
	}, [onImageError]);
	return (
		<div
			ref={ref}
			className={`markdown-body min-w-0 ${props.className ?? ""}`}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by sanitizeGithubHtml just above.
			dangerouslySetInnerHTML={{ __html: safe }}
		/>
	);
}
