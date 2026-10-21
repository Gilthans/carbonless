import { useQuery } from "@tanstack/react-query";
import type { CommitInfo } from "../shared/types";
import { fetchComparison } from "./api";

export function App() {
	const comparison = useQuery({
		queryKey: ["comparison"],
		queryFn: fetchComparison,
	});

	return (
		<main className="mx-auto max-w-4xl p-8 font-sans text-slate-900">
			<h1 className="text-2xl font-semibold">carbonless</h1>
			{comparison.isPending && <p className="mt-4 text-slate-500">Loading…</p>}
			{comparison.isError && (
				<p role="alert" className="mt-4 text-red-700">
					{comparison.error.message}
				</p>
			)}
			{comparison.data && (
				<>
					<p className="mt-1 text-sm text-slate-500" data-testid="repo-path">
						{comparison.data.repoPath}
					</p>
					<div className="mt-6 grid gap-4 sm:grid-cols-2">
						<CommitCard label="Base" commit={comparison.data.base} />
						<CommitCard label="Head" commit={comparison.data.head} />
					</div>
				</>
			)}
		</main>
	);
}

function CommitCard({ label, commit }: { label: string; commit: CommitInfo }) {
	return (
		<section
			aria-label={label}
			className="rounded-lg border border-slate-200 p-4"
		>
			<h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
				{label}
			</h2>
			<p className="mt-2 font-mono text-sm">{commit.shortSha}</p>
			<p className="mt-1 font-medium">{commit.subject}</p>
			<p className="mt-1 text-sm text-slate-500">
				{commit.author} · {new Date(commit.date).toLocaleString()}
			</p>
		</section>
	);
}
