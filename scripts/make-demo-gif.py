#!/usr/bin/env python3
"""Składa demo GIF z kolejnych eksportów Figmy.

Wejście: out/demo/NN.png (kolejne stany tego samego węzła, eksport 2x).
Wyjście: docs/assets/demo.gif

Każda klatka = realny render z Figmy po wykonaniu jednej operacji mostka,
plus podpis pokazujący, jakie wywołanie ją zrobiło.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "out" / "demo"
DST = ROOT / "docs" / "assets" / "demo.gif"

W, H = 800, 640
CARD_W = 560
CARD_TOP = 44
BG = (5, 5, 7)
PANEL = (12, 12, 15)
BORDER = (32, 32, 38)
ACCENT = (139, 118, 255)
TEXT = (242, 242, 247)
DIM = (138, 138, 148)
MONO = (200, 200, 210)

FONT_MONO = "/System/Library/Fonts/SFNSMono.ttf"
FONT_TEXT = "/System/Library/Fonts/SFNS.ttf"

STEPS = [
    ('createFrame', 'empty 380×240 frame · auto-layout', 1100),
    ('createText', 'Title · Inter Semi Bold 24 px', 1100),
    ('createText', 'Subtitle · 13 px · #8A8A94', 1100),
    ('createFrame', 'CTA · centered · radius 18', 1100),
    ('createFrame ×2', 'Tags · hug · gap 8', 1100),
    ('update', 'hover state · export PNG 2× · done', 3000),
]


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def centered(draw, box, text, fnt, fill):
    x0, x1, y = box
    w = draw.textlength(text, font=fnt)
    draw.text(((x0 + x1 - w) / 2, y), text, font=fnt, fill=fill)


def render(index, png_path, caption, note):
    canvas = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(canvas)

    card = Image.open(png_path).convert("RGBA")
    ratio = CARD_W / card.width
    card = card.resize((CARD_W, round(card.height * ratio)), Image.LANCZOS)

    # miękka poświata pod kartą, żeby ciemna karta nie zlewała się z tłem
    pad = 10
    draw.rounded_rectangle(
        (W // 2 - CARD_W // 2 - pad, CARD_TOP - pad,
         W // 2 + CARD_W // 2 + pad, CARD_TOP + card.height + pad),
        radius=26, fill=PANEL, outline=BORDER, width=1,
    )
    canvas.paste(card, (W // 2 - CARD_W // 2, CARD_TOP), card)

    f_mono = font(FONT_MONO, 15)
    f_note = font(FONT_TEXT, 14)
    f_small = font(FONT_MONO, 12)

    y = CARD_TOP + card.height + 34
    draw.text((W / 2 - 250, y), f"{index}/6", font=f_small, fill=(110, 110, 122))
    draw.text((W / 2 - 214, y - 1), f"figma run  →  {caption}", font=f_mono, fill=ACCENT)
    draw.text((W / 2 - 250, y + 24), note, font=f_note, fill=MONO)

    footer = "github.com/iggypcnfsky/figma-bridge"
    w = draw.textlength(footer, font=f_small)
    draw.text(((W - w) / 2, H - 34), footer, font=f_small, fill=(96, 96, 108))
    return canvas


def main():
    frames, durations = [], []
    for i, (caption, note, hold) in enumerate(STEPS, start=1):
        png = SRC / f"{i:02d}.png"
        if not png.exists():
            raise SystemExit(f"brak {png} — najpierw wyeksportuj klatki z Figmy")
        frames.append(render(i, png, caption, note))
        durations.append(hold)

    paletted = [f.quantize(colors=128, method=Image.MEDIANCUT, dither=Image.NONE) for f in frames]
    DST.parent.mkdir(parents=True, exist_ok=True)
    paletted[0].save(
        DST,
        save_all=True,
        append_images=paletted[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    size = DST.stat().st_size
    print(f"{DST.relative_to(ROOT)}: {size / 1024:.0f} KB, {len(frames)} klatek, {W}×{H}")


if __name__ == "__main__":
    main()
