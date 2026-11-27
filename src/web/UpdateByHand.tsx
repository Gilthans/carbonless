import { QuestionIcon } from "@primer/octicons-react";
import type { UpdateInfo } from "../shared/update";
import { Tooltip } from "./Tooltip";

/** The FAQ on GitHub: crb has no docs site, and the repo is public. */
const FAQ_URL =
	"https://github.com/Gilthans/carbonless/blob/master/docs/faq.md";

/**
 * docs/faq.md's sections on updating by hand, as GitHub anchors its
 * headings (githubSlug; UpdateByHand.test.ts checks each is there).
 */
export const BY_HAND_FAQ = {
	top: "why-does-crb-show-an-update-command-instead-of-an-update-button",
	"no-install": "not-an-npm-or-pnpm-global-install",
	"not-writable": "installed-in-a-folder-crb-cant-write",
	systemd: "systemd-wont-restart-crb",
	pid1: "crb-is-a-containers-pid-1",
} as const;

/** A heading's anchor as GitHub makes it. */
export function githubSlug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, "")
		.replace(/ /g, "-");
}

/**
 * docs/faq.md's heading anchors as GitHub makes them: none inside fenced
 * code, a repeated one numbered (`-1`, `-2`).
 */
export function faqSlugs(markdown: string): string[] {
	const seen = new Map<string, number>();
	const slugs: string[] = [];
	let fence: string | null = null;
	for (const line of markdown.split("\n")) {
		const f = /^\s*(```|~~~)/.exec(line)?.[1];
		if (f) {
			if (fence === null) fence = f;
			else if (fence === f) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const heading = /^#{1,6} (.*)$/.exec(line)?.[1];
		if (heading === undefined) continue;
		const slug = githubSlug(heading);
		const n = seen.get(slug) ?? 0;
		seen.set(slug, n + 1);
		slugs.push(n === 0 ? slug : `${slug}-${n}`);
	}
	return slugs;
}

type Why = Pick<UpdateInfo, "byHandReason" | "byHandManager">;

/**
 * Why crb can't update itself, and the FAQ section on setting it up so it
 * can: the toast and the Global settings page both read it here, so they
 * never disagree. `text` is a few words that fit a phone; `detail` adds
 * what the line leaves out (a service's unit name), for the tooltip.
 * null: crb updates itself.
 */
export function byHandWhy(
	info: Why,
): { text: string; detail: string; href: string } | null {
	const at = (anchor: string) => `${FAQ_URL}#${anchor}`;
	const plain = (text: string, anchor: string) => ({
		text,
		detail: text,
		href: at(anchor),
	});
	switch (info.byHandReason) {
		case null:
			return null;
		case "no-install":
			return plain("not an npm/pnpm global install", BY_HAND_FAQ["no-install"]);
		case "not-writable":
			return plain(
				"installed in a folder crb can't write",
				BY_HAND_FAQ["not-writable"],
			);
		case "service": {
			const manager = info.byHandManager;
			if (manager === "PID 1") {
				return plain("crb is PID 1, nothing restarts it", BY_HAND_FAQ.pid1);
			}
			if (manager?.startsWith("systemd")) {
				return {
					text: "systemd won't restart crb",
					detail: `${manager} won't restart crb`,
					href: at(BY_HAND_FAQ.systemd),
				};
			}
			return {
				text: "its service won't restart crb",
				detail: `${manager ?? "its service"} won't restart crb`,
				href: at(BY_HAND_FAQ.top),
			};
		}
	}
}

/**
 * "<prefix>: <why>", wrapping rather than cut off on a phone, and a help
 * icon linking to the FAQ. A detail the line leaves out (a unit name) is
 * in its tooltip, which a tap or a key opens, and its description.
 */
export function ByHandWhy(props: {
	info: Why;
	prefix: string;
	className?: string;
}) {
	const why = byHandWhy(props.info);
	if (!why) return null;
	const line = `${props.prefix}: ${why.text}`;
	const full = `${props.prefix}: ${why.detail}`;
	// At least 40px tall: a tap target when it opens a tip.
	const textClass =
		"flex min-h-10 min-w-0 items-center rounded-sm [overflow-wrap:anywhere]";
	return (
		<span
			data-testid="update-by-hand"
			className={`flex min-w-0 items-center gap-1 ${props.className ?? ""}`}
		>
			{full === line ? (
				<span data-testid="update-by-hand-text" className={textClass}>
					{line}
				</span>
			) : (
				<Tooltip content={full}>
					{(trigger) => (
						<span
							{...trigger}
							data-testid="update-by-hand-text"
							// Focusable so a tap or a key opens the detail.
							// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
							tabIndex={0}
							className={`${textClass} cursor-help focus-visible:outline-2 focus-visible:outline-accent`}
						>
							{line}
						</span>
					)}
				</Tooltip>
			)}
			<Tooltip content="How to set up updates" describe={false}>
				{(trigger) => (
					<a
						{...trigger}
						href={why.href}
						target="_blank"
						rel="noreferrer"
						aria-label="How to set up updates"
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-link hover:bg-pressed focus-visible:outline-2 focus-visible:outline-accent"
					>
						<QuestionIcon size={16} aria-hidden />
					</a>
				)}
			</Tooltip>
		</span>
	);
}
