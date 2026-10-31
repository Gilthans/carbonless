import { PlusIcon, RepoIcon, XIcon } from "@primer/octicons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { HomeView } from "../../shared/home";
import { NOT_PHONE, useMedia } from "../useMedia";
import { searchQuery } from "./homeApi";
import {
	DEBOUNCE_MS,
	SuggestionList,
	useDebounced,
	useSuggestionKeys,
} from "./Suggestions";

/**
 * A repo as the view lists it, "owner/repo" lowercased, from that or a
 * GitHub URL (of the repo or anything in it); null for anything else.
 */
export function parseRepo(input: string): string | null {
	let text = input.trim();
	const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(text);
	if (url?.[1]) text = url[1];
	const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(
		text,
	);
	if (!m?.[1] || !m[2]) return null;
	// Only a URL may carry more than owner/repo.
	if (!url && /[/?#]/.test(text.slice(m[1].length + m[2].length + 1))) {
		return null;
	}
	return `${m[1]}/${m[2]}`.toLowerCase();
}

/** Repos of the reviewer's started reviews that the view doesn't list. */
export function suggestedRepos(home: HomeView): string[] {
	const inView = new Set(home.view.repos.map((r) => r.toLowerCase()));
	const out: string[] = [];
	for (const s of home.sections) {
		for (const r of s.rows) {
			const name = `${r.owner}/${r.repo}`.toLowerCase();
			if (r.reviews.length > 0 && !inView.has(name) && !out.includes(name)) {
				out.push(name);
			}
		}
	}
	return out;
}

const iconButton =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";

/**
 * The view's repos: remove, add by owner/repo or URL, suggestions from
 * recent reviews. Save hands the list to `onSave` and closes: Home shows
 * the new view at once while it saves (viewSave.tsx). A centered dialog, a
 * bottom sheet on a phone.
 */
export function ViewSettings(props: {
	open: boolean;
	home: HomeView;
	onSave: (repos: string[]) => void;
	onClose: () => void;
}) {
	const { home } = props;
	const phone = !useMedia(NOT_PHONE);
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const [repos, setRepos] = useState(home.view.repos);
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (!props.open) {
			if (d.hasAttribute("open")) {
				if (typeof d.close === "function") d.close();
				else d.removeAttribute("open");
			}
			return;
		}
		setRepos(home.view.repos);
		if (d.hasAttribute("open")) return;
		if (typeof d.showModal === "function") d.showModal();
		else d.setAttribute("open", "");
	}, [props.open, home.view.repos]);
	// A hand-edited config may say Acme/API: repos compare without case.
	const listed = (name: string) =>
		repos.some((r) => r.toLowerCase() === name.toLowerCase());
	const add = (name: string) => {
		if (!listed(name)) setRepos([...repos, name]);
	};
	const suggestions = suggestedRepos(home).filter((r) => !listed(r));
	return (
		<dialog
			ref={dialog}
			aria-labelledby={titleId}
			onClose={props.onClose}
			onCancel={(e) => {
				e.preventDefault();
				props.onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					props.onClose();
				}
			}}
			onClick={(e) => {
				// A click on the backdrop lands on the dialog itself.
				if (e.target === dialog.current) props.onClose();
			}}
			className={
				phone
					? "m-0 mt-auto max-h-[85dvh] w-full max-w-none rounded-t-2xl border-t border-edge bg-surface p-0 text-ink shadow-sheet backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px]"
					: "m-auto w-[min(32rem,calc(100vw-2rem))] max-w-none rounded-xl border border-edge bg-surface p-0 text-ink shadow-float backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px]"
			}
		>
			<div className="flex items-center justify-between border-b border-line py-1 pr-1 pl-4">
				<h2 id={titleId} className="font-display text-base font-bold">
					{home.view.name}
				</h2>
				<button
					type="button"
					aria-label="Close"
					onClick={props.onClose}
					className={iconButton}
				>
					<XIcon aria-hidden />
				</button>
			</div>
			{props.open && (
				<div className="space-y-3 px-4 pt-3 pb-5">
					<ul
						aria-label="Repos in this view"
						className="overflow-hidden rounded-lg border border-line"
					>
						{repos.map((r) => (
							<li
								key={r}
								className="flex min-h-11 items-center gap-2.5 border-t border-line pl-3 text-sm text-ink-soft first:border-t-0"
							>
								<RepoIcon aria-hidden className="text-faint" />
								<span className="min-w-0 flex-1 truncate">{r}</span>
								<button
									type="button"
									aria-label={`Remove ${r}`}
									onClick={() => setRepos(repos.filter((x) => x !== r))}
									className={`${iconButton} hover:text-bad`}
								>
									<XIcon aria-hidden />
								</button>
							</li>
						))}
					</ul>
					<RepoInput listed={listed} onAdd={add} />
					{suggestions.length > 0 && (
						<ul aria-label="Suggested" className="flex flex-wrap gap-1.5">
							{suggestions.map((r) => (
								<li key={r}>
									<button
										type="button"
										aria-label={`Add ${r}`}
										onClick={() => add(r)}
										className="flex min-h-10 items-center gap-1.5 rounded-full border border-dashed border-edge px-3 text-sm text-muted hover:border-solid hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
									>
										<PlusIcon size={12} aria-hidden />
										{r}
									</button>
								</li>
							))}
						</ul>
					)}
					<div className="flex justify-end gap-1.5">
						<button
							type="button"
							onClick={props.onClose}
							className="h-10 rounded-md border border-edge px-3 text-sm text-ink-soft hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => {
								// Shut first: focus goes back to the pencil now, so the
								// save (HomePage) can close the tooltip that focus opens.
								const d = dialog.current;
								if (d?.hasAttribute("open")) {
									if (typeof d.close === "function") d.close();
									else d.removeAttribute("open");
								}
								props.onSave(repos);
								props.onClose();
							}}
							className="cta flex h-10 items-center gap-1.5 rounded-md px-4 text-sm font-semibold text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
						>
							Save
						</button>
					</div>
				</div>
			)}
		</dialog>
	);
}

