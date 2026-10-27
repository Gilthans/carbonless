// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftStore, draftsFor, draftsKey, unsent, useDraft } from "./drafts";

const KEY = draftsKey({ owner: "o", repo: "r", number: 7 });

/** An in-memory Storage. */
function memoryStorage(): Storage {
	const data = new Map<string, string>();
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (k) => data.get(k) ?? null,
		key: (i) => [...data.keys()][i] ?? null,
		removeItem: (k) => {
			data.delete(k);
		},
		setItem: (k, v) => {
			data.set(k, v);
		},
	};
}

afterEach(cleanup);

const sent = (attemptedAt: string) => ({
	attemptedAt,
	clientId: `id-${attemptedAt}`,
	knownCommentIds: [],
});

function Box({ id }: { id: string }) {
	const [text, setText] = useDraft(id);
	return (
		<textarea
			aria-label="Reply"
			value={text}
			onChange={(e) => setText(e.target.value)}
		/>
	);
}

describe("drafts", () => {
	it("keys drafts per PR", () => {
		expect(KEY).toBe("crb:drafts:o/r#7");
	});

	it("text survives unmount and remount", () => {
		const client = new QueryClient();
		const ui = (
			<QueryClientProvider client={client}>
				<Box id="T1" />
			</QueryClientProvider>
		);
		const { unmount } = render(ui);
		act(() => draftsFor(client).setText("T1", "half a thought"));
		unmount();
		render(ui);
		expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(
			"half a thought",
		);
	});

	it("survives a reload through localStorage", () => {
		const storage = memoryStorage();
		const before = new DraftStore(() => storage);
		before.bind(KEY);
		before.setText("T1", "kept");
		before.addSending("T2", "sent", {
			attemptedAt: "2026-01-01T00:00:00.000Z",
			clientId: "cid1",
			knownCommentIds: ["c1"],
		});
		const after = new DraftStore(() => storage);
		after.bind(KEY);
		expect(after.text("T1")).toBe("kept");
		expect(after.get()).toContainEqual({
			threadId: "T2",
			text: "sent",
			sending: {
				attemptedAt: "2026-01-01T00:00:00.000Z",
				sentOnce: false,
				clientId: "cid1",
				knownCommentIds: ["c1"],
			},
		});
		// Another PR's drafts stay apart.
		const other = new DraftStore(() => storage);
		other.bind(draftsKey({ owner: "o", repo: "r", number: 8 }));
		expect(other.get()).toEqual([]);
	});

	it("typed before the PR was known joins the stored ones", () => {
		const storage = memoryStorage();
		storage.setItem(KEY, JSON.stringify([{ threadId: "T1", text: "old" }]));
		const store = new DraftStore(() => storage);
		store.setText("T2", "new");
		store.bind(KEY);
		expect(store.text("T1")).toBe("old");
		expect(store.text("T2")).toBe("new");
		expect(JSON.parse(storage.getItem(KEY) ?? "[]")).toHaveLength(2);
	});

	it("keeps a sent reply until confirmed, then removes it", () => {
		const storage = memoryStorage();
		const store = new DraftStore(() => storage);
		store.bind(KEY);
		store.addSending("T1", "Fixed", sent("t0"));
		expect(unsent(store.get())).toBe(true);
		store.markSent("T1", "t0");
		expect(store.get()[0]?.sending?.sentOnce).toBe(true);
		store.confirm("T1", "t0");
		expect(store.get()).toEqual([]);
		expect(unsent(store.get())).toBe(false);
	});

	it("a refused reply goes back into the box, ahead of what was typed since", () => {
		const store = new DraftStore(() => undefined);
		store.addSending("T1", "Fixed", sent("t0"));
		store.setText("T1", "PS");
		store.returnToBox("T1", "t0");
		expect(store.text("T1")).toBe("Fixed\n\nPS");
		expect(store.get()).toHaveLength(1);
	});

	it("falls back to memory when localStorage throws", () => {
		const throwing = () => {
			throw new Error("SecurityError");
		};
		const broken = {
			getItem: throwing,
			setItem: throwing,
			removeItem: throwing,
		} as unknown as Storage;
		const store = new DraftStore(() => broken);
		store.bind(KEY);
		store.setText("T1", "still here");
		expect(store.text("T1")).toBe("still here");
		const noStorage = new DraftStore(() => {
			throw new Error("blocked");
		});
		noStorage.bind(KEY);
		noStorage.setText("T1", "here too");
		expect(noStorage.text("T1")).toBe("here too");
	});

	it("ignores stored junk", () => {
		const storage = memoryStorage();
		storage.setItem(KEY, '[{"threadId":1},{"threadId":"T1","text":"ok"}');
		const bad = new DraftStore(() => storage);
		bad.bind(KEY);
		expect(bad.get()).toEqual([]);
		storage.setItem(KEY, '[{"threadId":1},{"threadId":"T1","text":"ok"}]');
		const mixed = new DraftStore(() => storage);
		mixed.bind(KEY);
		expect(mixed.get()).toEqual([{ threadId: "T1", text: "ok" }]);
	});

	it("two tabs keep each other's drafts and never bring back a confirmed reply", () => {
		const storage = memoryStorage();
		const a = new DraftStore(() => storage);
		const b = new DraftStore(() => storage);
		a.bind(KEY);
		b.bind(KEY);
		a.addSending("T1", "From A", sent("t0"));
		b.setText("T2", "Typed in B");
		const after = new DraftStore(() => storage);
		after.bind(KEY);
		expect(
			after
				.get()
				.map((d) => d.text)
				.sort(),
		).toEqual(["From A", "Typed in B"]);
		a.confirm("T1", "t0");
		b.setText("T2", "Typed in B, more");
		const last = new DraftStore(() => storage);
		last.bind(KEY);
		expect(last.get()).toEqual([{ threadId: "T2", text: "Typed in B, more" }]);
	});

	it("takes in another tab's writes as they happen", () => {
		const storage = memoryStorage();
		const a = new DraftStore(() => storage);
		const b = new DraftStore(() => storage);
		a.bind(KEY);
		b.bind(KEY);
		const seen = vi.fn();
		b.subscribe(seen);
		a.setText("T1", "From A");
		window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
		expect(b.text("T1")).toBe("From A");
		expect(seen).toHaveBeenCalled();
	});

	it("cleared storage leaves this tab's drafts and writes them back", () => {
		const storage = memoryStorage();
		const store = new DraftStore(() => storage);
		store.bind(KEY);
		store.setText("T1", "In the box");
		storage.clear();
		window.dispatchEvent(new StorageEvent("storage", { key: null }));
		expect(store.text("T1")).toBe("In the box");
		expect(JSON.parse(storage.getItem(KEY) ?? "[]")).toEqual([
			{ threadId: "T1", text: "In the box" },
		]);
	});

	it("two refused replies come back into the box in the order they were sent", () => {
		const store = new DraftStore(() => undefined);
		store.addSending("T1", "first", sent("t0"));
		store.addSending("T1", "second", sent("t1"));
		store.returnToBox("T1", "t0");
		store.returnToBox("T1", "t1");
		expect(store.text("T1")).toBe("first\n\nsecond");
		// Typed since stays last.
		const typed = new DraftStore(() => undefined);
		typed.addSending("T1", "first", sent("t0"));
		typed.addSending("T1", "second", sent("t1"));
		typed.returnToBox("T1", "t0");
		typed.setText("T1", "first\n\nPS");
		typed.returnToBox("T1", "t1");
		expect(typed.text("T1")).toBe("second\n\nfirst\n\nPS");
	});

	it("discard drops the thread's box text and sent replies", () => {
		const store = new DraftStore(() => undefined);
		store.setText("T1", "box");
		store.addSending("T1", "sent", sent("t0"));
		store.setText("T2", "other");
		store.discard("T1");
		expect(store.get()).toEqual([{ threadId: "T2", text: "other" }]);
	});

	it("whitespace alone is nothing to lose", () => {
		expect(unsent([{ threadId: "T1", text: "  " }])).toBe(false);
		expect(unsent([{ threadId: "T1", text: "x" }])).toBe(true);
	});
});

