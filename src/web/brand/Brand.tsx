import logoUrl from "./logo.svg";
import markUrl from "./mark.svg";

/**
 * The full logo: gradient-ringed magnifier over a split diff, with paint
 * splashes. Decorative (the wordmark beside it names the app); 40px and up.
 */
export function Logo({ className = "" }: { className?: string }) {
	return <img src={logoUrl} alt="" aria-hidden className={className} />;
}

/** The simplified mark (ring, split diff, handle) for small sizes. */
export function Mark({ className = "" }: { className?: string }) {
	return <img src={markUrl} alt="" aria-hidden className={className} />;
}

/**
 * The "o" of the wordmark: a disc with a four-point star for a counter, as
 * wide and tall as the display font's heavy "o" (0.582em advance, ink from
 * 0.016em below the baseline to 0.516em above it).
 */
function StarO() {
	const r = 190;
	const k = 0.29 * r;
	const star = `M297 ${266 - r}Q${297 + k} ${266 - k} ${297 + r} 266Q${297 + k} ${266 + k} 297 ${266 + r}Q${297 - k} ${266 + k} ${297 - r} 266Q${297 - k} ${266 - k} 297 ${266 - r}Z`;
	return (
		<svg
			aria-hidden
			viewBox="0 0 582 532"
			className="inline-block h-[0.532em] w-[0.582em] fill-current align-[-0.016em]"
		>
			<path
				fillRule="evenodd"
				d={`M15 266A282 266 0 1 0 579 266A282 266 0 1 0 15 266Z${star}`}
			/>
		</svg>
	);
}

/** "carbonless" in the display font, its "o" a star. Sized by font-size. */
export function Wordmark({ className = "" }: { className?: string }) {
	return (
		<span
			className={`inline-block whitespace-nowrap font-display leading-none font-extrabold tracking-[-0.01em] text-ink ${className}`}
		>
			<span className="sr-only">carbonless</span>
			<span aria-hidden>carb</span>
			<StarO />
			<span aria-hidden>nless</span>
		</span>
	);
}
