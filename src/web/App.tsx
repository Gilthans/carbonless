import { useQuery } from "@tanstack/react-query";
import { fetchSession } from "./api";

/** Placeholder until the review UI lands: shows which PR is open. */
export function App() {
	const session = useQuery({ queryKey: ["session"], queryFn: fetchSession });

	return (
		<main className="mx-auto max-w-4xl p-8 font-sans text-slate-900">
			{session.isPending && <p className="text-slate-500">Loading…</p>}
			{session.isError && (
				<p role="alert" className="text-red-700">
					{session.error.message}
				</p>
			)}
			{session.data && (
				<h1 className="text-2xl font-semibold">{session.data.pr.title}</h1>
			)}
		</main>
	);
}
