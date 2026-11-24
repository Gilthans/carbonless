/** One gh call's input and output (gh.mjs, fakeGh). */
export interface FakeGhIo {
	args: string[];
	env: Record<string, string | undefined>;
	cwd: string;
	/** The body of `--input -`. */
	stdin: () => string;
	out: (text: string) => void;
	err: (text: string) => void;
	/** Appends the call to the log; false when gh was killed instead. */
	log: (path: string, line: string) => boolean | Promise<boolean>;
	/** True once the caller killed gh. */
	killed?: () => boolean;
}
/** Runs one gh call with a gh process's semantics; resolves to its exit code. */
export function fakeGh(io: FakeGhIo): Promise<number>;
