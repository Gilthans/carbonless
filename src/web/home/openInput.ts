/**
 * What the open box's text asks for, read on every keystroke: a PR to open
 * at once (a URL, `owner/repo#n`, or a number after a chosen repo), a title
 * search inside a repo (`owner/repo ` and words), or free text.
 */
export type OpenInput =
	| { kind: "pr"; owner: string; repo: string; number: number }
	| { kind: "scoped"; repo: string; words: string }
	| { kind: "text"; text: string };

const NAME = "[A-Za-z0-9][A-Za-z0-9-]*";
const REPO = "[A-Za-z0-9._-]+";

const URL_RE = new RegExp(
	`^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${REPO})/pull/(\\d+)(?:[/?#].*)?$`,
	"i",
);
const HASH_RE = new RegExp(`^(${NAME})/(${REPO})#(\\d+)$`);
const SCOPED_RE = new RegExp(`^(${NAME})/(${REPO})\\s+(.*)$`, "s");

export function parseOpenInput(input: string): OpenInput {
	const text = input.trimStart();
	const trimmed = text.trim();
	const pr = (owner = "", repo = "", n = "0"): OpenInput => ({
		kind: "pr",
		owner,
		repo,
		number: Number(n),
	});
	const url = URL_RE.exec(trimmed);
	if (url) return pr(url[1], url[2], url[3]);
	const hash = HASH_RE.exec(trimmed);
	if (hash) return pr(hash[1], hash[2], hash[3]);
	const scoped = SCOPED_RE.exec(text);
	if (scoped) {
		const [, owner = "", repo = "", rest = ""] = scoped;
		const words = rest.trim();
		const number = /^#?(\d+)$/.exec(words);
		if (number) return pr(owner, repo, number[1]);
		return { kind: "scoped", repo: `${owner}/${repo}`, words };
	}
	return { kind: "text", text: trimmed };
}
