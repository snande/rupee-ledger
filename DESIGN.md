# Design

The design brief for this project's user interface. Read it before any interface work and build against it: the tokens, type, spacing, component conventions and states below are the contract, and the anti-patterns are what a screen must not do.

## Audience and tone

For everyday Indian earners who track small daily spends on their phone; calm, quick and quietly reassuring, like a well-kept paper khata that adds itself up.

## Palette

- `paper` `#FAF6EE` — app background, warm off-white like ledger paper
- `card` `#FFFFFF` — surfaces: entry rows, total cards, sheets
- `ink` `#1F2A2E` — primary text and amounts
- `muted` `#6B7471` — secondary text, timestamps, category labels, dividers at 20% opacity
- `haldi` `#D98E04` — accent: primary action, focus ring, today's total highlight, active tab
- `sindoor` `#C2412D` — danger: delete, failed import, month-over-month increase

## Typefaces

- Inter — UI text, labels, entry descriptions, buttons
- JetBrains Mono — all rupee amounts and totals, tabular figures so columns align

## Type scale

- 12/14/16/20/28/40

## Spacing scale

- 4/8/12/16/24/32/48

## Components

- **quick-entry input** — Pinned at the bottom of the Today screen above the tab bar, full width, 56px tall, 16px text so iOS does not zoom, placeholder '120 chai'. Enter saves, clears the field and keeps focus. Below it, a live parse preview in muted 12px reads '₹120 · Tea & snacks'. Invalid input shakes once and shows an inline hint, never a modal.
- **buttons** — Primary: haldi fill, ink text, 12px radius, minimum 48px height. Secondary: card fill with 1px muted border. Destructive: sindoor text, and it always asks for confirmation. Every button has a label; icon-only buttons are allowed only in the tab bar and must carry an aria-label.
- **entry list** — Group rows by day, with a sticky day header that shows the day total on the right. Each row puts the description and category chip on the left and the amount right-aligned in mono. Tap a row to edit it in a bottom sheet. Swipe left to delete, with a 5-second undo toast. A new entry animates in at the top with a brief haldi flash.
- **total cards** — Two cards side by side, Today and This month. Each shows a 12px muted label and a 28px mono amount with ₹ and Indian digit grouping (₹1,23,450). Values update in the same frame as the save.
- **category chips** — Pill shape at 12px, tinted from a fixed 8-colour category set derived from the palette, muted text. Tapping the chip on an entry lets the user recategorise it, and the app remembers that keyword for next time.
- **pie chart** — Donut with the month total centred in mono. Show at most 7 slices, sorted largest first, with the rest merged into 'Other'. A legend list under the chart gives colour, category, amount and percentage. Tapping a slice filters the entry list. There are no 3D effects and no labels on the slices.
- **month comparison** — Two month pickers, A vs B. Show a paired horizontal bar per category in mono. The delta column is sindoor when spending went up and ink when it went down, with a ▲/▼ glyph so colour is never the only signal.
- **search** — A top search field that filters live on description, category and amount, and highlights the matched text. The result count and summed total appear above the results.
- **backup** — Settings screen with Export backup and Import backup buttons. Export downloads or shares a dated .json file. Import previews the entry count and date range before merging, then reports how many entries were added and how many were skipped as duplicates. Show the last backup date prominently.
- **offline badge** — A small muted 'Offline — saved on this phone' pill in the header when there is no network. It is informational only and never blocks anything.

## States every screen carries

- empty: Today shows a friendly prompt with the example '120 chai' and an arrow to the input; the monthly view shows 'No spends this month yet' in place of the chart
- loading: skeleton rows and cards in paper tone for at most a moment; the local database should make these rare, and there are no spinners on save
- error: inline sindoor message next to the cause (bad entry, corrupt backup file) with a plain next step; data is never lost silently
- success: an entry is confirmed by the row appearing and the totals ticking over, with no toast; import and export get a short confirmation toast with counts
- offline: fully functional, with the badge only

## Copy voice

Short, plain and warm Indian English. Write amounts as ₹ with Indian grouping. Use verbs on buttons ('Add', 'Export backup', 'Undo'). Say 'spends', not 'transactions'. Error messages name the problem and the fix. There is no jargon, no exclamation marks, and no guilt about spending.

## Anti-patterns

- generic system font as the identity
- unstyled native selects, date pickers or file inputs
- modal dialogs for adding an entry
- western number grouping (1,234,567) or $ signs
- cloud, sign-in or account prompts; the ledger is private to the device
- 3D or exploded pie charts, and more than 7 slices
- colour-only meaning in the comparison view
- template dashboard chrome, hamburger menus and cluttered headers
- spinners or delays on save
- tiny tap targets under 44px

<!-- never-stop design-brief sha256:d4da2f8f296f5521f2703f8c3a4de2d935c575f8e7ff6b2d57db7602f83d349b -->
