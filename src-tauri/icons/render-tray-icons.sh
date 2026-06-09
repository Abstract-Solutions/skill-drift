#!/usr/bin/env bash
# Renders the two menu-bar tray templates from one shared geometry, so the base
# and alert variants stay pixel-aligned (ADR-0013: "two template assets to keep
# visually in sync"). This is the authoritative recipe — the .svg files are
# human-readable design sources only; ImageMagick ignores their strokes, which is
# why the glyph is drawn here as -draw primitives instead (#10, commit d189222).
#
#   tray-icon.png        base   — git-branch glyph (plain = nothing Behind)
#   tray-icon-alert.png  alert  — same glyph + an exclamation (≥1 Skill Behind)
#
# Both are black+alpha so macOS inverts them for light/dark bars under
# icon_as_template(true). Geometry is authored in a 100x100 space (matching the
# SVGs) and downsampled to the committed 36x36. Run from anywhere; needs `magick`.
set -euo pipefail

cd "$(dirname "$0")"

# The git-branch glyph, shared by both variants (see tray-icon.svg): a left spine
# of two dots joined by a line, a third dot top-right, and a curve sweeping in.
branch='
  stroke-linecap round stroke-linejoin round
  fill none stroke black stroke-width 9
  line 30,24 30,76
  bezier 70,32 70,52 52,53 34,53
  stroke none fill black
  circle 30,24 30,33.5
  circle 30,76 30,85.5
  circle 70,24 70,33.5'

# The exclamation, placed in the empty bottom-right quadrant and pushed into the
# corner (x79) so it reads as a distinct mark, not a fourth branch dot or a stroke
# of the glyph (see tray-icon-alert.svg).
alert='
  stroke-linecap round fill none stroke black stroke-width 10
  line 79,55 79,71
  stroke none fill black
  circle 79,87 79,93.5'

render() { # <out.png> <draw-primitives>
  magick -size 100x100 xc:none \
    -draw "$2" \
    -resize 36x36 -background none -alpha on \
    "PNG32:$1"
}

render tray-icon.png "$branch"
render tray-icon-alert.png "$branch $alert"

echo "rendered tray-icon.png + tray-icon-alert.png (36x36 black+alpha)"
