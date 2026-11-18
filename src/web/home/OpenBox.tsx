import {
	GitMergeIcon,
	GitPullRequestClosedIcon,
	RepoIcon,
	SearchIcon,
	SyncIcon,
} from "@primer/octicons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
	type KeyboardEvent,
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { SearchResult } from "../../shared/home";
import { RelativeTime } from "../RelativeTime";
import { useShortcut, useShortcutHelp } from "../shortcuts";
import { goTo, prPath, searchQuery } from "./homeApi";
import { parseOpenInput } from "./openInput";
import { Avatar, Sign } from "./PrRow";
import {
	DEBOUNCE_MS,
	type SuggestionGroup,
	SuggestionList,
	stillComing,
	useDebounced,
	useSuggestionKeys,
} from "./Suggestions";

type Pr = SearchResult["prs"][number];
type Option =
	| { kind: "repo"; repo: SearchResult["repos"][number] }
	// `numbered`: a bare number's row, its repo up front (the group says the number).
	| { kind: "pr"; pr: Pr; numbered?: boolean }
	| { kind: "open"; owner: string; repo: string; number: number };

type Group = SuggestionGroup<Option>;

const HELP = [
	{ keys: "Escape", label: "Close the list", group: "Home" as const },
	{ keys: "ArrowDown", label: "Next suggestion", group: "Home" as const },
	{ keys: "ArrowUp", label: "Previous suggestion", group: "Home" as const },
	{ keys: "Enter", label: "Open the suggestion", group: "Home" as const },
	{ keys: "Tab", label: "Complete a repo", group: "Home" as const },
];

/** The title with the typed words bolded (in any order, any case). */
function Marked({ text, words }: { text: string; words: string[] }) {
	const ws = words.filter(Boolean).map((w) => w.toLowerCase());
	if (ws.length === 0) return <>{text}</>;
	const escaped = ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
	return (
		<>
			{parts.map((p, i) =>
				ws.includes(p.toLowerCase()) ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixed split.
					<mark key={i} className="bg-transparent font-semibold text-link">
						{p}
					</mark>
				) : (
					p
				),
			)}
		</>
	);
}

function groupsOf(
	q: string,
	data: SearchResult | undefined,
): { groups: Group[]; words: string[] } {
	const parsed = parseOpenInput(q);
	if (parsed.kind === "pr") {
		return {
			groups: [{ label: "Open", options: [{ ...parsed, kind: "open" }] }],
			words: [],
		};
	}
	if (!data || !q.trim()) return { groups: [], words: [] };
	// A bare number shows only its own answer: an older text's (kept while
	// the new one comes) could open another number's PR on Enter.
	const numbered =
		parsed.kind === "number" && data.numbered?.number === parsed.number
			? data.numbered
			: undefined;
	if (parsed.kind === "number" && !numbered) return { groups: [], words: [] };
	const words = (parsed.kind === "scoped" ? parsed.words : parsed.text).split(
		/\s+/,
	);
	const prs: Option[] = data.prs.map((pr) => ({ kind: "pr", pr }));
	if (data.scope) {
		const rest = parsed.kind === "scoped" ? parsed.words : "";
		return {
			groups: [
				{
					label: `${data.scope} · ${rest ? `"${rest}"` : "latest activity"}`,
					options: prs,
					loading: data.pending && !data.error,
				},
			],
			words,
		};
	}
	const groups: Group[] = [];
	const numberPending = !!numbered?.pending && !data.error;
	if (numbered && (numbered.prs.length > 0 || numberPending)) {
		groups.push({
			label: `#${numbered.number}`,
			options: numbered.prs.map((pr) => ({ kind: "pr", pr, numbered: true })),
			loading: numberPending,
		});
	}
	if (data.repos.length > 0 || data.reposPending) {
		groups.push({
			label: "Repos",
			options: data.repos.map((repo) => ({ kind: "repo", repo })),
			loading: data.reposPending,
		});
	}
	// Title matches wait for the number's PRs: Enter never takes one while
	// the PR typed may still come, and none moves when it does.
	if (prs.length > 0 && !numberPending)
		groups.push({ label: "Pull requests", options: prs });
	return { groups, words };
}

