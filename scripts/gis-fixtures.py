"""Builds a tiny, real GIS market: a PMTiles archive of three Austin parcels,
the catalogue JSON the view fetches, and a PNG basemap tile.

Everything is generated from the same coordinates, so a browser test can
project a parcel centroid to a pixel and click it — if the click selects the
right parcel, the whole pipeline is spatially correct end to end.
"""
import json, math, os, struct, zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gis-fixtures')
EXTENT = 4096

# --- the market -------------------------------------------------------------
CENTER = (-97.7431, 30.2672)
ZOOM = 13
TRACT_A, TRACT_B = '48453000700', '48453000800'

def square(lng, lat, meters):
    dlat = meters / 111320.0
    dlng = meters / (111320.0 * math.cos(math.radians(lat)))
    return [(lng - dlng, lat - dlat), (lng + dlng, lat - dlat),
            (lng + dlng, lat + dlat), (lng - dlng, lat + dlat), (lng - dlng, lat - dlat)]

PARCELS = [
    dict(id=101, gid='0204050101', ad='101 Congress Ave', zp='78701', ow='Congress Holdings LLC',
         at='Commercial', gp='Commercial', mv=500000, lv=200000, iv=300000, ac=1.2, tr=TRACT_A,
         center=(-97.7431, 30.2672), size=120),
    dict(id=102, gid='0204050102', ad='201 E 6th St', zp='78701', ow='Sixth Street Partners',
         at='Vacant land', gp='Vacant land', mv=2000000, lv=2000000, iv=0, ac=0.8, tr=TRACT_A,
         center=(-97.7375, 30.2700), size=120),
    dict(id=103, gid='0204050103', ad='800 W Cesar Chavez St', zp='78703', ow='Riverside Multifamily LP',
         at='Multifamily', gp='Multifamily', mv=8000000, lv=3000000, iv=5000000, ac=2.4, tr=TRACT_B,
         center=(-97.7480, 30.2640), size=140),
]

# --- web mercator -----------------------------------------------------------
def merc(lng, lat):
    x = (lng + 180.0) / 360.0
    s = math.sin(math.radians(lat))
    y = 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)
    return x, y

# --- protobuf ---------------------------------------------------------------
def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)

def key(field, wire): return varint((field << 3) | wire)
def zigzag(n): return (n << 1) ^ (n >> 63)
def field_len(field, payload): return key(field, 2) + varint(len(payload)) + payload
def field_var(field, n): return key(field, 0) + varint(n)

def mvt_value(v):
    if isinstance(v, str):
        return field_len(1, v.encode('utf-8'))
    return field_var(4, v)  # int64, non-negative here

def mvt_tile(features_by_layer):
    tile = b''
    for name, feats in features_by_layer.items():
        keys, values, vindex = [], [], {}
        body = b''
        for f in feats:
            tags = bytearray()
            for k, v in f['props'].items():
                if k not in keys:
                    keys.append(k)
                ki = keys.index(k)
                vk = (type(v).__name__, v)
                if vk not in vindex:
                    vindex[vk] = len(values)
                    values.append(v)
                tags += varint(ki) + varint(vindex[vk])
            geom = bytearray()
            for ring in f['rings']:
                # exterior must wind positive (CW with y down) per MVT
                area = sum((ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1])
                           for i in range(len(ring) - 1))
                pts = ring[:-1] if ring[0] == ring[-1] else ring
                if area < 0:
                    pts = list(reversed(pts))
                cx, cy = 0, 0
                geom += varint((1) | (1 << 3))  # MoveTo, count 1
                dx, dy = pts[0][0] - cx, pts[0][1] - cy
                geom += varint(zigzag(dx)) + varint(zigzag(dy))
                cx, cy = pts[0]
                geom += varint((2) | ((len(pts) - 1) << 3))  # LineTo
                for px, py in pts[1:]:
                    geom += varint(zigzag(px - cx)) + varint(zigzag(py - cy))
                    cx, cy = px, py
                geom += varint(7 | (1 << 3))  # ClosePath
            feat = field_var(1, f['id']) + field_len(2, bytes(tags)) + field_var(3, 3) + field_len(4, bytes(geom))
            body += field_len(2, feat)
        layer = field_var(15, 2) + field_len(1, name.encode()) + body
        for k in keys:
            layer += field_len(3, k.encode())
        for v in values:
            layer += field_len(4, mvt_value(v))
        layer += field_var(5, EXTENT)
        tile += field_len(3, layer)
    return tile

