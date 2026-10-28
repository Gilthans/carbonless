import { XIcon } from "@primer/octicons-react";
import {
	createContext,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { usePageActive } from "./pageActive";

export type ShortcutGroup = "Global" | "Files changed" | "Overview" | "Threads";

/**
 * A keyboard shortcut. `keys` is the key (`e.key`: "c", "?", "Enter"),
 * after any modifiers joined by "+": "Mod" (Ctrl, or Cmd on a Mac), "Ctrl",
 * "Meta", "Alt", "Shift" (only for named keys: "?" is already shifted).
 */
export interface Shortcut {
	keys: string;
	label: string;
	group: ShortcutGroup;
	when?: () => boolean;
	run: (e: KeyboardEvent) => void;
}

type HelpEntry = Omit<Shortcut, "run" | "when">;

const GROUPS: ShortcutGroup[] = [
	"Global",
	"Files changed",
	"Overview",
	"Threads",
];

/** Listed always: `?` itself, and Escape, which menus and dialogs handle. */
const BUILT_IN: HelpEntry[] = [
	{ keys: "?", label: "Keyboard shortcuts", group: "Global" },
	{ keys: "Escape", label: "Close a menu or dialog", group: "Global" },
];

/** The page showing, by its URL (the help puts its group first). */
function currentPageGroup(): ShortcutGroup {
	return /\/files\/?$/.test(window.location.pathname)
		? "Files changed"
		: "Overview";
}

interface Registered {
	entry: HelpEntry;
	/** Help-only entries have no `run`. */
	shortcut?: { current: Shortcut };
	active?: { current: boolean };
}

/** What's registered, and a snapshot for the help (useSyncExternalStore). */
class Registry {
	#items = new Map<string, Registered>();
	#listeners = new Set<() => void>();
	#snapshot: Registered[] = [];
	set(id: string, item: Registered) {
		this.#items.set(id, item);
		this.#changed();
	}
	delete(id: string) {
		if (this.#items.delete(id)) this.#changed();
	}
	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};
	snapshot = () => this.#snapshot;
	#changed() {
		this.#snapshot = [...this.#items.values()];
		for (const l of this.#listeners) l();
	}
}

interface Ctx {
	registry: Registry;
	openHelp: () => void;
}

const ShortcutsContext = createContext<Ctx | null>(null);

const isMac = () =>
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Whether `e` is the key `keys` names (see `Shortcut`). */
export function matchesKeys(keys: string, e: KeyboardEvent): boolean {
	const parts = keys.split("+");
	// "+" itself would be the last, empty part.
	const key = parts.at(-1) === "" ? "+" : (parts.at(-1) as string);
	const mods = new Set(parts.slice(0, parts.at(-1) === "" ? -2 : -1));
	const mod = mods.has("Mod");
	const ctrl = mods.has("Ctrl") || (mod && !isMac());
	const meta = mods.has("Meta") || (mod && isMac());
	if (e.ctrlKey !== ctrl || e.metaKey !== meta) return false;
	if (e.altKey !== mods.has("Alt")) return false;
	// A printed character carries its own Shift ("?", "C").
	if (key.length === 1) return e.key === key;
	return e.shiftKey === mods.has("Shift") && e.key === key;
}

const TEXT_INPUTS = new Set([
	"",
	"text",
	"search",
	"email",
	"url",
	"tel",
	"password",
	"number",
	"date",
	"datetime-local",
	"month",
	"time",
	"week",
]);

/** Typing goes to this element: a text field, a select or contenteditable. */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	if (target instanceof HTMLTextAreaElement) return true;
	if (target instanceof HTMLSelectElement) return true;
	if (target instanceof HTMLInputElement) {
		return TEXT_INPUTS.has((target.getAttribute("type") ?? "").toLowerCase());
	}
	return (
		target.closest('[contenteditable]:not([contenteditable="false"])') !== null
	);
}

/** A modal dialog is open (other than `except`): shortcuts stay out of it. */
function otherModalOpen(except: HTMLDialogElement | null): boolean {
	for (const d of document.querySelectorAll("dialog[open]")) {
		if (d === except) continue;
		try {
			if (d.matches(":modal")) return true;
		} catch {
			// No :modal (an older engine): no modal dialogs either.
		}
	}
	return false;
}

