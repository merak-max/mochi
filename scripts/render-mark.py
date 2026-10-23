# Renders the ASCII marks to images: square icons from the small mark, a README banner from the large one.
# The lamps "()" draw in the signal color, everything else in phosphor on a dark ground.
# Usage: uv run --with pillow scripts/render-mark.py docs/mark/mark.txt docs/mark/icon.txt docs/mark
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono-Bold.ttf"
GROUND = (18, 17, 16)
PHOSPHOR = (232, 224, 208)
SIGNAL = (230, 74, 46)
DIM = (120, 114, 104)


def read_rows(path):
    return open(path).read().rstrip("\n").split("\n")


def cell(font):
    box = font.getbbox("M")
    return font.getlength("M"), (box[3] - box[1]) * 1.55


def draw_mark(draw, rows, font, left, top):
    cell_w, cell_h = cell(font)
    for y, row in enumerate(rows):
        # Draw the whole row as one string so underscores join, then repaint the lamps in the signal color.
        draw.text((left, top + y * cell_h), row, font=font, fill=PHOSPHOR)
        start = row.find("()")
        while start != -1:
            draw.text((left + start * cell_w, top + y * cell_h), "()", font=font, fill=SIGNAL)
            start = row.find("()", start + 2)


def icon(rows, size):
    cols = max(len(r) for r in rows)
    im = Image.new("RGB", (size, size), GROUND)
    draw = ImageDraw.Draw(im)
    font_size = 4
    while True:
        cell_w, cell_h = cell(ImageFont.truetype(FONT, font_size + 1))
        if cell_w * cols > size * 0.86 or cell_h * len(rows) > size * 0.86:
            break
        font_size += 1
    font = ImageFont.truetype(FONT, font_size)
    cell_w, cell_h = cell(font)
    draw_mark(draw, rows, font, (size - cell_w * cols) / 2, (size - cell_h * len(rows)) / 2 - cell_h * 0.15)
    return im


def banner(rows, width, height):
    cols = max(len(r) for r in rows)
    im = Image.new("RGB", (width, height), GROUND)
    draw = ImageDraw.Draw(im)
    font = ImageFont.truetype(FONT, int(height / 13))
    cell_w, cell_h = cell(font)
    left = width * 0.08
    draw_mark(draw, rows, font, left, (height - cell_h * len(rows)) / 2)
    text_left = left + cell_w * cols + width * 0.06
    draw.text((text_left, height * 0.26), "sibyl", font=ImageFont.truetype(FONT, int(height / 4.2)), fill=PHOSPHOR)
    draw.text((text_left + 6, height * 0.62), "MELCHIOR-1  BALTHASAR-2  CASPER-3", font=ImageFont.truetype(FONT, int(height / 22)), fill=DIM)
    return im


banner_rows = read_rows(sys.argv[1])
icon_rows = read_rows(sys.argv[2])
out_dir = sys.argv[3]
SCALE = 4
banner(banner_rows, 1600 * SCALE, 520 * SCALE).resize((1600, 520), Image.LANCZOS).save(out_dir + "/banner.png")
for size in (512, 64, 32):
    icon(icon_rows, size * SCALE).resize((size, size), Image.LANCZOS).save(out_dir + "/icon-%d.png" % size)
print("ok")
