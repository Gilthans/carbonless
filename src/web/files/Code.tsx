import { useQuery } from "@tanstack/react-query";
import { highlightLine } from "./highlight";

/** A line's code, plain until its highlighting arrives. */
export function Code({ text, lang }: { text: string; lang: string | null }) {
	const tokens = useQuery({
		queryKey: ["highlight", lang, text],
		queryFn: () => highlightLine(text, lang),
		enabled: lang !== null && text.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
	});
	if (!tokens.data?.length) return <>{text}</>;
	return (
		<>
			{tokens.data.map((token) => (
				<span
					key={token.offset}
					style={{
						color: token.color,
						fontStyle:
							token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
						fontWeight:
							token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
					}}
				>
					{token.content}
				</span>
			))}
		</>
	);
}