/**
 * Registers `s` while mounted. It runs on its key, unless typing in a
 * field, a modal dialog is open, `when` says no, or the kept page it was
 * registered in is hidden (whatever its group: both pages show threads).
 * The help lists it whatever `when` says.
 */
export function useShortcut(s: Shortcut): void {
	const ctx = useContext(ShortcutsContext);
	const id = useId();
	const latest = useRef(s);
	latest.current = s;
	const pageActive = usePageActive();
	const active = useRef(pageActive);
	active.current = pageActive;
	const { keys, label, group } = s;
	useEffect(() => {
		if (!ctx) return;
		ctx.registry.set(id, {
			entry: { keys, label, group },
			shortcut: latest,
			active,
		});
		return () => ctx.registry.delete(id);
	}, [ctx, id, keys, label, group]);
}

/** Static entries for keys handled elsewhere (Ctrl/Cmd+Enter, Escape…), listed in the help only. */
export function useShortcutHelp(
	entries: Omit<Shortcut, "run" | "when">[],
): void {
	const ctx = useContext(ShortcutsContext);
	const id = useId();
	const json = JSON.stringify(entries);
	useEffect(() => {
		if (!ctx) return;
		const list = JSON.parse(json) as HelpEntry[];
		for (const [i, entry] of list.entries()) {
			ctx.registry.set(`${id}:${i}`, { entry });
		}
		return () => {
			for (let i = 0; i < list.length; i++) ctx.registry.delete(`${id}:${i}`);
		};
	}, [ctx, id, json]);
}

/** Opens the help (the Settings menu's entry). */
export function useOpenShortcutsHelp(): () => void {
	const ctx = useContext(ShortcutsContext);
	return ctx?.openHelp ?? noop;
}

const noop = () => {};

/**
 * The one keydown listener for every registered shortcut, and the help:
 * `?` (outside a text field) toggles it.
 */
export function ShortcutsProvider(props: { children: ReactNode }) {
	const [registry] = useState(() => new Registry());
	const [open, setOpen] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);
	const openHelp = useCallback(() => setOpen(true), []);
	const [ctx] = useState<Ctx>(() => ({ registry, openHelp }));
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.isComposing) return;
			if (isTypingTarget(e.target)) return;
			const help = dialog.current;
			const helpOpen = help?.hasAttribute("open") ?? false;
			if (otherModalOpen(help)) return;
			if (matchesKeys("?", e)) {
				e.preventDefault();
				setOpen((o) => !o);
				return;
			}
			if (helpOpen) return;
			for (const item of registry.snapshot()) {
				const s = item.shortcut?.current;
				if (!s || !matchesKeys(s.keys, e)) continue;
				if (item.active?.current === false) continue;
				if (s.when && !s.when()) continue;
				e.preventDefault();
				s.run(e);
				return;
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [registry]);
	return (
		<ShortcutsContext.Provider value={ctx}>
			{props.children}
			<ShortcutsHelp
				open={open}
				onClose={() => setOpen(false)}
				dialog={dialog}
				registry={registry}
			/>
		</ShortcutsContext.Provider>
	);
}

/** One key as caps: "Mod+Enter" → [Ctrl] + [Enter] (⌘ on a Mac). */
function Keys({ keys }: { keys: string }) {
	const names: Record<string, string> = {
		Mod: isMac() ? "⌘" : "Ctrl",
		Meta: "⌘",
		Escape: "Esc",
	};
	const parts = keys === "+" ? ["+"] : keys.split("+");
	return (
		<span className="flex shrink-0 items-center gap-1 text-xs text-muted">
			{parts.map((p, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list.
				<span key={i} className="flex items-center gap-1">
					{i > 0 && <span aria-hidden>+</span>}
					<kbd className="min-w-6 rounded border border-line-strong bg-raised px-1.5 py-0.5 text-center font-mono text-xs text-ink shadow-[inset_0_-1px_0_var(--color-line-strong)]">
						{names[p] ?? p}
					</kbd>
				</span>
			))}
		</span>
	);
}

