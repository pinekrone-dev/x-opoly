"""Draws the map image's lettering into app/lib/mapfont.js.

The server draws a map with no canvas and no fonts (app/lib/mapimage.js), so
its lettering is kept as pictures of letters: every character of two sizes
of Inter, laid side by side in a strip of opacities. Inter is licensed under
the SIL Open Font License, which allows this.

    python3 scripts/make-mapfont.py

Needs Pillow and the Inter OTF files; rerun only to change a size or add a
character.
"""
import base64, json, math, os
from PIL import Image, ImageDraw, ImageFont

FONTS = '/usr/share/fonts/opentype/inter'
CHARS = [chr(c) for c in range(32, 127)] + list('©·–—’“”°½×é')
FACES = {
    'small': ('Inter-Medium.otf', 11),
    'label': ('Inter-SemiBold.otf', 12),
    'title': ('Inter-SemiBold.otf', 15),
}

out = {}
for name, (file, size) in FACES.items():
    font = ImageFont.truetype(os.path.join(FONTS, file), size)
    ascent, descent = font.getmetrics()
    height = ascent + descent
    cells, x = {}, 0
    widths = []
    for ch in CHARS:
        advance = max(1, round(font.getlength(ch)))
        widths.append((ch, advance, advance + 2))
    strip = Image.new('L', (sum(w for _, _, w in widths), height), 0)
    draw = ImageDraw.Draw(strip)
    for ch, advance, width in widths:
        draw.text((x + 1, 0), ch, font=font, fill=255)
        cells[ch] = [x, width, advance]
        x += width
    out[name] = {'size': size, 'height': height, 'ascent': ascent, 'width': strip.width,
                 'cells': cells, 'alpha': base64.b64encode(strip.tobytes()).decode('ascii')}
    print(name, size, 'px:', strip.width, 'x', height, len(out[name]['alpha']), 'chars of base64')

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, '..', 'app', 'lib', 'mapfont.js'), 'w', encoding='utf-8') as f:
    f.write('/**\n * The map image\'s lettering: Inter (SIL Open Font License), drawn once by\n'
            ' * scripts/make-mapfont.py into strips of opacities, one strip per size.\n'
            ' * Generated; edit the script, not this file.\n */\n\n')
    f.write('export const FACES = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + '\n')
