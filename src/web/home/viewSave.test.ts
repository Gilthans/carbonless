import { describe, expect, it } from "vitest";
import { view } from "./testing";
import { pendingView } from "./viewSave";

describe("pendingView", () => {
	it("lists the saving repos; the rest stays the server's", () => {
		const home = view();
		const shown = pendingView(home, ["acme/api", "acme/web"]);
		expect(shown.view).toEqual({
			name: "My PRs",
			repos: ["acme/api", "acme/web"],
		});
		expect(shown.viewer).toBe(home.viewer);
		expect(shown.startedRepos).toBe(home.startedRepos);
	});
});
