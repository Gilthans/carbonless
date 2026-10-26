import { describe, expect, it } from "vitest";
import { attentionSet } from "./attention";

const human = (login: string) => ({ login, bot: false });
const bot = (login: string) => ({ login, bot: true });

/** The set for these commenters (oldest first) on a PR by "author", sorted. */
const set = (comments: { login: string; bot: boolean }[], resolved = false) =>
	attentionSet({ comments, prAuthor: "author", resolved }).sort();

describe("attentionSet", () => {
	it("one reviewer comment: the PR author", () => {
		expect(set([human("rev")])).toEqual(["author"]);
	});

	it("the author replies: the reviewer", () => {
		expect(set([human("rev"), human("author")])).toEqual(["rev"]);
	});

	it("a third party replies: the author and the reviewer", () => {
		expect(set([human("rev"), human("author"), human("third")])).toEqual([
			"author",
			"rev",
		]);
	});

	it("the reviewer replies again: the author and the third party", () => {
		expect(
			set([human("rev"), human("author"), human("third"), human("rev")]),
		).toEqual(["author", "third"]);
	});

	it("resolved: nobody", () => {
		expect(set([human("rev")], true)).toEqual([]);
		expect(set([human("rev"), human("author")], true)).toEqual([]);
	});

	it("a bot is neither in the set nor the latest comment", () => {
		expect(set([human("rev"), bot("ci[bot]")])).toEqual(["author"]);
		expect(set([human("rev"), human("author"), bot("ci")])).toEqual(["rev"]);
	});

	it("a bot's thread: the PR author", () => {
		expect(set([bot("ci")])).toEqual(["author"]);
	});

	it("the PR author alone: nobody", () => {
		expect(set([human("author")])).toEqual([]);
	});

	it("no comments: the PR author", () => {
		expect(set([])).toEqual(["author"]);
	});

	it("logins differing only in case or _/- are one person, the first spelling kept", () => {
		expect(
			attentionSet({
				comments: [human("Octo_Cat"), human("Author"), human("octo-cat")],
				prAuthor: "author",
				resolved: false,
			}),
		).toEqual(["Author"]);
		expect(
			attentionSet({
				comments: [human("Octo_Cat"), human("AUTHOR")],
				prAuthor: "author",
				resolved: false,
			}),
		).toEqual(["Octo_Cat"]);
	});

	it("a deleted account (no login) can be the latest, and never joins", () => {
		expect(set([human("rev"), human("author"), human("")])).toEqual([
			"author",
			"rev",
		]);
	});

	it("a bot PR author never joins", () => {
		expect(
			attentionSet({
				comments: [human("rev"), human("third")],
				prAuthor: "dependabot",
				prAuthorBot: true,
				resolved: false,
			}),
		).toEqual(["rev"]);
	});

	it("no PR author known: only the participants", () => {
		expect(
			attentionSet({
				comments: [human("rev"), human("third")],
				prAuthor: "",
				resolved: false,
			}),
		).toEqual(["rev"]);
	});
});
