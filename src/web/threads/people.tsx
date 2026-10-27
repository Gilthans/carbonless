import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, use, useMemo, useState } from "react";
import type { ReviewThread } from "../../shared/types";
import { sessionQuery } from "../api";
import { safeHref } from "../ui";

/**
 * Each person's tint, as whole Tailwind classes (so the build sees them):
 * their comments' wash and border, the fade at a clipped comment's foot,
 * and their avatar's fallback. Tokens in index.css (`person-N`).
 */
export const TINTS = [
	{
		surface: "border-person-1-edge bg-person-1",
		fade: "to-person-1",
		fill: "bg-person-1-edge",
	},
	{
		surface: "border-person-2-edge bg-person-2",
		fade: "to-person-2",
		fill: "bg-person-2-edge",
	},
	{
		surface: "border-person-3-edge bg-person-3",
		fade: "to-person-3",
		fill: "bg-person-3-edge",
	},
	{
		surface: "border-person-4-edge bg-person-4",
		fade: "to-person-4",
		fill: "bg-person-4-edge",
	},
	{
		surface: "border-person-5-edge bg-person-5",
		fade: "to-person-5",
		fill: "bg-person-5-edge",
	},
	{
		surface: "border-person-6-edge bg-person-6",
		fade: "to-person-6",
		fill: "bg-person-6-edge",
	},
	{
		surface: "border-person-7-edge bg-person-7",
		fade: "to-person-7",
		fill: "bg-person-7-edge",
	},
	{
		surface: "border-person-8-edge bg-person-8",
		fade: "to-person-8",
		fill: "bg-person-8-edge",
	},
] as const;

/** Who is who across a PR's threads: a tint each, and their avatars. */
export interface People {
	/** Tint index by lowercased login. */
	tints: ReadonlyMap<string, number>;
	/** Avatar URL by lowercased login, from any thread they spoke in. */
	avatars: ReadonlyMap<string, string>;
}

const key = (login: string) => login.toLowerCase();

const timeOf = (at: string) => {
	const ms = Date.parse(at);
	return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

/**
 * A tint per person, the same in every thread of the PR: in the order
 * they first spoke anywhere in it (ties in the threads' and their
 * comments' order), so nobody shares one until the palette runs out, and
 * then it starts over. Someone new only ever speaks last, so a new
 * comment never moves anyone else's tint. The viewer, if they haven't
 * spoken yet, comes after everyone (their reply gets its tint at once).
 */
export function assignPeople(
	threads: readonly Pick<ReviewThread, "participants">[],
	viewer?: string,
): People {
	const spoke = threads.flatMap((t, ti) =>
		t.participants.map((p, pi) => ({ ...p, ti, pi, ms: timeOf(p.at) })),
	);
	spoke.sort((a, b) => a.ms - b.ms || a.ti - b.ti || a.pi - b.pi);
	const tints = new Map<string, number>();
	const avatars = new Map<string, string>();
	const add = (login: string) => {
		const k = key(login);
		if (k && !tints.has(k)) tints.set(k, tints.size % TINTS.length);
	};
	for (const p of spoke) {
		add(p.login);
		const k = key(p.login);
		if (p.avatarUrl && !avatars.has(k)) avatars.set(k, p.avatarUrl);
	}
	if (viewer) add(viewer);
	return { tints, avatars };
}

/** A login's place in the palette when no thread lists them: by its letters. */
export function hashTint(login: string): number {
	let h = 0;
	for (const ch of key(login)) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
	return h % TINTS.length;
}

/** `login`'s tint and avatar among `people` (the given URL first). */
export function personOf(
	people: People,
	login: string,
	url?: string,
): { tint: number; avatarUrl: string } {
	const k = key(login);
	return {
		tint: people.tints.get(k) ?? hashTint(login),
		avatarUrl: url || people.avatars.get(k) || "",
	};
}

const EMPTY: People = { tints: new Map(), avatars: new Map() };
const PeopleContext = createContext<People>(EMPTY);

/** Gives everything under it the PR's people, from all its threads. */
export function PeopleProvider(props: {
	threads: readonly ReviewThread[] | undefined;
	children: ReactNode;
}) {
	const viewer = useQuery({ ...sessionQuery, enabled: false }).data?.viewer;
	const { threads } = props;
	const people = useMemo(
		() => (threads ? assignPeople(threads, viewer) : EMPTY),
		[threads, viewer],
	);
	return <PeopleContext value={people}>{props.children}</PeopleContext>;
}

/** `login`'s tint and avatar in this PR. */
export function usePerson(
	login: string,
	url?: string,
): { tint: number; avatarUrl: string } {
	return personOf(use(PeopleContext), login, url);
}

/** A person's surface classes: their wash and border. */
export function tintSurface(tint: number): string {
	return TINTS[tint % TINTS.length]?.surface ?? TINTS[0].surface;
}

/**
 * A person's round avatar, beside their name (so it says nothing itself:
 * `alt=""`): GitHub's image, lazy, at a fixed size; with none, or one that
 * fails, their initial on their tint.
 */
export function Avatar(props: {
	login: string;
	url?: string;
	/** 16 or 20 (px). */
	size?: 16 | 20;
}) {
	const { tint, avatarUrl } = usePerson(props.login, props.url);
	const src = safeHref(avatarUrl);
	const [broken, setBroken] = useState<string | null>(null);
	const size = props.size ?? 20;
	const box = size === 16 ? "h-4 w-4 text-[10px]" : "h-5 w-5 text-[11px]";
	if (src && broken !== src) {
		return (
			<img
				src={src}
				alt=""
				width={size}
				height={size}
				loading="lazy"
				referrerPolicy="no-referrer"
				data-testid="avatar"
				onError={() => setBroken(src)}
				className={`${box} shrink-0 rounded-full bg-overlay`}
			/>
		);
	}
	const initial = [...(props.login || "?")][0]?.toUpperCase() ?? "?";
	return (
		<span
			aria-hidden
			data-testid="avatar-fallback"
			data-tint={tint}
			// The initial is drawn, not text: names read and copy without it.
			data-initial={initial}
			className={`${box} inline-flex shrink-0 items-center justify-center rounded-full leading-none font-semibold text-ink before:content-[attr(data-initial)] ${TINTS[tint]?.fill ?? TINTS[0].fill}`}
		/>
	);
}