# --- pmtiles ----------------------------------------------------------------
def rotate(n, x, y, rx, ry):
    if ry == 0:
        if rx != 0:
            x, y = n - 1 - x, n - 1 - y
        x, y = y, x
    return x, y

def tile_id(z, x, y):
    acc = ((1 << z) * (1 << z) - 1) // 3
    d = 0
    s = (1 << z) >> 1
    while s > 0:
        rx = 1 if (x & s) else 0
        ry = 1 if (y & s) else 0
        d += s * s * ((3 * rx) ^ ry)
        x, y = rotate(s, x, y, rx, ry)
        s >>= 1
    return acc + d

def build_pmtiles(path):
    tiles = {}
    for z in range(11, 15):
        n = 1 << z
        per_tile = {}
        for p in PARCELS:
            ring_world = [merc(lng, lat) for lng, lat in square(p['center'][0], p['center'][1], p['size'])]
            txs = {int(px * n) for px, py in ring_world}
            tys = {int(py * n) for px, py in ring_world}
            for tx in txs:
                for ty in tys:
                    ring = [(round(px * n * EXTENT - tx * EXTENT), round(py * n * EXTENT - ty * EXTENT))
                            for px, py in ring_world]
                    per_tile.setdefault((tx, ty), []).append(
                        dict(id=p['id'], props={'mv': p['mv'], 'gp': p['gp']}, rings=[ring]))
        for (tx, ty), feats in per_tile.items():
            tiles[tile_id(z, tx, ty)] = mvt_tile({'parcels': feats})

    entries = sorted(tiles.items())
    blobs, offsets, off = [], [], 0
    for _, blob in entries:
        offsets.append(off)
        blobs.append(blob)
        off += len(blob)

    d = bytearray()
    d += varint(len(entries))
    last = 0
    for tid, _ in entries:
        d += varint(tid - last)
        last = tid
    for _ in entries:
        d += varint(1)            # run length
    for blob in blobs:
        d += varint(len(blob))    # length
    for i, o in enumerate(offsets):
        if i > 0 and o == offsets[i - 1] + len(blobs[i - 1]):
            d += varint(0)
        else:
            d += varint(o + 1)

    meta = json.dumps({'vector_layers': [{'id': 'parcels', 'fields': {'mv': 'Number', 'gp': 'String'}}]}).encode()

    header_len = 127
    root_off = header_len
    meta_off = root_off + len(d)
    tile_off = meta_off + len(meta)

    lons = [p['center'][0] for p in PARCELS]; lats = [p['center'][1] for p in PARCELS]
    h = bytearray(127)
    h[0:7] = b'PMTiles'
    h[7] = 3
    struct.pack_into('<Q', h, 8, root_off)
    struct.pack_into('<Q', h, 16, len(d))
    struct.pack_into('<Q', h, 24, meta_off)
    struct.pack_into('<Q', h, 32, len(meta))
    struct.pack_into('<Q', h, 40, 0)   # leaf dirs
    struct.pack_into('<Q', h, 48, 0)
    struct.pack_into('<Q', h, 56, tile_off)
    struct.pack_into('<Q', h, 64, off)
    struct.pack_into('<Q', h, 72, len(entries))
    struct.pack_into('<Q', h, 80, len(entries))
    struct.pack_into('<Q', h, 88, len(entries))
    h[96] = 1   # clustered
    h[97] = 1   # internal compression: none
    h[98] = 1   # tile compression: none
    h[99] = 1   # type: mvt
    h[100] = 11
    h[101] = 14
    struct.pack_into('<i', h, 102, int((min(lons) - 0.02) * 1e7))
    struct.pack_into('<i', h, 106, int((min(lats) - 0.02) * 1e7))
    struct.pack_into('<i', h, 110, int((max(lons) + 0.02) * 1e7))
    struct.pack_into('<i', h, 114, int((max(lats) + 0.02) * 1e7))
    h[118] = ZOOM
    struct.pack_into('<i', h, 119, int(CENTER[0] * 1e7))
    struct.pack_into('<i', h, 123, int(CENTER[1] * 1e7))

    with open(path, 'wb') as f:
        f.write(bytes(h) + bytes(d) + meta + b''.join(blobs))
    return len(entries)

