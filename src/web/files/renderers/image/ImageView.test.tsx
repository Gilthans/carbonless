// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldJson } from "../../../../../test/loading";
import { IMAGE_AUTO_LOAD_BYTES } from "../../../../shared/imageTypes";
import type { FileView } from "../../../../shared/types";
import { REVIEW_KEY } from "../../../api";
import { newQueryClient } from "../../../queryClient";
import { imageMode } from "../../../viewSettings";
import { STALE_MESSAGE } from "../../useSetStates";
import { ImageView } from "./ImageView";

const file = (over: Partial<FileView> = {}): FileView => ({
	index: 0,
	path: "img/logo.png",
	status: "modified",
	binary: true,
	submodule: false,
	additions: 0,
	deletions: 0,
	oldSize: 41 * 1024,
	newSize: 44 * 1024,
	clusters: [
		{
			key: "k1",
			kind: "file",
			label: "Binary file changed",
			oldStart: 0,
			oldCount: 0,
			newStart: 0,
			newCount: 0,
			removed: [],
			added: [],
			lines: 0,
			state: "unreviewed",
		},
	],
	done: false,
	reviewed: false,
	crossedOff: false,
	...over,
});

/** Fires an <img>'s load with a natural size (jsdom decodes nothing). */
function loadImg(alt: string, w: number, h: number) {
	const img = screen.getByAltText(alt) as HTMLImageElement;
	Object.defineProperty(img, "naturalWidth", { value: w });
	Object.defineProperty(img, "naturalHeight", { value: h });
	fireEvent.load(img);
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	localStorage.clear();
	imageMode.reset();
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function show(f: FileView, opts: { sideBySide?: boolean; from?: number } = {}) {
	const client = newQueryClient();
	const view = render(
		<QueryClientProvider client={client}>
			<ImageView
				file={f}
				revision="r1"
				sideBySide={opts.sideBySide ?? false}
				{...(opts.from === undefined ? {} : { from: opts.from })}
			/>
		</QueryClientProvider>,
	);
	return { client, ...view };
}

describe("ImageView", () => {
	it("loading: a spinner over a busy stage and a skeleton for the dimensions, then the sizes", () => {
		show(file());
		const stage = screen.getByTestId("image-stage");
		expect(stage).toHaveAttribute("aria-busy", "true");
		expect(screen.getByRole("status", { name: "Loading image" })).toBeVisible();
		expect(screen.getByTestId("image-dims")).not.toHaveTextContent("×");
		expect(screen.getByTestId("image-dims")).toHaveTextContent("41 → 44 KB");
		// No slider until both sides are in.
		expect(screen.queryByRole("slider")).toBeNull();
		loadImg("Before", 493, 312);
		expect(stage).toHaveAttribute("aria-busy", "true");
		loadImg("After", 493, 340);
		expect(stage).not.toHaveAttribute("aria-busy");
		expect(screen.queryByRole("status", { name: "Loading image" })).toBeNull();
		expect(screen.getByTestId("image-dims")).toHaveTextContent(
			"493×312→to493×340· 41 → 44 KB",
		);
		expect(stage).toHaveStyle({ aspectRatio: "493 / 340", maxWidth: "493px" });
		expect(screen.getByAltText("Before")).toHaveStyle({
			width: "100%",
			height: `${(312 / 340) * 100}%`,
		});
	});

	it("slider: an accessible range over the stage clips the before image", () => {
		show(file());
		loadImg("Before", 10, 10);
		loadImg("After", 10, 10);
		const range = screen.getByRole("slider", { name: "Before/after split" });
		expect(range).toHaveStyle({ touchAction: "pan-y" });
		fireEvent.change(range, { target: { value: "30" } });
		expect(screen.getByTestId("image-before-layer")).toHaveStyle({
			clipPath: "inset(0 70% 0 0)",
		});
	});

	it("fade: a range under the stage sets the before image's opacity; the mode is remembered", () => {
		show(file());
		loadImg("Before", 10, 10);
		loadImg("After", 10, 10);
		fireEvent.click(screen.getByRole("button", { name: "Fade" }));
		expect(screen.getByRole("button", { name: "Fade" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(imageMode.read()).toBe("fade");
		const range = screen.getByRole("slider", { name: "Fade before to after" });
		fireEvent.change(range, { target: { value: "75" } });
		expect(screen.getByTestId("image-before-layer")).toHaveStyle({
			opacity: "0.25",
		});
	});

	it("added: one side, labelled, no compare modes", () => {
		show(file({ status: "added", oldSize: undefined }));
		expect(screen.getByText("added")).toBeVisible();
		expect(screen.queryByAltText("Before")).toBeNull();
		expect(screen.queryByRole("group", { name: "Compare" })).toBeNull();
		loadImg("Added image", 20, 10);
		expect(screen.getByTestId("image-dims")).toHaveTextContent("20×10· 44 KB");
	});

	it("deleted: the old side, labelled", () => {
		show(file({ status: "deleted", newSize: undefined }));
		expect(screen.getByText("deleted")).toBeVisible();
		expect(screen.getByAltText("Deleted image")).toHaveAttribute(
			"src",
			"/api/files/0/blob?revision=r1&side=old",
		);
	});

	it("renamed with no content change (same blob): the image once, no label", async () => {
		const held = heldJson();
		fetchMock.mockImplementation(() =>
			held.response.then(
				() => new Response(null, { status: 200, headers: { etag: '"abc"' } }),
			),
		);
		show(
			file({
				status: "renamed",
				oldPath: "img/old.png",
				oldSize: 10,
				newSize: 10,
			}),
		);
		// Deciding whether it changed is loading, never a fallback.
		expect(screen.getByRole("status", { name: "Loading image" })).toBeVisible();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/files/0/blob?revision=r1&side=old",
			{ method: "HEAD" },
		);
		held.release({});
		await waitFor(() =>
			expect(screen.getAllByRole("img", { name: "Image" })).toHaveLength(1),
		);
		expect(screen.getByRole("img", { name: "Image" })).toHaveAttribute(
			"src",
			"/api/files/0/blob?revision=r1&side=new",
		);
		expect(screen.queryByText("added")).toBeNull();
		expect(screen.queryByRole("group", { name: "Compare" })).toBeNull();
	});

	it("renamed and changed (different blobs): both sides compare", async () => {
		let n = 0;
		fetchMock.mockImplementation(async () => {
			n += 1;
			return new Response(null, {
				status: 200,
				headers: { etag: `"oid${n}"` },
			});
		});
		show(file({ status: "renamed", oldPath: "img/old.png" }));
		await waitFor(() =>
			expect(screen.getByAltText("Before")).toBeInTheDocument(),
		);
		expect(screen.getByAltText("After")).toBeInTheDocument();
		expect(screen.getByRole("group", { name: "Compare" })).toBeVisible();
	});

	it("side-by-side: two single views with captions, no modes", () => {
		show(file(), { sideBySide: true });
		loadImg("Before", 493, 312);
		loadImg("After", 493, 340);
		const sbs = screen.getByTestId("image-side-by-side");
		expect(sbs).toHaveTextContent("before493×312 · 41 KB");
		expect(sbs).toHaveTextContent("after493×340 · 44 KB");
		expect(screen.queryByRole("group", { name: "Compare" })).toBeNull();
	});

	it("an unknown extension shown as Image asks the server to sniff", () => {
		show(file({ path: "img/logo.dib" }));
		expect(screen.getByAltText("After")).toHaveAttribute(
			"src",
			"/api/files/0/blob?revision=r1&side=new&sniff=1",
		);
	});

	it("the since view reads the interdiff's sides, and an added file's old side too", () => {
		show(file({ status: "added" }), { from: 2 });
		expect(screen.getByAltText("Before")).toHaveAttribute(
			"src",
			"/api/files/0/blob?revision=r1&side=old&from=2",
		);
	});

	it("undecodable: no stage; the toolbar says so and keeps the byte sizes", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		show(file());
		fireEvent.error(screen.getByAltText("After"));
		await waitFor(() =>
			expect(screen.getByTestId("image-view")).toHaveAttribute(
				"data-image-state",
				"fallback",
			),
		);
		expect(screen.queryByTestId("image-stage")).toBeNull();
		expect(
			screen.getByRole("img", { name: "Can't show this as an image" }),
		).toBeVisible();
		expect(screen.getByTestId("image-dims")).toHaveTextContent("41 → 44 KB");
	});

	it("stale: the review is read again (as for a refused write), never the undecodable fallback", async () => {
		const held = heldJson();
		fetchMock.mockReturnValue(held.response);
		const { client } = show(file());
		const invalidate = vi.spyOn(client, "invalidateQueries");
		fireEvent.error(screen.getByAltText("After"));
		// While the probe is held: still loading, never a fallback.
		expect(screen.getByRole("status", { name: "Loading image" })).toBeVisible();
		await act(async () => held.release({ error: "stale" }, 409));
		await waitFor(() => expect(screen.getByText(STALE_MESSAGE)).toBeVisible());
		expect(screen.queryByTestId("image-view")).toBeNull();
		expect(invalidate).toHaveBeenCalledWith({ queryKey: REVIEW_KEY });
	});

	it("over 10 MB: a button loads it", () => {
		show(file({ newSize: IMAGE_AUTO_LOAD_BYTES + 1, oldSize: 1024 }));
		expect(screen.queryByRole("img")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Load image (10 MB)" }));
		expect(screen.getByAltText("After")).toBeInTheDocument();
		expect(screen.getByAltText("Before")).toBeInTheDocument();
	});
});
