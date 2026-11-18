// @vitest-environment jsdom
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldJson } from "../../../../../test/loading";
import { IMAGE_AUTO_LOAD_BYTES } from "../../../../shared/imageTypes";
import type { FileView } from "../../../../shared/types";
import { REVIEW_KEY } from "../../../api";
import { newQueryClient } from "../../../queryClient";
import { imageMode } from "../../../viewSettings";
import { STALE_MESSAGE } from "../../useSetStates";
import {
	imageModesOf,
	pressedView,
	ViewSwitch,
	viewOptions,
} from "../ViewSwitch";
import { ImageView } from "./ImageView";

/** FileDiff's view switch, as the image toolbar gets it. */
function Switch(props: { file: FileView; modes: boolean }) {
	const mode = imageMode.use();
	return (
		<ViewSwitch
			options={viewOptions(props.file, props.modes)}
			pressed={pressedView("image", mode, props.modes)}
			onPick={(o) => o.mode && imageMode.set(o.mode)}
		/>
	);
}

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
				view={
					<Switch file={f} modes={imageModesOf(f, opts.sideBySide ?? false)} />
				}
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
		expect(range).toHaveAttribute("aria-valuetext", "50% before");
		fireEvent.change(range, { target: { value: "30" } });
		expect(range).toHaveAttribute("aria-valuetext", "30% before");
		// Each side of the handle shows only its own image.
		expect(screen.getByTestId("image-before-layer")).toHaveStyle({
			clipPath: "inset(0 70% 0 0)",
		});
		expect(screen.getByTestId("image-after-layer")).toHaveStyle({
			clipPath: "inset(0 0 0 30%)",
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
		expect(screen.getByTestId("image-after-layer").style.clipPath).toBe("");
	});

	it("added: one side, labelled, no compare modes", () => {
		show(file({ status: "added", oldSize: undefined }));
		expect(screen.getByText("added")).toBeVisible();
		expect(screen.queryByAltText("Before")).toBeNull();
		// No modes: one Image button.
		expect(screen.queryByRole("button", { name: "Slider" })).toBeNull();
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

	const names = () =>
		within(screen.getByRole("group", { name: "View" }))
			.getAllByRole("button")
			.map((b) => b.getAttribute("aria-label"));

	it("renamed with the same blob (the snapshot's flag): the image once, no label, [Image, Binary] from the start", () => {
		show(
			file({
				status: "renamed",
				oldPath: "img/old.png",
				oldSize: 10,
				newSize: 10,
				sameBlob: true,
			}),
		);
		// No probe: the snapshot says so.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(names()).toEqual(["Image", "Binary"]);
		expect(screen.queryByAltText("Before")).toBeNull();
		loadImg("Image", 10, 10);
		expect(screen.getByRole("img", { name: "Image" })).toHaveAttribute(
			"src",
			"/api/files/0/blob?revision=r1&side=new",
		);
		expect(screen.queryByText("added")).toBeNull();
		expect(names()).toEqual(["Image", "Binary"]);
	});

	it("renamed and changed (different blobs): both sides compare", () => {
		show(file({ status: "renamed", oldPath: "img/old.png" }));
		expect(screen.getByAltText("Before")).toBeInTheDocument();
		expect(screen.getByAltText("After")).toBeInTheDocument();
		expect(names()).toEqual(["Slider", "Fade", "Binary"]);
	});

	it("a modified PNG behind the tap: the same switch before and after it loads, and Fade works meanwhile", () => {
		const big = IMAGE_AUTO_LOAD_BYTES + 1;
		show(file({ oldSize: big, newSize: big }));
		expect(
			screen.getByRole("button", { name: /^Load image/ }),
		).toBeInTheDocument();
		expect(names()).toEqual(["Slider", "Fade", "Binary"]);
		fireEvent.click(screen.getByRole("button", { name: "Fade" }));
		expect(imageMode.read()).toBe("fade");
		expect(screen.getByRole("button", { name: "Fade" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		fireEvent.click(screen.getByRole("button", { name: /^Load image/ }));
		expect(names()).toEqual(["Slider", "Fade", "Binary"]);
		loadImg("Before", 20, 10);
		loadImg("After", 20, 10);
		expect(names()).toEqual(["Slider", "Fade", "Binary"]);
		expect(
			screen.getByRole("slider", { name: "Fade before to after" }),
		).toBeVisible();
	});

	it("side-by-side: two single views with captions, no modes", () => {
		show(file(), { sideBySide: true });
		loadImg("Before", 493, 312);
		loadImg("After", 493, 340);
		const sbs = screen.getByTestId("image-side-by-side");
		expect(sbs).toHaveTextContent("before493×312 · 41 KB");
		expect(sbs).toHaveTextContent("after493×340 · 44 KB");
		// No modes: one Image button.
		expect(screen.queryByRole("button", { name: "Slider" })).toBeNull();
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
		// The way back stays: the switch, as it was.
		expect(names()).toEqual(["Slider", "Fade", "Binary"]);
	});

	it("over 10 MB: a button loads it", () => {
		show(file({ newSize: IMAGE_AUTO_LOAD_BYTES + 1, oldSize: 1024 }));
		expect(screen.queryByRole("img")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Load image (10 MB)" }));
		expect(screen.getByAltText("After")).toBeInTheDocument();
		expect(screen.getByAltText("Before")).toBeInTheDocument();
	});

	it("a 404 outside the since view is a fallback, never an added or deleted label", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
		show(file());
		fireEvent.error(screen.getByAltText("Before"));
		await waitFor(() =>
			expect(screen.getByTestId("image-view")).toHaveAttribute(
				"data-image-state",
				"fallback",
			),
		);
		expect(screen.queryByText("added")).toBeNull();
	});

	it("several stale images at once: one review re-read", async () => {
		const read = heldJson();
		const reviewFetch = vi.fn(() => read.response.then((r) => r.json()));
		fetchMock.mockResolvedValue(new Response(null, { status: 409 }));
		const client = newQueryClient();
		client.setQueryData([...REVIEW_KEY], { revision: "r1" });
		function ReviewReader() {
			useQuery({
				queryKey: [...REVIEW_KEY],
				queryFn: reviewFetch,
				staleTime: Number.POSITIVE_INFINITY,
			});
			return null;
		}
		render(
			<QueryClientProvider client={client}>
				<ReviewReader />
				{[0, 1, 2].map((index) => (
					<ImageView
						key={index}
						file={file({ index, path: `img/${index}.png` })}
						revision="r1"
						sideBySide={false}
					/>
				))}
			</QueryClientProvider>,
		);
		for (const img of screen.getAllByAltText("After")) fireEvent.error(img);
		await waitFor(() =>
			expect(screen.getAllByText(STALE_MESSAGE)).toHaveLength(3),
		);
		expect(reviewFetch).toHaveBeenCalledTimes(1);
		await act(async () => read.release({ revision: "r1" }));
	});
});
