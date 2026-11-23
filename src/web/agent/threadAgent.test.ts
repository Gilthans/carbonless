import { describe, expect, it } from "vitest";
import { standingSuggestion } from "./threadAgent";
import { conversation } from "./threadAgentFixtures";

describe("standingSuggestion", () => {
	const open = { resolved: false };
	const suggesting = conversation({
		messages: [
			{ id: "m1", by: "human", at: "2026-11-11T10:00:00Z", text: "Fixed?" },
			{
				id: "m2",
				by: "ai",
				at: "2026-11-11T10:01:00Z",
				text: "Yes.",
				stop: "end_turn",
				suggests: "resolve",
			},
		],
	});

	it("stands on the latest answer that suggests it", () => {
		expect(standingSuggestion(suggesting, open)?.id).toBe("m2");
	});

	it("a message the agent added with open (an origin) doesn't retract it (CAR-80)", () => {
		const after = conversation({
			messages: [
				...suggesting.messages,
				{
					id: "m3",
					by: "ai",
					at: "2026-11-11T10:02:00Z",
					text: "This is such a case.",
					stop: "end_turn",
					origin: { thread: "T0", message: "q0" },
				},
			],
		});
		expect(standingSuggestion(after, open)?.id).toBe("m2");
	});

	it("a message from open that suggests it stands, and a later answer that doesn't retracts it (CAR-265)", () => {
		const opened = conversation({
			messages: [
				{ id: "m1", by: "human", at: "2026-11-11T10:00:00Z", text: "Fixed?" },
				{
					id: "m2",
					by: "ai",
					at: "2026-11-11T10:01:00Z",
					text: "Not yet.",
					stop: "end_turn",
				},
				{
					id: "m3",
					by: "ai",
					at: "2026-11-11T10:02:00Z",
					text: "Fixed now.",
					stop: "end_turn",
					origin: { thread: "T0", message: "q0" },
					suggests: "resolve",
				},
			],
		});
		expect(standingSuggestion(opened, open)?.id).toBe("m3");
		expect(standingSuggestion(opened, { resolved: true })).toBeUndefined();
		const retracted = conversation({
			messages: [
				...opened.messages,
				{ id: "m4", by: "human", at: "2026-11-11T10:03:00Z", text: "Sure?" },
				{
					id: "m5",
					by: "ai",
					at: "2026-11-11T10:04:00Z",
					text: "Not quite.",
					stop: "end_turn",
				},
			],
		});
		expect(standingSuggestion(retracted, open)).toBeUndefined();
	});

	it("a later answer that doesn't suggest it retracts it", () => {
		const after = conversation({
			messages: [
				...suggesting.messages,
				{ id: "m3", by: "human", at: "2026-11-11T10:02:00Z", text: "Sure?" },
				{
					id: "m4",
					by: "ai",
					at: "2026-11-11T10:03:00Z",
					text: "Not quite.",
					stop: "end_turn",
				},
			],
		});
		expect(standingSuggestion(after, open)).toBeUndefined();
	});
});
