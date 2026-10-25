import DOMPurify from "dompurify";

/**
 * GitHub-rendered HTML (PR descriptions, comments) is untrusted: the server
 * passes on what GitHub returns. It is sanitized here, in the browser, right
 * before rendering, with a conservative allowlist on top of DOMPurify:
 *
 * - only the tags and attributes GitHub's markdown produces; no style, id,
 *   data-*, forms, media, frames or scripts;
 * - links keep only absolute http(s)/mailto hrefs and always open in a new
 *   tab with rel="noreferrer noopener";
 * - images load only from https (any host: bots link their own icons);
 *   any other image is dropped;
 * - classes are kept only when github-markdown-css styles them, so content
 *   can't borrow the app's own (Tailwind) classes to restyle the page.
 */

const ALLOWED_TAGS = [
	"a",
	"abbr",
	"b",
	"bdi",
	"bdo",
	"blockquote",
	"br",
	"caption",
	"cite",
	"code",
	"dd",
	"del",
	"details",
	"dfn",
	"div",
	"dl",
	"dt",
	"em",
	"figcaption",
	"figure",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"img",
	"input",
	"ins",
	"kbd",
	"li",
	"mark",
	"ol",
	"p",
	"picture",
	"pre",
	"q",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"section",
	"small",
	"span",
	"strike",
	"strong",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"tt",
	"u",
	"ul",
	"var",
	"wbr",
	// GitHub's octicons (alerts, heading anchors).
	"svg",
	"path",
];

const ALLOWED_ATTR = [
	"href",
	"src",
	"alt",
	"title",
	"width",
	"height",
	"align",
	"valign",
	"class",
	"type",
	"checked",
	"disabled",
	"open",
	"colspan",
	"rowspan",
	"start",
	"reversed",
	"lang",
	"dir",
	"viewBox",
	"d",
	"fill-rule",
	"aria-hidden",
	"aria-label",
];

/** Classes github-markdown-css styles; every other class is dropped. */
const KEPT_CLASS =
	/^(octicon(-[a-z0-9-]+)?|markdown-alert(-[a-z]+)?|markdown-heading|heading-element|task-list-item(-checkbox)?|contains-task-list|highlight(-[a-z0-9-]+)?|pl-[a-z0-9]+|emoji|footnotes|data-footnote-backref|csv-data|absent|mr-2)$/;

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function absoluteUrl(value: string | null): URL | undefined {
	if (!value) return undefined;
	try {
		// No base: relative URLs would resolve against carbonless itself.
		return new URL(value);
	} catch {
		return undefined;
	}
}

let purify: ReturnType<typeof DOMPurify> | undefined;

function getPurify() {
	purify ??= DOMPurify(window);
	return purify;
}

/** GitHub-rendered HTML made safe to put into `.markdown-body`. */
export function sanitizeGithubHtml(html: string): string {
	if (!html) return "";
	const body = getPurify().sanitize(html, {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		RETURN_DOM: true,
	}) as HTMLElement;

	for (const el of body.querySelectorAll("[class]")) {
		const kept = [...el.classList].filter((c) => KEPT_CLASS.test(c));
		if (kept.length) el.setAttribute("class", kept.join(" "));
		else el.removeAttribute("class");
	}
	for (const a of body.querySelectorAll("a")) {
		// Heading anchors point into GitHub's page; they lead nowhere here.
		if (a.getAttribute("href")?.startsWith("#") && !a.textContent?.trim()) {
			a.remove();
			continue;
		}
		const url = absoluteUrl(a.getAttribute("href"));
		if (url && LINK_PROTOCOLS.has(url.protocol)) {
			a.setAttribute("href", url.href);
			a.setAttribute("target", "_blank");
			a.setAttribute("rel", "noreferrer noopener");
		} else {
			a.removeAttribute("href");
		}
	}
	for (const img of body.querySelectorAll("img")) {
		const url = absoluteUrl(img.getAttribute("src"));
		if (url?.protocol !== "https:") {
			img.remove();
			continue;
		}
		img.setAttribute("src", url.href);
		img.setAttribute("referrerpolicy", "no-referrer");
		// Not lazy: private-repo images are signed URLs that expire in minutes.
	}
	for (const input of body.querySelectorAll("input")) {
		// Task-list checkboxes show state; nothing else is an input here.
		if (input.getAttribute("type") !== "checkbox") input.remove();
		else input.setAttribute("disabled", "");
	}
	return body.innerHTML;
}
