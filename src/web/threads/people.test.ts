import { describe, expect, it } from "vitest";
import type { ThreadParticipant } from "../../shared/types";
import { assignPeople, hashTint, personOf, TINTS } from "./people";

const said = (
	login: string,
	day: number,
	avatarUrl = "",
): ThreadParticipant => ({
	login,
	avatarUrl,
	at: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
});
const thread = (...participants: ThreadParticipant[]) => ({ participants });

describe("assignPeople", () => {
	it("gives tints in the order people first spoke anywhere in the PR", () => {
		const { tints } = assignPeople([
			// Listed first, but spoke later than those in the next thread.
			thread(said("dima", 5), said("badyan", 6)),
			thread(said("badyan", 1), said("rev", 2)),
		]);
		expect([...tints]).toEqual([
			["badyan", 0],
			["rev", 1],
			["dima", 2],
		]);
	});

	it("is the same person in every thread, whatever the case of the login", () => {
		const people = assignPeople([
			thread(said("Badyan", 1), said("dima", 2)),
			thread(said("dima", 3), said("badyan", 4)),
		]);
		expect(personOf(people, "BADYAN").tint).toBe(0);
		expect(personOf(people, "dima").tint).toBe(1);
	});

	it("keeps everyone's tint when someone new speaks", () => {
		const before = assignPeople([thread(said("a", 1), said("b", 2))]);
		const after = assignPeople([
			thread(said("a", 1), said("b", 2), said("c", 9)),
			thread(said("b", 3)),
		]);
		for (const login of ["a", "b"]) {
			expect(personOf(after, login).tint).toBe(personOf(before, login).tint);
		}
		expect(personOf(after, "c").tint).toBe(2);
	});

	it("starts over once the palette runs out", () => {
		const many = Array.from({ length: TINTS.length + 2 }, (_, i) =>
			said(`p${i}`, i + 1),
		);
		const { tints } = assignPeople([thread(...many)]);
		expect(tints.get(`p${TINTS.length - 1}`)).toBe(TINTS.length - 1);
		expect(tints.get(`p${TINTS.length}`)).toBe(0);
		expect(tints.get(`p${TINTS.length + 1}`)).toBe(1);
	});

	it("puts the viewer after everyone when they haven't spoken yet", () => {
		const people = assignPeople([thread(said("a", 1))], "Octo_Cat");
		expect(personOf(people, "octo_cat").tint).toBe(1);
		const spoke = assignPeople(
			[thread(said("octo_cat", 1), said("a", 2))],
			"Octo_Cat",
		);
		expect(personOf(spoke, "Octo_Cat").tint).toBe(0);
	});

	it("knows each person's avatar from any thread; the comment's own wins", () => {
		const url = "https://avatars.githubusercontent.com/u/1?s=40";
		const people = assignPeople([
			thread(said("a", 1)),
			thread(said("a", 2, url)),
		]);
		expect(personOf(people, "A").avatarUrl).toBe(url);
		expect(personOf(people, "a", "https://x/y").avatarUrl).toBe("https://x/y");
		expect(personOf(people, "b").avatarUrl).toBe("");
	});

	it("gives someone no thread lists a tint by their login, the same every time", () => {
		const none = assignPeople([]);
		expect(personOf(none, "stranger").tint).toBe(hashTint("stranger"));
		expect(hashTint("Stranger")).toBe(hashTint("stranger"));
		expect(hashTint("stranger")).toBeLessThan(TINTS.length);
	});
});
