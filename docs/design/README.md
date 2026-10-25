# carbonless design language

Dark, calm surfaces; color only where it means something; one burst of
brand color in the logo and a few gradient touches. Reference:
[brand-board.jpg](brand-board.jpg) (ignore its tagline and URL: there is none).

## Tokens

All colors live in one place, the `@theme` block of `src/web/index.css`
(Tailwind's own palette is switched off). Use them as Tailwind colors:
`bg-surface`, `text-muted`, `border-line`, `bg-ok/10`. Every pair the UI
uses is checked for WCAG AA in `src/web/theme.test.ts`; add new pairs there.

| Token | Use |
| --- | --- |
| `canvas` `surface` `raised` `overlay` `pressed` | page, cards/header, section and file headers, tooltips/hover, pressed |
| `line` / `line-strong` / `edge` | decorative dividers / outlines of controls (3:1) / floating layers, scrollbars |
| `ink` `ink-soft` `muted` `faint` | text, strongest to weakest (all 4.5:1 on every surface) |
| `label` | letter-spaced violet capitals for section labels |
| `accent` `link` | focus rings, the pointed-at cluster rail, selected segment, current file; links |
| `add-done` `del-done` | reviewed lines: quieter add/del tints, text at full contrast |
| `shade`, `shadow-*` | the one shadow color and the shadows built from it |
| `magenta` `orange` `yellow` `teal` `violet` | brand: logo, gradients (`brand-rule`, `cta`), never meaning |

## Color semantics

Code-review conventions win over the brand palette:

- **Added / reviewed / approved / passing** = green (`ok`, `ok-fill`, `add*`), leaning teal to sit with the palette.
- **Deleted / failing / changes requested / conflicts** = red (`bad`, `del*`), leaning magenta.
- **Pending / warning / partly done** = yellow (`warn`, the brand yellow).
- **Merged / crossed off** = violet (`done`, `crossed*`); crossed off is always hatched (`hatch`) or marked ⊘.
- **Unreviewed** = neutral grey (`unreviewed`).
- Accent and links are periwinkle rather than a palette hue: the palette has
  no blue, its violet would read as crossed off, and teal as green; periwinkle
  is the familiar link/focus blue, nudged toward the violet, at 4.5:1+.
- The draft badge is grey in "What it does", as on GitHub.
- Brand gradient only where no convention exists: the active tab's underline, primary actions (`cta`), the header glow, the logo.

Syntax highlighting (`src/web/files/syntaxTheme.ts`) uses lightened brand
hues, each at least 25° of hue from the added and deleted inks (keywords are
orchid, not pink), so it never competes with added and deleted lines. The
contrast test enforces both the 4.5:1 and the hue gap.

Reviewed clusters are not dimmed with opacity (that broke 4.5:1): their
add/del tints fade to `add-done`/`del-done`, with the green rail and checked
box marking them.

## Typography

- Outfit (variable, bundled via `@fontsource-variable/outfit`, no CDN) for UI
  text and headings; `font-display` for titles and the wordmark (ExtraBold).
- Code, file names, paths and SHAs stay in the system monospace stack
  (`font-mono`, `<code>`), in tooltips too (`TooltipPath`).

## Logo

- `src/web/brand/logo.svg`: the full mark (gradient ring, split diff, splashes). 40px and up.
- `src/web/brand/mark.svg`: simplified (ring, diff, handle): favicon and the compact header.
  PNG fallbacks in `src/web/public` come from `pnpm icons`.
- `Wordmark` (`src/web/brand/Brand.tsx`): "carbonless" in Outfit ExtraBold with a star "o".

## Changelog

- **Fix round 1.**
  - Paths in tooltips (tree file and folder, file header) and the snapshot SHA are now monospace. This is asserted in FileTree.test and files.spec.
  - The star "o" has fatter, longer arms (r 190, k 0.29), and the desktop wordmark is 28px.
  - Syntax keywords moved from pink to orchid, functions to cyan and types to periwinkle; `invalid` is amber. The test checks that every syntax hue stays at least 25° from the add/del inks.
  - The header glow, selection, CTA glow and shadows are built from tokens with `color-mix`. Tests check the theme-color meta and Shiki's background against their tokens.
  - The contrast test now also covers:
    - the focus ring on overlay, pressed, hunk, add/del, gutters and the current tree row;
    - errors on hunk rows;
    - ink on the CTA count chip;
    - reviewed lines.
  - Reviewed lines no longer use opacity.
  - The compact mark sits in a fixed 28px slot that fades and scales, so the tabs don't shift.
