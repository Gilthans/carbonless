import { describe, expect, it } from "vitest";
import { formatArgs, parseArgs } from "./args";

describe("the Arguments field", () => {
	it.each<[string[], string]>([
		[[], ""],
		[["--acp"], "--acp"],
		[["--config", "/a path/x.json"], '--config "/a path/x.json"'],
		[['say "hi"'], '"say \\"hi\\""'],
		[["C:\\tmp dir"], '"C:\\\\tmp dir"'],
		[["it's"], '"it\'s"'],
		[[""], '""'],
		[["a\tb"], '"a\tb"'],
	])("%j is shown as %s and read back the same", (args, text) => {
		expect(formatArgs(args)).toBe(text);
		expect(parseArgs(text)).toEqual(args);
	});

	it("reads what a reviewer types: spaces split, quotes keep words together", () => {
		expect(parseArgs("  --model  opus ")).toEqual(["--model", "opus"]);
		expect(parseArgs('--name "two words" --x')).toEqual([
			"--name",
			"two words",
			"--x",
		]);
		expect(parseArgs("--name 'two words'")).toEqual(["--name", "two words"]);
		expect(parseArgs('--x=a" "b')).toEqual(["--x=a b"]);
		// Outside quotes a backslash is kept as typed (Windows paths).
		expect(parseArgs("C:\\tools\\acp")).toEqual(["C:\\tools\\acp"]);
		// An unclosed quote runs to the end.
		expect(parseArgs('"open end')).toEqual(["open end"]);
	});
});