/** An option's identity across answers. */
const keyOf = (o: Option | undefined): string | null =>
	!o
		? null
		: o.kind === "repo"
			? `repo:${o.repo.name}`
			: o.kind === "pr"
				? `pr:${o.pr.owner}/${o.pr.repo}#${o.pr.number}`
				: `open:${o.owner}/${o.repo}#${o.number}`;

const STATE_ICON: Record<Pr["state"], ReactNode> = {
	OPEN: null,
	MERGED: (
		<Sign label="Merged" className="text-done">
			<GitMergeIcon size={12} aria-hidden />
		</Sign>
	),
	CLOSED: (
		<Sign label="Closed" className="text-bad">
			<GitPullRequestClosedIcon size={12} aria-hidden />
		</Sign>
	),
};

/**
 * Open any PR from one box: a pasted URL or `owner/repo#n` opens at once;
 * a bare number lists that PR in each of the view's and recent reviews'
 * repos; other text searches repos and PR titles together; a repo chosen with Tab
 * or Enter fills `owner/repo ` and lists its PRs, ready for title words.
 * An ARIA combobox: arrows move, Enter picks, Escape closes, `/` focuses.
 */
export function OpenBox(props: { className?: string }) {
	const [q, setQ] = useState("");
	const [open, setOpen] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const listId = useId();
	const optionId = useId();
	const parsed = parseOpenInput(q);
	const debounced = useDebounced(q, DEBOUNCE_MS);
	const search = useQuery({
		...searchQuery(debounced),
		enabled: parsed.kind !== "pr" && debounced.trim() !== "",
		placeholderData: keepPreviousData,
	});
	useShortcut({
		keys: "/",
		label: "Open a pull request",
		group: "Home",
		run: () => {
			input.current?.focus();
			setOpen(true);
		},
	});
	useShortcutHelp(HELP);

	const { groups, words } = groupsOf(q, search.data);
	const options = groups.flatMap((g) => g.options);
	// A failed GitHub search: said in the list, and nothing is pending.
	const error = parsed.kind !== "pr" ? search.data?.error : undefined;
	const coming =
		parsed.kind !== "pr" && stillComing(q.trim(), debounced.trim(), search);
	const pending =
		parsed.kind !== "pr" && (coming || (!!search.data?.pending && !error));
	const reposPending = pending && !!search.data?.reposPending;
	// Nothing found, and nothing still coming: the list says so.
	const none = !pending && !error && !!search.data && options.length === 0;
	// While the first answer for what's typed is coming, the box's own
	// spinner says so; the list opens with something to show.
	const listOpen =
		open &&
		q.trim() !== "" &&
		(options.length > 0 || (pending && !coming) || !!error || none);
	const keys = useSuggestionKeys({
		count: options.length,
		listOpen,
		onOpen: () => setOpen(true),
		onClose: () => setOpen(false),
	});
	const current = keys.current;
	// Rows that come in for the same text (a pending group filling in above)
	// keep the highlight on its option, never on whatever moved under it.
	// Before paint, so Enter never sees the moved index.
	const sig = options.map(keyOf).join("\n");
	const seen = useRef<{ q: string; sig: string; key: string | null }>({
		q: "",
		sig: "",
		key: null,
	});
	useLayoutEffect(() => {
		const before = seen.current;
		if (before.q === q && before.sig !== sig && before.key !== null) {
			const i = options.findIndex((o) => keyOf(o) === before.key);
			if (i >= 0 && i !== current) {
				seen.current = { q, sig, key: before.key };
				keys.setActive(i);
				return;
			}
		}
		seen.current = { q, sig, key: keyOf(options[current]) };
	});

	const choose = (option: Option | undefined) => {
		if (!option) return;
		if (option.kind === "repo") {
			setQ(`${option.repo.name} `);
			keys.reset();
			setOpen(true);
			input.current?.focus();
			return;
		}
		goTo(prPath(option.kind === "pr" ? option.pr : option));
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (keys.onKeyDown(e)) return;
		if (e.key === "Enter") {
			e.preventDefault();
			if (parsed.kind === "pr") choose(options[0]);
			else if (listOpen) choose(options[current]);
		} else if (e.key === "Tab" && !e.shiftKey) {
			const option = options[current];
			if (listOpen && option?.kind === "repo") {
				e.preventDefault();
				choose(option);
			}
		}
	};

	return (
		<div className={`relative min-w-0 ${props.className ?? ""}`}>
			<search>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (parsed.kind === "pr") choose(options[0]);
						else choose(options[current]);
					}}
					className="flex h-10 overflow-hidden rounded-lg border border-line-strong bg-code focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/25"
				>
					<SearchIcon
						aria-hidden
						className="my-auto ml-3 shrink-0 text-faint"
					/>
					<input
						ref={input}
						role="combobox"
						aria-label="Open a pull request"
						aria-autocomplete="list"
						aria-expanded={listOpen}
						aria-controls={listId}
						aria-activedescendant={
							listOpen && options.length > 0
								? `${optionId}-${current}`
								: undefined
						}
						placeholder="PR URL, #123 or search"
						value={q}
						onChange={(e) => {
							setQ(e.target.value);
							keys.reset();
							setOpen(true);
						}}
						onFocus={() => setOpen(true)}
						onBlur={() => setOpen(false)}
						onKeyDown={onKeyDown}
						autoComplete="off"
						spellCheck={false}
						className="min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-faint"
					/>
					{/* Always mounted, so a screen reader hears it start; as wide
					    as its spinner, so the input never narrows when it spins. */}
					<span
						role="status"
						className="my-auto mr-2 flex w-3 shrink-0 items-center text-faint"
					>
						{pending && (
							<>
								<SyncIcon
									size={12}
									aria-hidden
									className="animate-spin motion-reduce:animate-none"
								/>
								<span className="sr-only">
									{reposPending ? "Loading your repos" : "Searching GitHub"}
								</span>
							</>
						)}
					</span>
					<button
						type="submit"
						className="cta shrink-0 px-3.5 text-sm font-semibold text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
					>
						Open
					</button>
				</form>
			</search>
			{listOpen && (
				<SuggestionList
					listId={listId}
					optionId={optionId}
					groups={groups}
					current={current}
					onChoose={choose}
					onHover={keys.setActive}
					error={error}
					empty="No matches"
					className="absolute inset-x-0 top-full z-40 mt-1"
					render={(option, selected) => (
						<OptionBody option={option} words={words} selected={selected} />
					)}
				/>
			)}
		</div>
	);
}

