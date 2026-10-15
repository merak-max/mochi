# Turns a pixel-art image into colored half-block rows for ~/.mochi/mark.ans.
# Usage: uv run --with pillow scripts/mark-from-image.py <image> <columns> <out.ans> [native grid size]
# It drops the background color and keeps the largest shape. Tune is_bg for a new image.
import sys
from PIL import Image
src, cols, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
im = Image.open(src).convert('RGB')
w, h = im.size
# the art is a 64-ish grid scaled up; sample the native grid first so pixels stay crisp
grid = int(sys.argv[4]) if len(sys.argv) > 4 else 64
im = im.resize((grid, grid), Image.NEAREST)
# background = the pink fill plus the yellow checker/sparkle/heart decorations; keep the character only
def is_bg(p):
    r, g, b = p
    pink = abs(r - 214) < 40 and abs(g - 110) < 45 and abs(b - 180) < 45
    yellow = r > 200 and g > 190 and b < 120
    white_sparkle = False
    return pink or yellow
mask = Image.new('L', im.size, 0)
for y in range(grid):
    for x in range(grid):
        if not is_bg(im.getpixel((x, y))): mask.putpixel((x, y), 255)
# keep the largest connected blob (the character), drop stray decorations
import collections
seen = set(); best = []
for y in range(grid):
    for x in range(grid):
        if mask.getpixel((x, y)) and (x, y) not in seen:
            comp = []; q = collections.deque([(x, y)]); seen.add((x, y))
            while q:
                cx, cy = q.popleft(); comp.append((cx, cy))
                for nx, ny in ((cx+1,cy),(cx-1,cy),(cx,cy+1),(cx,cy-1)):
                    if 0 <= nx < grid and 0 <= ny < grid and (nx, ny) not in seen and mask.getpixel((nx, ny)):
                        seen.add((nx, ny)); q.append((nx, ny))
            if len(comp) > len(best): best = comp
keep = Image.new('L', im.size, 0)
for p in best: keep.putpixel(p, 255)
bbox = keep.getbbox()
im, keep = im.crop(bbox), keep.crop(bbox)
bw, bh = im.size
rows2 = round(bh * cols / bw)
if rows2 % 2: rows2 += 1
im = im.resize((cols, rows2), Image.NEAREST); keep = keep.resize((cols, rows2), Image.NEAREST)
lines = []
for y in range(0, rows2, 2):
    line = ''
    for x in range(cols):
        top = im.getpixel((x, y)) if keep.getpixel((x, y)) else None
        bot = im.getpixel((x, y+1)) if keep.getpixel((x, y+1)) else None
        if top is None and bot is None: line += '\x1b[0m '
        elif bot is None: line += '\x1b[0m\x1b[38;2;%d;%d;%dm▀' % top
        elif top is None: line += '\x1b[0m\x1b[38;2;%d;%d;%dm▄' % bot
        else: line += '\x1b[38;2;%d;%d;%dm\x1b[48;2;%d;%d;%dm▀' % (top + bot)
    lines.append(line.rstrip() + '\x1b[0m')
open(out, 'w').write('\n'.join(lines) + '\n')
print(bw, bh, '->', cols, rows2 // 2)
