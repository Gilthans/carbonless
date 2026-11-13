/**
 * Yardsticks for the similarity pairing's CPU tests (linePairing.test.ts,
 * wordBlocks.test.ts, findInPr.test.ts): they share no code with the LCS
 * (src/web/files/linePairing.ts), so replacing the LCS by another algorithm
 * changes the cost under test and not the yardstick.
 */

const sink = new Uint32Array(1);

/**
 * `steps` word steps (the unit ALIGN_WORD_OPS counts: an and, an add with
 * carry, an or) in a plain loop.
 */
export function plainWordSteps(steps: number): void {
	const v = new Uint32Array(6).fill(0xffffffff);
	const mask = Uint32Array.from({ length: 6 }, (_, i) => 0x9e3779b1 * (i + 1));
	let carry = 0;
	for (let n = 0; n < steps; n += 6) {
		for (let w = 0; w < 6; w++) {
			const x = v[w] as number;
			const u = (x & (mask[w] as number)) >>> 0;
			const sum = x + u + carry;
			carry = sum > 0xffffffff ? 1 : 0;
			v[w] = (sum | (x & ~(mask[w] as number))) >>> 0;
		}
	}
	sink[0] = (sink[0] as number) ^ (v[0] as number) ^ carry;
}

const marks = Array.from("()[]{};,=+-*/<>!&|");

/** `n` pseudo-random lines of `t` punctuation tokens (a token a character). */
export function punctuation(n: number, t: number, seed: number): string[] {
	let state = seed;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state >>> 8;
	};
	return Array.from({ length: n }, () =>
		Array.from({ length: t }, () => marks[next() % marks.length]).join(""),
	);
}