/** The groups and their entries for the help, the current page's group first. */
export function helpGroups(
	items: Registered[],
	current: ShortcutGroup,
): { group: ShortcutGroup; entries: HelpEntry[] }[] {
	const seen = new Set<string>();
	const entries: HelpEntry[] = [];
	for (const e of [...BUILT_IN, ...items.map((i) => i.entry)]) {
		const k = `${e.group}\n${e.keys}\n${e.label}`;
		if (seen.has(k)) continue;
		seen.add(k);
		entries.push(e);
	}
	const order = [current, ...GROUPS.filter((g) => g !== current)];
	return order
		.map((group) => ({
			group,
			entries: entries.filter((e) => e.group === group),
		}))
		.filter((g) => g.entries.length > 0);
}

/**
 * The help: a modal listing every shortcut by group, keys as caps. Escape,
 * `?`, Close or the backdrop close it; focus stays inside and goes back
 * where it was.
 */
function ShortcutsHelp(props: {
	open: boolean;
	onClose: () => void;
	dialog: RefObject<HTMLDialogElement | null>;
	registry: Registry;
}) {
	const { open, dialog } = props;
	const items = useSyncExternalStore(
		props.registry.subscribe,
		props.registry.snapshot,
	);
	const titleId = useId();
	const closeButton = useRef<HTMLButtonElement>(null);
	const returnTo = useRef<Element | null>(null);
	// A passive effect after the page's own (the help renders after them):
	// a menu that opened the help has closed, focus back on its button,
	// before focus is noted.
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (!open) {
			if (!d.hasAttribute("open")) return;
			if (typeof d.close === "function") d.close();
			else d.removeAttribute("open");
			const back = returnTo.current;
			returnTo.current = null;
			if (back instanceof HTMLElement && back.isConnected) back.focus();
			return;
		}
		if (d.hasAttribute("open")) return;
		returnTo.current = document.activeElement;
		if (typeof d.showModal === "function") d.showModal();
		else d.setAttribute("open", "");
		closeButton.current?.focus();
	}, [open, dialog]);
	const groups = open ? helpGroups(items, currentPageGroup()) : [];
	/** Tab cycles inside the dialog. */
	const trap = (e: ReactKeyboardEvent<HTMLDialogElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			props.onClose();
			return;
		}
		if (e.key !== "Tab") return;
		const d = dialog.current;
		if (!d) return;
		const focusable = [
			...d.querySelectorAll<HTMLElement>(
				'button, [href], [tabindex]:not([tabindex="-1"])',
			),
		];
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};
	return (
		<dialog
			ref={dialog}
			aria-labelledby={titleId}
			data-testid="shortcuts-help"
			onCancel={(e) => {
				e.preventDefault();
				props.onClose();
			}}
			onKeyDown={trap}
			onClick={(e) => {
				// A click on the backdrop lands on the dialog itself.
				if (e.target === dialog.current) props.onClose();
			}}
			className="m-auto max-h-[85dvh] w-[min(30rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-lg border border-edge bg-surface p-0 text-ink shadow-float backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px] open:flex open:flex-col"
		>
			<div className="flex shrink-0 items-center justify-between border-b border-line py-1 pr-1 pl-4">
				<h2
					id={titleId}
					className="text-xs font-semibold tracking-[0.18em] text-label uppercase"
				>
					Keyboard shortcuts
				</h2>
				<button
					ref={closeButton}
					type="button"
					aria-label="Close"
					onClick={props.onClose}
					className="flex h-10 w-10 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					<XIcon aria-hidden />
				</button>
			</div>
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pt-3 pb-4">
				{groups.map(({ group, entries }) => (
					<section key={group} aria-label={group}>
						<h3 className="mb-1 text-xs font-semibold text-muted">{group}</h3>
						<ul>
							{entries.map((e) => (
								<li
									key={`${e.keys}\n${e.label}`}
									className="flex min-h-8 items-center justify-between gap-4 border-b border-line py-1 text-sm last:border-b-0"
								>
									<span className="min-w-0">{e.label}</span>
									<Keys keys={e.keys} />
								</li>
							))}
						</ul>
					</section>
				))}
			</div>
		</dialog>
	);
}
