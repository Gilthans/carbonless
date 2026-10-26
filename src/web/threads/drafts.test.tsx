// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
		before.addSending("T2", "sent", "2026-01-01T00:00:00.000Z");
		const after = new DraftStore(() => storage);
		after.bind(KEY);
		expect(after.text("T1")).toBe("kept");
		expect(after.get()).toContainEqual({
			threadId: "T2",
			text: "sent",
			sending: { attemptedAt: "2026-01-01T00:00:00.000Z", sentOnce: false },
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
		const store = new DraftStore(() => memoryStorage());
		store.bind(KEY);
		store.addSending("T1", "Fixed", "t0");
		expect(unsent(store.get())).toBe(true);
		store.markSent("T1", "t0");
		expect(store.get()[0]?.sending?.sentOnce).toBe(true);
		store.confirm("T1", "t0");
		expect(store.get()).toEqual([]);
		expect(unsent(store.get())).toBe(false);
	});

	it("a refused reply goes back into the box, ahead of what was typed since", () => {
		const store = new DraftStore(() => undefined);
		store.addSending("T1", "Fixed", "t0");
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

	it("whitespace alone is nothing to lose", () => {
		expect(unsent([{ threadId: "T1", text: "  " }])).toBe(false);
		expect(unsent([{ threadId: "T1", text: "x" }])).toBe(true);
	});
});
