#!/usr/bin/env python3
"""
Makes the contour-line picture used behind the party panel (a tile that repeats without a seam).

No libraries needed:  python3 tools/make-topo.py > topo.svg

How: a smooth "height" field is built from a few sine waves whose frequencies are whole
numbers, so the field repeats exactly every TILE pixels. Contour lines (marching squares) are
cut through it at several heights, joined into long paths, thinned out and smoothed.
"""
import math
import random
import sys

TILE = 400  # pixels
N = 100  # grid squares per side
LEVELS = 11
SEED = 7
EPS = 0.45  # path thinning (pixels)

rnd = random.Random(SEED)
waves = []
for _ in range(7):
    kx, ky = rnd.randint(0, 3), rnd.randint(0, 3)
    if kx == 0 and ky == 0:
        kx = 1
    waves.append((kx, ky, rnd.uniform(0, 2 * math.pi), rnd.uniform(0.5, 1.0) / math.hypot(kx, ky)))


def height(x, y):
    u, v = x / TILE * 2 * math.pi, y / TILE * 2 * math.pi
    return sum(a * math.sin(kx * u + ky * v + p) for kx, ky, p, a in waves)


h = TILE / N
F = [[height(i * h, j * h) for i in range(N + 1)] for j in range(N + 1)]
lo = min(min(r) for r in F)
hi = max(max(r) for r in F)


def segments(level):
    segs = []
    for j in range(N):
        for i in range(N):
            tl, tr, br, bl = F[j][i], F[j][i + 1], F[j + 1][i + 1], F[j + 1][i]
            case = (tl > level) * 1 + (tr > level) * 2 + (br > level) * 4 + (bl > level) * 8
            if case in (0, 15):
                continue

            def edge(name):
                # an edge is named by where it is, and gives the crossing point along it
                if name == 'T':
                    t = (level - tl) / (tr - tl)
                    return (('h', i, j), (i + t) * h, j * h)
                if name == 'B':
                    t = (level - bl) / (br - bl)
                    return (('h', i, j + 1), (i + t) * h, (j + 1) * h)
                if name == 'L':
                    t = (level - tl) / (bl - tl)
                    return (('v', i, j), i * h, (j + t) * h)
                t = (level - tr) / (br - tr)
                return (('v', i + 1, j), (i + 1) * h, (j + t) * h)

            table = {1: ['LT'], 2: ['TR'], 3: ['LR'], 4: ['RB'], 6: ['TB'], 7: ['LB'], 8: ['LB'], 9: ['TB'],
                     11: ['RB'], 12: ['LR'], 13: ['TR'], 14: ['LT']}
            if case in (5, 10):
                centre = (tl + tr + br + bl) / 4 > level
                if case == 5:
                    pairs = ['TR', 'LB'] if centre else ['LT', 'RB']
                else:
                    pairs = ['LT', 'RB'] if centre else ['TR', 'LB']
            else:
                pairs = table[case]
            for p in pairs:
                segs.append((edge(p[0]), edge(p[1])))
    return segs


def chains(segs):
    """Join little segments that share an edge into long lines."""
    at = {}
    for k, (a, b) in enumerate(segs):
        at.setdefault(a[0], []).append(k)
        at.setdefault(b[0], []).append(k)
    used = [False] * len(segs)
    lines = []
    for k in range(len(segs)):
        if used[k]:
            continue
        used[k] = True
        a, b = segs[k]
        pts = [(a[1], a[2]), (b[1], b[2])]
        for end in (0, 1):
            while True:
                key = segs[k][1][0] if end == 1 else segs[k][0][0]
                nxt = [m for m in at.get(key, []) if not used[m]]
                if not nxt:
                    break
                m = nxt[0]
                used[m] = True
                p, q = segs[m]
                if q[0] == key:
                    p, q = q, p
                far = (q[1], q[2])
                if end == 1:
                    pts.append(far)
                    segs[k] = (segs[k][0], q)
                else:
                    pts.insert(0, far)
                    segs[k] = (q, segs[k][1])
        lines.append(pts)
    return lines


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-9
    best, idx = 0, 0
    for i in range(1, len(pts) - 1):
        d = abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / norm
        if d > best:
            best, idx = d, i
    if best <= eps:
        return [pts[0], pts[-1]]
    return rdp(pts[: idx + 1], eps)[:-1] + rdp(pts[idx:], eps)


def smooth(pts):
    """Curve through the middle of each corner (quadratic curves)."""
    f = lambda v: ('%.1f' % v).rstrip('0').rstrip('.')
    if len(pts) < 3:
        return 'M' + ' '.join(f(c) for p in pts for c in p)
    d = 'M%s %s' % (f(pts[0][0]), f(pts[0][1]))
    for i in range(1, len(pts) - 1):
        mx, my = (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2
        d += 'Q%s %s %s %s' % (f(pts[i][0]), f(pts[i][1]), f(mx), f(my))
    d += 'L%s %s' % (f(pts[-1][0]), f(pts[-1][1]))
    return d


paths = []
for n in range(LEVELS):
    level = lo + (hi - lo) * (n + 1) / (LEVELS + 1)
    for line in chains(segments(level)):
        if len(line) < 4:
            continue
        paths.append(smooth(rdp(line, EPS)))

print(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d">'
    '<path fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" d="%s"/></svg>'
    % (TILE, TILE, TILE, TILE, ''.join(paths)),
    end='',
)
sys.stderr.write('%d paths\n' % len(paths))
