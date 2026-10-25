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
| `magenta` `orange` `yellow` `teal` `violet` | brand: logo, gradients (`brand-rule`, `cta`), never meaning |

## Color semantics

Code-review conventions win over the brand palette:

- **Added / reviewed / approved / passing** = green (`ok`, `ok-fill`, `add*`), leaning teal to sit with the palette.
- **Deleted / failing / changes requested / conflicts** = red (`bad`, `del*`), leaning magenta.
- **Pending / warning / partly done** = yellow (`warn`, the brand yellow).
- **Merged / crossed off** = violet (`done`, `crossed*`); crossed off is always hatched (`hatch`) or marked ⊘.
- **Unreviewed** = neutral grey (`unreviewed`).
- Brand gradient only where no convention exists: the active tab's underline, primary actions (`cta`), the header glow, the logo.

Syntax highlighting (`src/web/files/syntaxTheme.ts`) uses lightened brand hues
and no greens or reds, so it never competes with added and deleted lines.

## Typography

- Outfit (variable, bundled via `@fontsource-variable/outfit`, no CDN) for UI
  text and headings; `font-display` for titles and the wordmark (ExtraBold).
- Code, file names and paths stay in the system monospace stack (`font-mono`, `<code>`).

## Logo

- `src/web/brand/logo.svg`: the full mark (gradient ring, split diff, splashes). 40px and up.
- `src/web/brand/mark.svg`: simplified (ring, diff, handle): favicon and the compact header.
  PNG fallbacks in `src/web/public` come from `pnpm icons`.
- `Wordmark` (`src/web/brand/Brand.tsx`): "carbonless" in Outfit ExtraBold with a star "o".