/**
 * Add a repo: `owner/repo` or a URL, with the viewer's repos suggested as
 * you type (Home's search, its Repos group alone: the same source and
 * matching as the open box). Arrows pick one, Enter or a click adds it;
 * Enter with none picked adds what was typed.
 */
function RepoInput(props: {
	listed: (name: string) => boolean;
	onAdd: (name: string) => void;
}) {
	const [input, setInput] = useState("");
	const [bad, setBad] = useState(false);
	const [open, setOpen] = useState(false);
	const listId = useId();
	const optionId = useId();
	const q = input.trim();
	const debounced = useDebounced(q, DEBOUNCE_MS);
	const search = useQuery({
		...searchQuery(debounced, "repos"),
		enabled: debounced !== "",
		placeholderData: keepPreviousData,
	});
	const data = q === "" ? undefined : search.data;
	const options = (data?.repos ?? [])
		.map((r) => r.name)
		.filter((name) => !props.listed(name));
	const loading = !!data?.reposPending;
	const listOpen = open && (options.length > 0 || loading);
	const keys = useSuggestionKeys({
		count: options.length,
		listOpen,
		// What was typed comes first: a suggestion only once picked.
		autoSelect: false,
		onOpen: () => setOpen(true),
		onClose: () => setOpen(false),
	});
	const done = (name: string) => {
		props.onAdd(name);
		setInput("");
		setBad(false);
		keys.reset();
	};
	const submit = () => {
		const picked = listOpen ? options[keys.current] : undefined;
		if (picked) return done(picked);
		const name = parseRepo(input);
		if (!name) {
			setBad(true);
			return;
		}
		done(name);
	};
	return (
		<div>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
				className="flex gap-1.5"
			>
				<input
					role="combobox"
					aria-label="Add a repo"
					aria-autocomplete="list"
					aria-expanded={listOpen}
					aria-controls={listId}
					aria-activedescendant={
						listOpen && keys.current >= 0
							? `${optionId}-${keys.current}`
							: undefined
					}
					aria-invalid={bad || undefined}
					placeholder="owner/repo or GitHub URL"
					value={input}
					onChange={(e) => {
						setInput(e.target.value);
						setBad(false);
						setOpen(true);
						keys.reset();
					}}
					onFocus={() => setOpen(true)}
					onBlur={() => setOpen(false)}
					onKeyDown={(e) => {
						keys.onKeyDown(e);
					}}
					autoComplete="off"
					spellCheck={false}
					className="h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-code px-2.5 text-sm text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-accent aria-invalid:border-bad"
				/>
				<button
					type="submit"
					aria-label="Add"
					className={`${iconButton} border border-edge`}
				>
					<PlusIcon aria-hidden />
				</button>
			</form>
			{listOpen && (
				<SuggestionList
					listId={listId}
					optionId={optionId}
					groups={[{ label: "Repos", options, loading }]}
					current={keys.current}
					onChoose={done}
					onHover={keys.setActive}
					className="mt-1 max-h-60"
					render={(name) => (
						<>
							<RepoIcon size={14} aria-hidden className="shrink-0 text-muted" />
							<span className="min-w-0 flex-1 truncate">{name}</span>
						</>
					)}
				/>
			)}
		</div>
	);
}
