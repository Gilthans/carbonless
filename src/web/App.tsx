import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { overviewQuery, postRefresh, reviewQuery, sessionQuery } from "./api";
import { ErrorMessage, safeHref } from "./ui";

const tabClass =
	"-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-600";
const activeTabClass = "border-orange-500 font-semibold text-slate-900";

/** Layout: PR header, tabs and the current page. */
export function App() {
	const queryClient = useQueryClient();
	const session = useQuery(sessionQuery);
	const refresh = useMutation({
		mutationFn: postRefresh,
		onSuccess: (info) => {
			queryClient.setQueryData(sessionQuery.queryKey, info);
			return Promise.all([
				queryClient.invalidateQueries({ queryKey: overviewQuery.queryKey }),
				queryClient.invalidateQueries({ queryKey: reviewQuery.queryKey }),
			]);
		},
	});
	const pr = session.data?.pr;
	const prUrl = safeHref(pr?.url);

	return (
		<div className="min-h-screen bg-white font-sans text-slate-900">
			<header className="border-b border-slate-200 bg-slate-50">
				<div className="mx-auto flex max-w-5xl items-start gap-4 px-6 pt-6 pb-3">
					<div className="min-w-0 flex-1">
						{session.isPending && <p className="text-slate-500">Loading…</p>}
						{session.isError && <ErrorMessage error={session.error} />}
						{pr && (
							<div className="flex flex-wrap items-baseline gap-x-2">
								<h1 className="text-2xl font-semibold break-words">
									{pr.title}
								</h1>
								<span className="text-2xl text-slate-500">
									{prUrl ? (
										<a href={prUrl} className="hover:underline">
											#{pr.number}
										</a>
									) : (
										`#${pr.number}`
									)}
								</span>
							</div>
						)}
						{pr && (
							<p className="mt-1 text-sm text-slate-600">
								{pr.owner}/{pr.repo}
							</p>
						)}
					</div>
					<button
						type="button"
						onClick={() => refresh.mutate()}
						disabled={refresh.isPending}
						className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-60"
					>
						{refresh.isPending ? "Refreshing…" : "Refresh"}
					</button>
				</div>
				{refresh.isError && (
					<div className="mx-auto max-w-5xl px-6 pb-2">
						<ErrorMessage error={refresh.error} />
					</div>
				)}
				{/* Task 10: the moved-head banner goes here. */}
				<nav
					aria-label="PR pages"
					className="mx-auto flex max-w-5xl gap-1 px-6"
				>
					<Link
						to="/"
						activeOptions={{ exact: true }}
						className={tabClass}
						activeProps={{ className: activeTabClass }}
					>
						Overview
					</Link>
					<Link
						to="/files"
						className={tabClass}
						activeProps={{ className: activeTabClass }}
					>
						Files changed
					</Link>
				</nav>
			</header>
			<main className="mx-auto max-w-5xl px-6 py-6">
				<Outlet />
			</main>
		</div>
	);
}