function OptionBody(props: {
	option: Option;
	words: string[];
	selected: boolean;
}) {
	const { option, words } = props;
	if (option.kind === "repo") {
		const { repo } = option;
		return (
			<>
				<RepoIcon size={14} aria-hidden className="shrink-0 text-muted" />
				<span className="min-w-0 flex-1 truncate">
					<Marked text={repo.name} words={words} />
				</span>
				<span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted">
					{repo.inView
						? repo.openCount !== null && `${repo.openCount} open`
						: "not in view"}
					{props.selected && (
						<kbd className="hidden rounded border border-edge px-1 sm:inline">
							Tab
						</kbd>
					)}
				</span>
			</>
		);
	}
	if (option.kind === "open") {
		return (
			<span className="min-w-0 flex-1 truncate">
				{option.owner}/{option.repo}
				<span className="text-muted">#{option.number}</span>
			</span>
		);
	}
	const { pr } = option;
	return (
		<>
			{option.numbered ? (
				<span className="max-w-[45%] shrink-0 truncate text-muted">
					{pr.owner}/{pr.repo}
				</span>
			) : (
				<span className="shrink-0 text-muted tabular-nums">#{pr.number}</span>
			)}
			<span className="min-w-0 flex-1 truncate">
				<Marked text={pr.title} words={words} />
			</span>
			{pr.hidden && (
				<span className="shrink-0 rounded border border-edge px-1 text-xs text-muted">
					{pr.hidden}
				</span>
			)}
			<span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted">
				{!option.numbered && (
					<span className="hidden sm:inline">
						{pr.owner}/{pr.repo}
					</span>
				)}
				{STATE_ICON[pr.state]}
				<Avatar person={pr.author} size={16} />
				<RelativeTime iso={pr.updatedAt} />
			</span>
		</>
	);
}