describe("edit drafts", () => {
	it("are kept per comment beside the box, and dropped when back to where they started", () => {
		const store = new DraftStore(() => undefined);
		store.setText("T1", "a reply");
		store.setEdit("T1", "c1", "Old", "New");
		expect(store.text("T1")).toBe("a reply");
		expect(store.edit("c1")).toEqual({
			threadId: "T1",
			text: "New",
			edit: { commentId: "c1", from: "Old" },
		});
		// The box doesn't touch the edit, nor the edit the box.
		store.setText("T1", "");
		expect(store.edit("c1")?.text).toBe("New");
		store.setEdit("T1", "c1", "Old", "Old");
		expect(store.edit("c1")).toBeUndefined();
		expect(store.get()).toEqual([]);
	});

	it("survive a reload, saving or not, and count as something to lose", () => {
		const storage = memoryStorage();
		const before = new DraftStore(() => storage);
		before.bind(KEY);
		before.setEdit("T1", "c1", "Old", "Typing");
		before.setEdit("T2", "c2", "Was", "Saved");
		before.markSaving("c2", true);
		const after = new DraftStore(() => storage);
		after.bind(KEY);
		expect(after.edit("c1")).toMatchObject({
			text: "Typing",
			edit: { commentId: "c1", from: "Old" },
		});
		expect(after.edit("c2")?.edit).toEqual({
			commentId: "c2",
			from: "Was",
			saving: true,
		});
		expect(unsent(after.get())).toBe(true);
		after.markSaving("c2", false);
		expect(after.edit("c2")?.edit).toEqual({ commentId: "c2", from: "Was" });
	});

	it("two tabs keep each other's edits; one typed here wins over the stored one", () => {
		const storage = memoryStorage();
		const a = new DraftStore(() => storage);
		a.bind(KEY);
		a.setEdit("T1", "c1", "Old", "From A");
		a.setEdit("T1", "c2", "Old", "Also A");
		const b = new DraftStore(() => storage);
		b.setEdit("T1", "c1", "Old", "Typed in B first");
		b.bind(KEY);
		expect(b.edit("c1")?.text).toBe("Typed in B first");
		expect(b.edit("c2")?.text).toBe("Also A");
		a.dropEdit("c2");
		window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
		expect(b.edit("c2")).toBeUndefined();
	});

	it("setFrom moves the start, discard drops the thread's edits too", () => {
		const store = new DraftStore(() => undefined);
		store.setEdit("T1", "c1", "Old", "Mine");
		store.setFrom("c1", "Theirs");
		expect(store.edit("c1")?.edit).toEqual({
			commentId: "c1",
			from: "Theirs",
			theirs: true,
		});
		store.discard("T1");
		expect(store.get()).toEqual([]);
	});

	it("a refused reply goes back into the box, never into the thread's edit draft", () => {
		const store = new DraftStore(() => undefined);
		store.setEdit("T1", "c2", "Old", "My careful edit");
		store.addSending("T1", "LGTM", sent("t0"));
		expect(store.returnToBox("T1", "t0")).toBe("LGTM");
		expect(store.text("T1")).toBe("LGTM");
		expect(store.edit("c2")).toEqual({
			threadId: "T1",
			text: "My careful edit",
			edit: { commentId: "c2", from: "Old" },
		});
	});

	it("ignores a stored edit without its comment", () => {
		const storage = memoryStorage();
		storage.setItem(
			KEY,
			JSON.stringify([
				{ threadId: "T1", text: "x", edit: { from: "y" } },
				{ threadId: "T1", text: "x", edit: { commentId: "", from: "y" } },
				{ threadId: "T1", text: "ok", edit: { commentId: "c1", from: "y" } },
			]),
		);
		const store = new DraftStore(() => storage);
		store.bind(KEY);
		expect(store.get().map((d) => d.text)).toEqual(["ok"]);
	});
});
