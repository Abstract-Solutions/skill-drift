# The menu-bar signal is a binary mark, not a Behind count

The tray signals "attention needed" by swapping to a second template icon with an
exclamation baked in whenever any Skill is Behind; it no longer writes the Behind
count to the tray title. The exact counts stay in the menu rows (`· N behind`) — the
bar answers only "is anything Behind?". This revises ADR-0005's consequence that
`set_badge` writes the count as title text: the seam wire becomes an icon swap
(`set_alert(on)` toggling `tray.set_icon_with_as_template` between a base and an
alert template, both `include_image!`-embedded), and the tray title stays empty.
(The `_with_as_template` form, not plain `set_icon` — on macOS the latter resets
the template flag, so the swapped icon would stop inverting; see lib.rs.)

Binary matches the domain: CONTEXT.md already defines Behind as "the tray **badges
when any Skill is Behind**" — a trigger, not a tally. The numeric title also collided
with the per-row `· N behind`: the title's `2` counted Behind *Skills* while each row's
`1 behind` counted *Watched Commits* — two different numbers in one menu. A mark
removes the ambiguity.

Status: accepted. Revises ADR-0005's badge consequence (count-as-title-text);
ADR-0005 otherwise stands. Keeps ADR-0009 / #10's template-icon choice — the alert
variant is also black+alpha, so macOS inverts it for light/dark like the base.

## Considered options

- **Colored (non-template) alert icon.** Pops at a glance like Docker and matches the
  dropdown's saturated `🔴`/`🟠` dots. Rejected: it won't auto-invert and deviates
  from #10's pure-template icon; the menu bar leans monochrome by macOS convention, and
  an exclamation carries the signal by shape without breaking the template. Kept as the
  documented fallback if the monochrome shape-change proves too subtle in practice.
- **Keep the count, just disambiguate it.** Rejected: the at-a-glance value of the
  total is low (rarely more than a few Behind), and the glossary's intent is binary.
- **Title glyph `!` instead of an icon swap.** Rejected: reads as text beside the icon,
  not part of the glyph; the integrated mark is the more native, Docker-faithful form.

## Consequences

- A new Rust↔TS wire replaces `set_badge`: `set_alert(on: bool)`, and the view passes
  `out.kind === "ok" && out.behind > 0`. The count stays computed (`out.behind`) — the
  rows still need it.
- The distinction is by shape: users learn "plain branch = ok, branch + `!` = check it."
- Two template assets to keep visually in sync (base + alert).
