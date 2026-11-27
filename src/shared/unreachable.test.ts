import { describe, expect, it } from "vitest";
import { unreachable } from "./unreachable";

describe("unreachable", () => {
	it("throws, naming the value the types ruled out", () => {
		expect(() => unreachable({ kind: "new" } as never)).toThrow(
			'Unexpected value: {"kind":"new"}',
		);
	});
});
