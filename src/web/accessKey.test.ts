import { describe, expect, it, vi } from "vitest";
import { stripAccessKey } from "./accessKey";

const history = () => ({ state: { idx: 0 }, replaceState: vi.fn() });

describe("stripAccessKey", () => {
	it("drops the key and keeps the path, other parameters and hash", () => {
		const h = history();
		stripAccessKey({ href: "http://h:1/files?key=abc&x=1#f3" }, h);
		expect(h.replaceState).toHaveBeenCalledWith(
			{ idx: 0 },
			"",
			"/files?x=1#f3",
		);
	});

	it("leaves a URL without a key alone", () => {
		const h = history();
		stripAccessKey({ href: "http://h:1/?x=1" }, h);
		expect(h.replaceState).not.toHaveBeenCalled();
	});

	it("leaves no bare ? behind", () => {
		const h = history();
		stripAccessKey({ href: "http://h:1/?key=abc" }, h);
		expect(h.replaceState).toHaveBeenCalledWith({ idx: 0 }, "", "/");
	});
});
