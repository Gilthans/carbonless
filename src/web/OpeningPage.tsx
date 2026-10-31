import { SyncIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import {
	Link,
	useNavigate,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { ApiError, fetchJson } from "./api";
import { Logo } from "./brand/Brand";
import { NotFound, notFoundReason } from "./router";
import { Tooltip } from "./Tooltip";
import { ErrorMessage } from "./ui";

/**
 * The PR's title as Home last read it: the server's `crb-pr-title` meta on
 * a `/pr/...` page; null when it doesn't know the PR.
 */
export function prTitleMeta(doc: Document = document): string | null {
	return (
		doc.querySelector('meta[name="crb-pr-title"]')?.getAttribute("content") ??
		null
	);
}

/** `/pr/...`'s search: `?head=` pins the review to a head. */
export function parseOpeningSearch(search: Record<string, unknown>): {
	head?: string;
} {
	return typeof search.head === "string" ? { head: search.head } : {};
}

/** The statuses whose message says why the PR can't be opened. */
const REFUSED = [400, 404, 409, 410];

/**
 * `/pr/<owner>/<repo>/<n>`: the review page's frame at once, loading,
 * while the server opens the review (a clone can take a while); then that
 * review, in place of this page (Back returns to where the reviewer came
 * from). A PR that can't be opened says why here.
 */
export function OpeningPage() {
	const { owner, repo, number } = useParams({
		from: "/pr/$owner/$repo/$number",
	});
	const { head } = useSearch({ from: "/pr/$owner/$repo/$number" });
	const navigate = useNavigate();
	const refused = notFoundReason();
	const pr = `${owner}/${repo}#${number}`;
	// One ask per address, however often the page mounts (the server joins
	// opens of one PR too).
	const open = useQuery({
		queryKey: ["open-review", pr, head ?? null],
		queryFn: () =>
			fetchJson<{ id: string }>("/api/reviews", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(head === undefined ? { pr } : { pr, head }),
			}),
		enabled: refused === null,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});
	const id = open.data?.id;
	useEffect(() => {
		if (id) void navigate({ to: "/r/$id", params: { id }, replace: true });
	}, [id, navigate]);
	const title = prTitleMeta();
	const error = open.error;
	const why =
		refused ??
		(error instanceof ApiError && REFUSED.includes(error.status)
			? error.message
			: null);
	return (
		<div className="min-h-screen bg-canvas font-sans text-ink">
			<header className="border-b border-line bg-surface header-glow">
				<div className="mx-auto max-w-5xl px-4 pt-3 pb-3 sm:px-6 sm:pt-4">
					<div
						data-testid="opening"
						className="flex items-center gap-2 sm:gap-3"
					>
						<Tooltip content="Home" describe={false}>
							{(trigger) => (
								<Link
									{...trigger}
									to="/"
									aria-label="Home"
									className="-my-1.5 shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-accent"
								>
									<Logo className="h-11 w-11 sm:h-12 sm:w-12" />
								</Link>
							)}
						</Tooltip>
						<div className="min-w-0">
							<div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
								<h1 className="font-display text-xl font-bold tracking-tight break-words sm:text-2xl">
									{title ?? `${owner}/${repo}`}
								</h1>
								<span className="font-display text-xl text-muted sm:text-2xl">
									#{number}
								</span>
							</div>
							{title !== null && (
								<p className="mt-1 text-sm break-all text-muted">
									{owner}/{repo}
								</p>
							)}
						</div>
					</div>
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
				{why !== null ? (
					<NotFound reason={why} />
				) : error ? (
					<ErrorMessage error={error} />
				) : (
					<p
						role="status"
						className="flex items-center gap-2 text-sm text-muted"
					>
						<SyncIcon
							aria-hidden
							className="animate-spin motion-reduce:animate-none"
						/>
						Opening…
					</p>
				)}
			</main>
		</div>
	);
}
