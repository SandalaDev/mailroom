# abemail design system

The interface borrows Linear's structure and Stripe's semantics. Linear contributes the quiet sidebar, the single inset content panel, status glyphs on dense rows, the command menu and keyboard flow. Stripe contributes tinted status badges, metric tiles and right-side detail drawers. Light and dark themes follow the system setting; the command menu can override it.

## Logo

Bold A with a paper-plane cut through it, followed by a lowercase geometric wordmark. Lifted from the airmail mark.

| File | Use |
| --- | --- |
| `brand/logo.svg` | Lockup, black on light |
| `brand/logo-reversed.svg` | Lockup, white on dark |
| `brand/mark.svg` | A alone |
| `brand/app-icon.svg` | A on a black rounded square; favicon |

`node scripts/brand.mjs` generates all four and inlines the lockup and favicon into `public/index.html`. Edit the script, not the SVGs. The wordmark is stroke geometry, so it renders without a font. In the app the logo takes `currentColor` and the plane facet uses `--facet`, so it works in both themes.

## Files

| File | Holds |
| --- | --- |
| `public/tokens.css` | Every color, type, radius and motion token, with light and dark values |
| `public/style.css` | Components, built only from tokens |
| `public/ui.js` | Motion helpers, toasts, sliding indicators, view transitions, command menu, shortcuts |
| `public/index.html` | Shell markup and the inline icon sprite |

## Color

Neutrals carry a faint indigo bias so they sit with the accent. The accent (`--accent`, indigo) is for interaction only: primary buttons, focus rings, selection, the active nav icon. Status color is separate and always paired with a label and a glyph.

| Destination | Glyph | Badge |
| --- | --- | --- |
| Needs you | Red square with ! | `--urgent` tint |
| Review | Amber half circle | `--warning` tint |
| Digest | Blue filled circle | `--info` tint |
| Archive | Green check circle | `--positive` tint |
| Holding | Gray dashed circle | `--neutral` tint |
| Awaiting Clef | Dotted circle, slowly spinning | neutral |

Badges follow Stripe: tinted fill at about 10% with a darker text shade. Each semantic color has `--x`, `--x-tint` and `--x-text`.

## Type

System UI faces: Segoe UI Variable Text for UI, Segoe UI Variable Display for headings, Cascadia for message bodies. No webfonts (the CSP allows only same-origin resources). Scale: 11.5, 12.5, 13.5 (body), 15, 20, 28 (metrics). Weights 400, 500, 600. Every figure uses tabular numerals.

## Layout

- Sidebar (236px) on the `--bg` layer: logo, search trigger, three labelled groups (Mail, Tools, Workspace), usage card, connection status.
- One inset panel (`--surface`, 14px radius) holds a sticky translucent top bar and the page content, capped at 1080px.
- The Queue opens with a setup checklist (only while unconnected), three metric tiles that act as filters, a segmented filter with counts, then the message list.
- Message rows: status glyph, sender, subject over preview, badge, time, and a chevron on hover. Under 760px of list width the row stacks.
- Message and cleanup details open as drawers from the right edge (bottom sheet on phones). Confirmations and usage open as centered modals.
- Below 860px the sidebar becomes a sticky top bar with scrolling tabs.

## Motion

Motion explains what changed and where things went. Everything is built on three curves and four durations in `tokens.css`, and all of it switches off under `prefers-reduced-motion`.

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | expo out | Entrances, fades, color changes |
| `--ease-spring` | slight overshoot | Indicators, checks, icons, anything that lands in place |
| `--t-micro` / `--t-s` / `--t-m` / `--t-l` | 120 / 200 / 340 / 520ms | Press, hover, move, enter |

What moves and why:

- **Navigation:** the sidebar highlight slides to the chosen page. Content changes through a view transition that slides up when you move down the sidebar and down when you move up, with the page title crossfading.
- **Lists:** rows that stay glide to their new position (FLIP). New rows rise in with a short stagger. A row whose destination changed flashes once. Polling with no changes causes no motion.
- **Numbers:** counts tween to their new value and pulse in the accent color.
- **Filters:** the segmented thumb springs between options; metric tiles jump to their filter.
- **Buttons:** press scales to 97%. Async actions show a spinner after 140ms (none on fast calls), a drawn check on success, a shake on failure. Primary buttons lift 1px on hover.
- **Toasts:** rise from the bottom right. A thin bar shows time remaining, hover pauses it, and errors shake once.
- **Dialogs:** drawers slide in from the right and their contents stagger in; modals and the command menu scale up from 96%. All of them animate out and the backdrop fades.
- **Disclosure and checks:** details panels animate their height, checkbox ticks spring in, the setup checklist fills each step as it connects.
- **Status:** a sweeping bar under the top bar while a check or cleanup scan runs, a pulsing dot on Connections while setup is incomplete, and a breathing health indicator in Activity.

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl/Cmd K or / | Command menu (pages, actions, theme) |
| 1 to 9 | Jump to sidebar pages in order |
| J / K | Move through message rows |
| Enter or O | Open the selected row |
| R | Refresh |
| Esc | Close dialogs, clear row selection |

## Copy

Say what it is or what happened. Labels are nouns ("Queue", "Rules"), buttons are verbs ("Check now", "Save"). No taglines. Toasts state the result and what did not change ("Correction saved locally. Gmail unchanged.").
