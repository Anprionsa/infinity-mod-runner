#!/usr/bin/env python3
"""Build installer-asset images from the app icon + a system serif font.

Produces three files under src-tauri/installer-assets/:

    nsis-sidebar.bmp    164 x 314  — NSIS Welcome + Finish page graphic
    nsis-header.bmp     150 x  57  — NSIS install-page header banner
    dmg-background.png  660 x 400  — macOS DMG Finder-window background

Design notes:
    - Palette matches theme.css: --bg #0a0a14, --bg2 #1a1a2e, --gold
      #d4af37, --txd #a0a0a0. We hardcode the hex values here to avoid
      parsing CSS; when the app palette moves, this file moves with it.
    - Typography aims at "Cinzel serif + Source Sans 3 body", same as
      in-app. PIL can't read .woff2 directly and the repo doesn't ship
      .ttf for Cinzel, so we fall back to Georgia Bold — the exact
      fallback chain declared in theme.css (`'Cinzel', Georgia, serif`).
      Matches what users without Cinzel installed would see anyway, so
      the installer is consistent with the in-app appearance for those
      users. On a machine with real Cinzel TTFs installed, swap the
      FONT_DISPLAY path to use those.
    - All text is rendered at 2x and downscaled for anti-aliased edges
      (PIL's truetype rendering alone produces blocky output at the
      small sizes NSIS uses).
    - BMP output is 24-bit uncompressed (NSIS's preferred format). PIL
      writes PNG-format transparent art fine for the DMG; NSIS needs
      opaque BMP so we composite over the background color explicitly.

Run:
    python scripts/build-installer-assets.py

Re-runnable; output is deterministic given the same inputs.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except ImportError:
    print("ERROR: Pillow is required. Install with: pip install pillow")
    sys.exit(1)

# ─── Paths ───

REPO_ROOT = Path(__file__).resolve().parent.parent
ICON_PATH = REPO_ROOT / "src-tauri" / "icons" / "icon.png"
OUT_DIR = REPO_ROOT / "src-tauri" / "installer-assets"

# Font discovery: Windows ships Georgia; macOS/Linux may not. Fall back
# through a prioritized list. Failing all of these, PIL will use its
# default bitmap font, which looks terrible at display sizes — but the
# script will at least complete so placeholder-quality assets exist.
FONT_CANDIDATES_DISPLAY = [
    # Preferred: actual Cinzel if available locally
    r"C:\Windows\Fonts\Cinzel-Bold.ttf",
    "/Library/Fonts/Cinzel-Bold.ttf",
    "/usr/share/fonts/truetype/cinzel/Cinzel-Bold.ttf",
    # Fallback: Georgia (our CSS fallback chain)
    r"C:\Windows\Fonts\georgiab.ttf",
    "/Library/Fonts/Georgia Bold.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Georgia_Bold.ttf",
    # Desperate: DejaVu Serif
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
]

FONT_CANDIDATES_BODY = [
    r"C:\Windows\Fonts\segoeui.ttf",
    "/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]

FONT_CANDIDATES_BODY_ITALIC = [
    r"C:\Windows\Fonts\segoeuii.ttf",
    r"C:\Windows\Fonts\ariali.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf",
]


def find_font(candidates: list[str]) -> str | None:
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


FONT_DISPLAY = find_font(FONT_CANDIDATES_DISPLAY)
FONT_BODY = find_font(FONT_CANDIDATES_BODY)
FONT_BODY_ITALIC = find_font(FONT_CANDIDATES_BODY_ITALIC)

if not FONT_DISPLAY or not FONT_BODY:
    print(f"WARNING: font fallback triggered. display={FONT_DISPLAY!r} body={FONT_BODY!r}")

# ─── Palette ───
# These hex values must track `src/theme.css` — comments map them to the
# matching CSS custom properties.
BG_DARK = (10, 10, 20)       # --bg #0a0a14
BG_MID = (26, 26, 46)        # --bg2 #1a1a2e
GOLD = (212, 175, 55)        # --gold #d4af37
GOLD_DIM = (139, 112, 48)    # darker gold for subtle elements
TX_DIM = (160, 160, 160)     # --txd #a0a0a0
TX_FAINT = (112, 112, 112)   # dimmer still — for bypass-instruction text
BORDER = (51, 51, 51)        # --brd #333


def load_icon(size: int) -> Image.Image:
    """Load and resize the app icon with high-quality downsampling."""
    icon = Image.open(ICON_PATH).convert("RGBA")
    return icon.resize((size, size), Image.Resampling.LANCZOS)


def vertical_gradient(width: int, height: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """Two-stop vertical gradient. Simpler than per-pixel loops and fast enough."""
    gradient = Image.new("RGB", (1, height), top)
    draw = ImageDraw.Draw(gradient)
    for y in range(height):
        t = y / max(height - 1, 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        draw.point((0, y), (r, g, b))
    return gradient.resize((width, height), Image.Resampling.NEAREST)


def font(path: str | None, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    return ImageFont.load_default()


def draw_text_centered_2x(
    img: Image.Image,
    text: str,
    y: int,
    font_path: str | None,
    size: int,
    fill: tuple[int, int, int],
) -> None:
    """Render text at 2x size into a transparent overlay, downscale with
    LANCZOS, then paste onto `img`. Produces much cleaner small-size text
    than PIL's default truetype rasterizer, especially for serif faces.

    Layout: the caller's `y` is the top edge of a band `size * 3` px tall
    in which the actual text sits near the top — the extra space below
    accommodates descenders and vertical spacing without callers needing
    to hand-tune per-line heights."""
    overlay = Image.new("RGBA", (img.width * 2, size * 3 * 2), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    f2x = font(font_path, size * 2)
    bbox = od.textbbox((0, 0), text, font=f2x)
    tw = bbox[2] - bbox[0]
    ox = (overlay.width - tw) // 2 - bbox[0]
    oy = 0 - bbox[1]
    od.text((ox, oy), text, font=f2x, fill=fill + (255,))
    scaled = overlay.resize((img.width, size * 3), Image.Resampling.LANCZOS)
    img.paste(scaled, (0, y), scaled)


# ─── Asset builders ───


def build_nsis_sidebar() -> None:
    """NSIS welcome/finish sidebar: 164×314. Anvil logo, title, tagline."""
    W, H = 164, 314
    bg = vertical_gradient(W, H, BG_DARK, BG_MID)

    # Icon centered horizontally, about 1/3 from top.
    icon = load_icon(100)
    bg.paste(icon, ((W - 100) // 2, 50), icon)

    # Soft glow behind icon — composite a blurred gold-tinted copy first.
    # (Composite order matters: blur the icon-shaped mask, paste under.)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    glow_icon = load_icon(120)
    # Tint to gold-ish
    tinted = Image.new("RGBA", glow_icon.size, GOLD + (0,))
    glow_layer = Image.composite(tinted, Image.new("RGBA", glow_icon.size, (0, 0, 0, 0)), glow_icon.split()[3])
    glow.paste(glow_layer, ((W - 120) // 2, 40), glow_layer)
    glow = glow.filter(ImageFilter.GaussianBlur(10))
    bg = Image.alpha_composite(bg.convert("RGBA"), glow)
    # Re-paste the crisp icon on top of the glow so the glow doesn't blur
    # the main icon details.
    bg.paste(icon, ((W - 100) // 2, 50), icon)

    # Title ("Infinity Mod Runner") below icon
    draw_text_centered_2x(bg, "EET MOD", 172, FONT_DISPLAY, 14, GOLD)
    draw_text_centered_2x(bg, "RUNNER", 192, FONT_DISPLAY, 14, GOLD)

    # Tagline (wrapped manually into 3 lines — PIL has no line-wrap helper
    # that respects kerning cleanly, and 164px is tight)
    tagline_lines = ["Install Infinity", "Engine mods from", "a Forge-exported list"]
    y = 225
    for line in tagline_lines:
        draw_text_centered_2x(bg, line, y, FONT_BODY_ITALIC or FONT_BODY, 9, TX_DIM)
        y += 14

    # NSIS wants 24-bit BMP (no alpha).
    out = bg.convert("RGB")
    path = OUT_DIR / "nsis-sidebar.bmp"
    out.save(path, "BMP")
    print(f"  wrote {path.relative_to(REPO_ROOT)} ({W}×{H})")


def build_nsis_header() -> None:
    """NSIS install-page header: 150×57. Small banner — icon + wordmark."""
    W, H = 150, 57
    bg = Image.new("RGB", (W, H), BG_DARK)

    # Small icon on the left
    icon = load_icon(40)
    bg.paste(icon, (8, (H - 40) // 2), icon)

    # "Infinity Mod Runner" wordmark on the right. Tight — header strips are
    # always narrow, so we render abbreviated on the top and full below.
    wm = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wm)
    f = font(FONT_DISPLAY, 11)
    wd.text((55, 8), "EET MOD", font=f, fill=GOLD + (255,))
    wd.text((55, 24), "RUNNER", font=f, fill=GOLD + (255,))
    # Thin gold underline under the wordmark
    wd.line([(55, 42), (W - 10, 42)], fill=GOLD_DIM + (255,), width=1)
    bg = Image.alpha_composite(bg.convert("RGBA"), wm).convert("RGB")

    # Bottom border (1px)
    draw = ImageDraw.Draw(bg)
    draw.line([(0, H - 1), (W, H - 1)], fill=BORDER, width=1)

    path = OUT_DIR / "nsis-header.bmp"
    bg.save(path, "BMP")
    print(f"  wrote {path.relative_to(REPO_ROOT)} ({W}×{H})")


def build_dmg_background() -> None:
    """macOS DMG background: 660×400. Title + drop-to-Applications layout.
    Icon positions are defined in tauri.conf.json (appPosition x=180 y=180;
    applicationFolderPosition x=480 y=180); we lay out around those."""
    W, H = 660, 400
    bg = vertical_gradient(W, H, BG_DARK, BG_MID).convert("RGBA")

    # Title at top center
    draw_text_centered_2x(bg, "EET MOD RUNNER", 36, FONT_DISPLAY, 28, GOLD)

    # Subtitle
    draw_text_centered_2x(bg, "Drag to Applications to install", 90, FONT_BODY, 14, TX_DIM)

    # Horizontal arrow from left-drop-zone (x≈180) to Applications (x≈480),
    # at the same y as the icons (180 + icon_halfheight ≈ 212).
    draw = ImageDraw.Draw(bg)
    arrow_y = 210
    # Shaft
    draw.line([(260, arrow_y), (400, arrow_y)], fill=GOLD_DIM + (255,), width=2)
    # Arrow head
    draw.polygon(
        [(400, arrow_y - 8), (400, arrow_y + 8), (415, arrow_y)],
        fill=GOLD_DIM + (255,),
    )

    # Gatekeeper bypass hint at the bottom — teaches the
    # right-click-Open workflow at the moment the user mounts the DMG.
    draw_text_centered_2x(bg, "First launch: right-click the app \u2192 Open \u2192 confirm", 360, FONT_BODY_ITALIC or FONT_BODY, 11, TX_FAINT)

    # DMG background is PNG (Tauri supports PNG for DMG; BMP isn't needed here)
    out = bg.convert("RGB")
    path = OUT_DIR / "dmg-background.png"
    out.save(path, "PNG")
    print(f"  wrote {path.relative_to(REPO_ROOT)} ({W}×{H})")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Generating installer assets in {OUT_DIR.relative_to(REPO_ROOT)}/")
    if FONT_DISPLAY:
        print(f"  display font: {FONT_DISPLAY}")
    if FONT_BODY:
        print(f"  body font:    {FONT_BODY}")
    build_nsis_sidebar()
    build_nsis_header()
    build_dmg_background()
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