# --- a PNG basemap tile -----------------------------------------------------
def png_tile(path):
    w = hgt = 256
    rows = bytearray()
    for y in range(hgt):
        rows.append(0)
        for x in range(w):
            edge = x < 2 or y < 2 or x >= w - 2 or y >= hgt - 2
            grid = (x % 64 == 0) or (y % 64 == 0)
            if edge: rows += bytes((122, 156, 126))
            elif grid: rows += bytes((190, 214, 194))
            else: rows += bytes((216, 234, 211))
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack('>IIBBBBB', w, hgt, 8, 2, 0, 0, 0)
    body = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(rows))) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(body)

# --- catalogue --------------------------------------------------------------
def tract_polygon(lng0, lat0, lng1, lat1):
    return {'type': 'Polygon', 'coordinates': [[[lng0, lat0], [lng1, lat0], [lng1, lat1], [lng0, lat1], [lng0, lat0]]]}

def write_catalog():
    os.makedirs(os.path.join(OUT, 'catalog', 'austin', 'data'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'data', 'austin'), exist_ok=True)
    j = lambda p, obj: open(os.path.join(OUT, p), 'w').write(json.dumps(obj))
    j('catalog/markets.json', {'markets': [{'slug': 'austin', 'name': 'Austin', 'region': 'Travis County, Texas',
        'status': 'live', 'stats': {'parcels': len(PARCELS), 'value': sum(p['mv'] for p in PARCELS),
        'center': list(CENTER)}}]})
    j('catalog/austin/meta.json', {'market': 'Austin', 'region': 'Travis County, Texas',
        'center': list(CENTER), 'zoom': ZOOM, 'heavyBase': 'https://data.test/austin/',
        'colorBy': 'value', 'valueLabel': 'Market value', 'idLabel': 'Parcel',
        'tiles': True, 'count': len(PARCELS), 'attribution': 'Fixture data'})
    keys = ['id', 'gid', 'ad', 'zp', 'ow', 'at', 'mv', 'lv', 'iv', 'ac', 'tr']
    cols = {k: [p[k] for p in PARCELS] for k in keys}
    bb = []
    for p in PARCELS:
        ring = square(p['center'][0], p['center'][1], p['size'])
        bb += [min(q[0] for q in ring), min(q[1] for q in ring), max(q[0] for q in ring), max(q[1] for q in ring)]
    j('data/austin/index.json', {'n': len(PARCELS), 'keys': keys, 'cols': cols, 'bb': bb})
    j('catalog/austin/census.json', {'year': 2023, 'fields': [['inc', 'Median income'], ['pop', 'Population']],
        'tracts': {TRACT_A: {'n': 'Tract 7', 'inc': 85000, 'pop': 4300},
                   TRACT_B: {'n': 'Tract 8', 'inc': 55000, 'pop': 5100}}})
    j('catalog/austin/tracts.geojson', {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'tr': TRACT_A}, 'geometry': tract_polygon(-97.745, 30.262, -97.730, 30.276)},
        {'type': 'Feature', 'properties': {'tr': TRACT_B}, 'geometry': tract_polygon(-97.756, 30.258, -97.745, 30.270)}]})
    j('catalog/austin/codes.json', {})
    j('data/austin/details.json', {'cols': {}, 'keys': []})

os.makedirs(OUT, exist_ok=True)
count = build_pmtiles(os.path.join(OUT, 'data', 'austin', 'parcels.pmtiles')) if os.makedirs(os.path.join(OUT, 'data', 'austin'), exist_ok=True) or True else 0
write_catalog()
png_tile(os.path.join(OUT, 'tile.png'))
print('pmtiles tiles:', count)
print('files:', sorted(os.listdir(os.path.join(OUT, 'catalog', 'austin', 'data'))))
