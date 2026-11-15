import {
	CheckIcon,
	FileBinaryIcon,
	FileCodeIcon,
	FileMediaIcon,
	type Icon,
} from "@primer/octicons-react";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { placeNear, Tooltip } from "../../Tooltip";
import type { RendererId } from "./index";

const SHOWN: Record<RendererId, { label: string; icon: Icon }> = {
	image: { label: "Image", icon: FileMediaIcon },
	text: { label: "Text", icon: FileCodeIcon },
	binary: { label: "Binary", icon: FileBinaryIcon },
};

/**
 * The file header's "Show as" chip: the current renderer's icon, opening a
 * menu of the file's `choices`. Picking only changes the view (`onPick`):
 * never a review state. Not shown when there is one choice.
 */
export function RendererChip(props: {
	current: RendererId;
	choices: readonly RendererId[];
	onPick: (id: RendererId) => void;
}) {
	const { current, choices } = props;
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement | null>(null);
	const menu = useRef<HTMLDivElement>(null);
	const menuId = useId();
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

	const close = (focus: boolean) => {
		setOpen(false);
		if (focus) button.current?.focus();
	};

	// Under the chip (above it near the window's bottom), inside the window:
	// fixed, so a closed file's clipped section or a phone's width never cut it.
	useLayoutEffect(() => {
		if (!open) {
			setPos(null);
			return;
		}
		const t = button.current?.getBoundingClientRect();
		const box = menu.current?.getBoundingClientRect();
		if (!t || !box) return;
		setPos(placeNear(t, box));
		const items = menu.current?.querySelectorAll<HTMLElement>(
			'[role="menuitemradio"]',
		);
		const checked = Array.from(items ?? []).find(
			(i) => i.getAttribute("aria-checked") === "true",
		);
		(checked ?? items?.[0])?.focus({ preventScroll: true });
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const outside = (e: Event) => {
			const target = e.target as Node;
			if (menu.current?.contains(target) || button.current?.contains(target)) {
				return;
			}
			setOpen(false);
		};
		// It's placed once: a scroll or a resize closes it.
		const away = (e: Event) => {
			if (e.target instanceof Node && menu.current?.contains(e.target)) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", outside, true);
		window.addEventListener("scroll", away, true);
		window.addEventListener("resize", away);
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			window.removeEventListener("scroll", away, true);
			window.removeEventListener("resize", away);
		};
	}, [open]);

	if (choices.length < 2) return null;
	const shown = SHOWN[current];
	const CurrentIcon = shown.icon;

	const onMenuKey = (e: KeyboardEvent) => {
		// The menu has the keys while open: none reaches the page's
		// shortcuts (src/web/shortcuts.tsx listens on the document).
		e.stopPropagation();
		const items = Array.from(
			menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ??
				[],
		);
		const at = items.indexOf(document.activeElement as HTMLElement);
		const move = (to: number) => {
			e.preventDefault();
			items[(to + items.length) % items.length]?.focus();
		};
		if (e.key === "ArrowDown") move(at + 1);
		else if (e.key === "ArrowUp") move(at - 1);
		else if (e.key === "Home") move(0);
		else if (e.key === "End") move(items.length - 1);
		else if (e.key === "Escape") {
			e.preventDefault();
			close(true);
		} else if (e.key === "Tab") close(false);
	};

	return (
		<>
			<Tooltip content="Show as…" describe={false} dismissKey={open}>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						ref={(el) => {
							trigger.ref(el);
							button.current = el;
						}}
						aria-label={`Show as: ${shown.label}`}
						aria-haspopup="menu"
						aria-expanded={open}
						aria-controls={open ? menuId : undefined}
						data-renderer={current}
						onClick={() => setOpen((o) => !o)}
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-expanded:bg-pressed aria-expanded:text-ink @lg:h-8 @lg:w-8 pointer-coarse:@lg:h-10 pointer-coarse:@lg:w-10"
					>
						<CurrentIcon aria-hidden />
					</button>
				)}
			</Tooltip>
			{open &&
				createPortal(
					<div
						ref={menu}
						id={menuId}
						role="menu"
						aria-label="Show as"
						onKeyDown={onMenuKey}
						// Not up to the file header, through the portal.
						onClick={(e) => e.stopPropagation()}
						style={{
							left: pos?.left ?? 0,
							top: pos?.top ?? 0,
							visibility: pos ? "visible" : "hidden",
						}}
						className="fixed z-50 min-w-36 rounded-lg border border-edge bg-overlay p-1 text-ink shadow-float"
					>
						{choices.map((id) => {
							const { label, icon: ItemIcon } = SHOWN[id];
							return (
								<button
									key={id}
									type="button"
									role="menuitemradio"
									aria-checked={id === current}
									tabIndex={-1}
									onClick={() => {
										close(true);
										if (id !== current) props.onPick(id);
									}}
									className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm hover:bg-pressed focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
								>
									<ItemIcon aria-hidden className="text-muted" />
									<span className="flex-1">{label}</span>
									<CheckIcon
										aria-hidden
										className={id === current ? "text-accent" : "invisible"}
									/>
								</button>
							);
						})}
					</div>,
					document.body,
				)}
		</>
	);
}
