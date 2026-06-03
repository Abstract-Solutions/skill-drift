# The background poll runs in a hidden webview, kept alive by disabling throttling

The popover window is created once at startup, hidden rather than closed, and
never destroyed — its webview hosts the TS engine (Manifest read, GitHub poll,
Behind compute) so all logic stays where ADR-0002 put it. Rust owns only the
native shell: the tray icon, created in `setup` so it exists before any webview
loads; `ActivationPolicy::Accessory` for a dock-less app; a tokio-interval
poll-clock that `emit`s a `poll-tick` event; and a `set_badge` command that
writes the Behind count to the tray title. The seam is a few narrow wires —
`poll-tick` down; `set_badge`, Keychain, and `read_manifest` commands up — and
Rust never gates correctness.

This only works because macOS WKWebView suspends a hidden webview, throttling its
timers and unloading the view after ~5 min, which would otherwise stop the
background poll dead. We set `backgroundThrottling: "disabled"` (Tauri 2.3+,
macOS 14+) on the window so the hidden webview keeps running. The cadence lives
in Rust, not a JS `setInterval`: a Rust-driven `emit` is the documented
background pattern, and a poll on webview mount plus the interval covers the
startup race where an `emit` can precede the webview's `listen`.

Status: accepted. The "badge" is tray title text — a menu-bar `NSStatusItem` has
no native badge (that is a dock-tile feature, irrelevant to a dock-less app).

## Considered options

- **Poll in Rust.** Rejected: re-derives the tested TS engine in a language the
  user reviews less fluently — the whole point of ADR-0002.
- **Poll only while the popover is visible** (no throttling override). Rejected:
  the badge would refresh only when opened, gutting the ambient awareness a
  menu-bar app exists for. Kept as the documented fallback if disabling
  throttling proves unreliable.

## Consequences

- **macOS 14.0+ floor** — `backgroundThrottling: "disabled"` is a no-op below it.
  Acceptable: personal/unsigned distribution (ADR-0001), dev machine is macOS 26.
- One untested edge — a hidden webview idle past 5 min and across sleep/wake — is
  the architecture's load-bearing assumption, so it is spiked first (sprint issue
  #1) before the rest is built on it.
