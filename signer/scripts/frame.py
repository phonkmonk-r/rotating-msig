"""Frames app screenshots as macOS windows: rounded corners, the three window buttons, a hairline border and a soft
shadow on a transparent background. Run by `npm run screenshots` on the images it just captured; needs Pillow.

    python3 scripts/frame.py screenshots/*.png
"""

import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

# Sizes in pixels of a 2x capture: macOS draws a 10 pt window radius, 12 pt buttons 20 pt apart, centred 20 pt in.
RADIUS = 20
BUTTON_RADIUS = 12
BUTTON_CENTRES = [(40, 40), (80, 40), (120, 40)]
BUTTON_COLOURS = [((255, 95, 87), (224, 68, 62)), ((254, 188, 46), (222, 161, 35)), ((40, 200, 64), (29, 173, 43))]
MARGIN = 80
SHADOW_OFFSET = 24
SHADOW_BLUR = 36
SHADOW_ALPHA = 90


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    # Drawn at 4x and scaled down, for smooth corners.
    scale = 4
    big = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, big.width - 1, big.height - 1), radius * scale, fill=255)
    return big.resize(size, Image.LANCZOS)


def frame(path: str) -> None:
    window = Image.open(path).convert("RGBA")
    width, height = window.size

    draw = ImageDraw.Draw(window)
    for (x, y), (fill, edge) in zip(BUTTON_CENTRES, BUTTON_COLOURS):
        draw.ellipse((x - BUTTON_RADIUS, y - BUTTON_RADIUS, x + BUTTON_RADIUS, y + BUTTON_RADIUS), fill=fill, outline=edge, width=1)

    mask = rounded_mask((width, height), RADIUS)
    window.putalpha(ImageChops.multiply(window.getchannel("A"), mask))
    border = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle((0, 0, width - 1, height - 1), RADIUS, outline=(0, 0, 0, 46), width=2)
    window = Image.alpha_composite(window, border)

    canvas = Image.new("RGBA", (width + 2 * MARGIN, height + 2 * MARGIN), (0, 0, 0, 0))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_mask = Image.new("L", canvas.size, 0)
    shadow_mask.paste(mask.point(lambda value: value * SHADOW_ALPHA // 255), (MARGIN, MARGIN + SHADOW_OFFSET))
    shadow.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(SHADOW_BLUR)))
    canvas = Image.alpha_composite(canvas, shadow)
    canvas.alpha_composite(window, (MARGIN, MARGIN))
    canvas.save(path, optimize=True)


if __name__ == "__main__":
    for name in sys.argv[1:]:
        frame(name)
