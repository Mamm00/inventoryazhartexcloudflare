#!/usr/bin/env python3
# tools/make_seed_sql.py — generates migrations/0002_seed.sql and
# seed_manifest.json from compact plan tables. No roll number is hand-typed
# anywhere: every count, total and percentage printed here is derived from the
# generated rows. Deterministic: byte-identical output across runs and days.

import hashlib
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED_VERSION = '1.2.0'
RNG_SEED = 20261108

# ---------------------------------------------------------------------------
# Compact plan tables (the ONLY hand-written inputs)
# ---------------------------------------------------------------------------

WAREHOUSE_PLAN = [
    dict(id='wh-alwa', name_ar='درجة تانية الوا', name_en='Alwa Grade 2', keeper='keeper1',
         allowed_grades='B,C', grade_label_ar='درجة تانية · Grade 2', capacity_rolls=22000,
         mapping_rows=150, inactive_rows=3, inactive_rolls_each=50, target_active_rolls=13456),
    dict(id='wh-leon', name_ar='درجة تانية ليون', name_en='Leon Grade 2', keeper='keeper1',
         allowed_grades='B,C', grade_label_ar='درجة تانية · Grade 2', capacity_rolls=18000,
         mapping_rows=130, inactive_rows=3, inactive_rolls_each=50, target_active_rolls=11204),
    dict(id='wh-azouz', name_ar='عزوز درجة اولي', name_en='Azouz Grade 1', keeper='keeper1',
         allowed_grades='A,B', grade_label_ar='درجة اولي · Grade 1', capacity_rolls=20000,
         mapping_rows=120, inactive_rows=2, inactive_rolls_each=50, target_active_rolls=9876),
    dict(id='wh-zibda', name_ar='الزبدة', name_en='Zibda', keeper='keeper1',
         allowed_grades='A,B,C', grade_label_ar='كل الدرجات · All grades', capacity_rolls=22000,
         mapping_rows=100, inactive_rows=2, inactive_rolls_each=50, target_active_rolls=8797),
    dict(id='wh-showroom', name_ar='مخزن العرض', name_en='Showroom', keeper='keeper1',
         allowed_grades='A,B,C,D', grade_label_ar='كل الدرجات · All grades', capacity_rolls=11000,
         mapping_rows=180, inactive_rows=5, inactive_rolls_each=50, target_active_rolls=8000),
    dict(id='wh-625', name_ar='٦٢٥', name_en='625', keeper='keeper2',
         allowed_grades='A,B,C,D', grade_label_ar='كل الدرجات · All grades', capacity_rolls=3000,
         mapping_rows=180, inactive_rows=4, inactive_rolls_each=30, target_active_rolls=5255),
    dict(id='wh-magdy', name_ar='مجدي', name_en='Magdy', keeper='keeper2',
         allowed_grades='B,C', grade_label_ar='درجة تانية · Grade 2', capacity_rolls=6000,
         mapping_rows=110, inactive_rows=2, inactive_rolls_each=50, target_active_rolls=3200),
    dict(id='wh-wahman', name_ar='وهمان', name_en='Wahman', keeper='keeper2',
         allowed_grades='C,D', grade_label_ar='درجة تالتة · Grade 3', capacity_rolls=6500,
         mapping_rows=90, inactive_rows=2, inactive_rolls_each=50, target_active_rolls=2879),
    dict(id='wh-lycra', name_ar='ليكرا', name_en='Lycra', keeper='keeper2',
         allowed_grades='A,B', grade_label_ar='درجة اولي · Grade 1', capacity_rolls=5000,
         mapping_rows=140, inactive_rows=2, inactive_rolls_each=50, target_active_rolls=3400),
    dict(id='wh-kashry', name_ar='كشري', name_en='Kashry', keeper='keeper2',
         allowed_grades='C,D', grade_label_ar='درجة تالتة · Grade 3', capacity_rolls=5500,
         mapping_rows=96, inactive_rows=1, inactive_rolls_each=50, target_active_rolls=2500),
]

FABRIC_POOL = [
    ('قطن', 'Cotton', 10),
    ('ليكرا', 'Lycra', 8),
    ('شيفون', 'Chiffon', 8),
    ('صوف', 'Wool', 7),
    ('كتان', 'Linen', 7),
    ('ساتان', 'Satin', 7),
    ('جينز', 'Denim', 7),
    ('تريكو', 'Knit', 7),
]

FAMILY_LABEL = {
    'blue': ('أزرق', 'Blue'), 'green': ('أخضر', 'Green'), 'red': ('أحمر', 'Red'),
    'beige': ('بيج', 'Beige'), 'brown': ('بني', 'Brown'), 'grey': ('رمادي', 'Grey'),
    'pink': ('وردي', 'Pink'), 'purple': ('بنفسجي', 'Purple'), 'yellow': ('أصفر', 'Yellow'),
    'orange': ('برتقالي', 'Orange'), 'black': ('أسود', 'Black'),
}

FAMILY_GRADE = {
    'blue': 'A', 'green': 'A', 'red': 'A',
    'beige': 'B', 'brown': 'B', 'grey': 'B',
    'pink': 'C', 'purple': 'C', 'yellow': 'C',
    'orange': 'D', 'black': 'D',
}

COLOR_FAMILIES = {
    'blue': 25, 'green': 22, 'red': 18,
    'beige': 28, 'brown': 24, 'grey': 18,
    'pink': 20, 'purple': 18, 'yellow': 16,
    'orange': 10, 'black': 9,
}

FAMILY_HEX = {
    'blue': (32, 78, 170), 'green': (36, 122, 63), 'red': (176, 42, 42),
    'beige': (205, 186, 150), 'brown': (124, 84, 52), 'grey': (128, 128, 128),
    'pink': (219, 112, 147), 'purple': (128, 64, 160), 'yellow': (222, 196, 60),
    'orange': (226, 130, 46), 'black': (32, 32, 36),
}

# The single fabric type carried by wh-625 (1 fabric × ~180 colours).
WH625_FABRIC = 'fab-041'

SEED_USERS = [
    dict(id='u-admin', username='admin', password='admin123',
         display_name_ar='المسؤول', display_name_en='Admin', role='Admin',
         warehouse_ids='[]', who_en='Admin', who_ar='مسؤول',
         scope_en='All ten sheds', scope_ar='كل المخازن العشرة'),
    dict(id='u-keeper1', username='keeper1', password='mostafa123',
         display_name_ar='مصطفى', display_name_en='Mostafa', role='WarehouseKeeper',
         warehouse_ids='["wh-alwa","wh-leon","wh-azouz","wh-zibda","wh-showroom"]',
         who_en='Mostafa · Warehouse Keeper', who_ar='مصطفى · أمين مخزن',
         scope_en='His five sheds', scope_ar='مخازنه الخمسة'),
    dict(id='u-keeper2', username='keeper2', password='keeper2123',
         display_name_ar='المسؤول الثاني', display_name_en='Second keeper', role='WarehouseKeeper',
         warehouse_ids='["wh-625","wh-magdy","wh-wahman","wh-lycra","wh-kashry"]',
         who_en='Second keeper · Warehouse Keeper', who_ar='الأمين الثاني · أمين مخزن',
         scope_en='The other five sheds', scope_ar='المخازن الخمسة الأخرى'),
]

# (id, keeper_user_id, (family, 1-based index), custom_code, custom_name, notes)
SEED_KEEPER_CODES = [
    ('kcode-01', 'u-keeper1', ('blue', 7), 'M-BLU-007', 'أزرق المعرض', 'رف A3'),
    ('kcode-02', 'u-keeper1', ('beige', 12), 'M-BEJ-012', 'بيج الشتوي', 'بجانب الباب'),
    ('kcode-03', 'u-keeper1', ('green', 3), 'M-GRN-003', 'أخضر ميلي', 'رف B1'),
    ('kcode-04', 'u-keeper1', ('red', 14), 'M-RED-021', 'أحمر فاتح', '—'),
    ('kcode-05', 'u-keeper2', ('blue', 15), 'K-625-101', 'أزرق 625', 'قسم 625'),
    ('kcode-06', 'u-keeper2', ('grey', 5), 'K-ASH-014', 'رمادي فحمي', '—'),
    ('kcode-07', 'u-keeper2', ('brown', 9), 'K-BRN-055', 'بني عسلي', 'رف C2'),
]

KEEPER_IDS = {'keeper1': 'u-keeper1', 'keeper2': 'u-keeper2'}
DATE_WINDOW = ('2026-09-15', '2026-11-07')  # deterministic — never "today"

# ---------------------------------------------------------------------------


def q(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"


def pbkdf2(password, salt_hex):
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt_hex), 100_000)
    return dk.hex()


def user_hash(u):
    salt = hashlib.sha256(('fabric-roll-stock|' + u['username']).encode()).hexdigest()[:32]
    return 'pbkdf2_sha256$100000$%s$%s' % (salt, pbkdf2(u['password'], salt))


def distribute(total, n, rng):
    """Deterministically split `total` into n positive ints summing exactly."""
    weights = [0.5 + rng.random() for _ in range(n)]
    s = sum(weights)
    raw = [max(3, int(w * total / s)) for w in weights]
    diff = total - sum(raw)
    i = 0
    while diff != 0:
        j = i % n
        if diff > 0:
            raw[j] += 1
            diff -= 1
        elif raw[j] > 3:
            raw[j] -= 1
            diff += 1
        i += 1
    return raw


def hex_for(family, idx):
    r, g, b = FAMILY_HEX[family]
    f = ((idx * 37) % 61) - 30
    clamp = lambda v: max(0, min(255, v + f))
    return '#%02x%02x%02x' % (clamp(r), clamp(g), clamp(b))


def date_add(iso, days):
    import datetime
    d = datetime.date.fromisoformat(iso) + datetime.timedelta(days=days)
    return d.isoformat()


def main():
    rng = random.Random(RNG_SEED)

    # ---- fabrics -----------------------------------------------------------
    fabrics = []
    fi = 0
    for base_ar, base_en, count in FABRIC_POOL:
        for k in range(1, count + 1):
            fi += 1
            fabrics.append(dict(
                id='fab-%03d' % fi,
                name_ar='%s %d' % (base_ar, k),
                name_en='%s %d' % (base_en, k),
                meters_per_roll=40 + (fi * 13) % 51,
                unit_cost_per_roll=280 + (fi * 173) % 1400,
            ))
    assert len(fabrics) == 61, len(fabrics)

    # ---- colours -----------------------------------------------------------
    colors = []
    for family, count in COLOR_FAMILIES.items():
        label_ar, label_en = FAMILY_LABEL[family]
        grade = FAMILY_GRADE[family]
        for i in range(1, count + 1):
            colors.append(dict(
                id='col-%s-%02d' % (family, i),
                name_ar='%s %d' % (label_ar, i),
                name_en='%s %d' % (label_en, i),
                hex=hex_for(family, i),
                family=family,
                grade=grade,
            ))
    assert len(colors) == 208, len(colors)
    grade_counts = {}
    for c in colors:
        grade_counts[c['grade']] = grade_counts.get(c['grade'], 0) + 1
    assert grade_counts == {'A': 65, 'B': 70, 'C': 54, 'D': 19}, grade_counts

    color_ids = [c['id'] for c in colors]
    color_by_id = {c['id']: c for c in colors}
    fabric_ids = [f['id'] for f in fabrics]
    fabric_by_id = {f['id']: f for f in fabrics}

    # ---- mapping combos ----------------------------------------------------
    all_combos = [(f, c) for f in fabric_ids for c in color_ids]
    rng.shuffle(all_combos)

    # common_pool guarantees overlap between sheds (seeded transfers need it):
    # 12 combos of the wh-625 fabric + 28 others.
    wh625_colors_all = color_ids[:]  # stable order
    common = [(WH625_FABRIC, c) for c in wh625_colors_all[:12]]
    for combo in all_combos:
        if len(common) >= 40:
            break
        if combo[0] != WH625_FABRIC:
            common.append(combo)

    mapping_rows = []          # dicts before rolls
    per_shed_combos = {}
    combo_cursor = 0
    for wh in WAREHOUSE_PLAN:
        if wh['id'] == 'wh-625':
            combos = [(WH625_FABRIC, c) for c in wh625_colors_all[:180]]
            assert len(combos) == 180
        else:
            combos = common[:20]
            seen = set(combos)
            need = wh['mapping_rows'] - len(combos)
            while need > 0:
                combo = all_combos[combo_cursor % len(all_combos)]
                combo_cursor += 1
                if combo not in seen:
                    seen.add(combo)
                    combos.append(combo)
                    need -= 1
        assert len(combos) == wh['mapping_rows'], (wh['id'], len(combos))
        per_shed_combos[wh['id']] = combos
        n_inactive = wh['inactive_rows']
        for idx, (fab, col) in enumerate(combos):
            active = 0 if idx >= len(combos) - n_inactive else 1
            mapping_rows.append(dict(
                id='map-%s-%03d' % (wh['id'], idx + 1),
                warehouse_id=wh['id'], fabric_id=fab, color_id=col,
                min_rolls=5 + (idx * 7) % 16,
                max_rolls=25 + (idx * 11) % 46,
                lead_time_days=2 + (idx * 5) % 13,
                active=active,
            ))
    assert len(mapping_rows) == 1296, len(mapping_rows)
    inactive_rows = [m for m in mapping_rows if m['active'] == 0]
    assert len(inactive_rows) == 26, len(inactive_rows)

    # ---- rolls per mapping row --------------------------------------------
    rolls = {}  # mapping id -> closing rolls
    for wh in WAREHOUSE_PLAN:
        active_ids = [m['id'] for m in mapping_rows if m['warehouse_id'] == wh['id'] and m['active'] == 1]
        parts = distribute(wh['target_active_rolls'], len(active_ids), rng)
        for mid, r in zip(active_ids, parts):
            rolls[mid] = r
        for m in mapping_rows:
            if m['warehouse_id'] == wh['id'] and m['active'] == 0:
                rolls[m['id']] = wh['inactive_rolls_each']

    active_rolls = sum(rolls[m['id']] for m in mapping_rows if m['active'] == 1)
    inactive_rolls = sum(rolls[m['id']] for m in mapping_rows if m['active'] == 0)
    assert active_rolls == 68567, active_rolls
    assert inactive_rolls == 1220, inactive_rolls

    # ---- movements (stock_events) -----------------------------------------
    # 12 transfers (24 events) + 40 in + 40 out + 20 adjustments = 124 events.
    # Each row may appear in at most 2 events; |delta| <= closing//3 keeps
    # opening = closing - net strictly positive.
    row_event_count = {}
    events = []
    span_days = 53

    def add_event(wh_id, fab, col, kind, delta, ref=None, note=None):
        mid = None
        for m in mapping_rows:
            if m['warehouse_id'] == wh_id and m['fabric_id'] == fab and m['color_id'] == col:
                mid = m['id']
                break
        closing = rolls[mid]
        cap = max(1, closing // 3)
        delta = max(-cap, min(cap, delta))
        if delta == 0:
            delta = 1 if kind in ('in', 'transfer_in') else -1
            delta = max(-cap, min(cap, delta))
        row_event_count[mid] = row_event_count.get(mid, 0) + 1
        day = date_add(DATE_WINDOW[0], rng.randint(0, span_days))
        ts = '%sT%02d:%02d:%02dZ' % (day, rng.randint(8, 18), rng.randint(0, 59), rng.randint(0, 59))
        fab_row = fabric_by_id[fab]
        events.append(dict(
            id='evt-%03d' % (len(events) + 1),
            warehouse_id=wh_id, fabric_id=fab, color_id=col, kind=kind,
            rolls_delta=delta,
            meters_delta=delta * fab_row['meters_per_roll'],
            value_delta=delta * fab_row['unit_cost_per_roll'],
            ref_id=ref, note=note,
            actor_user_id=KEEPER_IDS[[w for w in WAREHOUSE_PLAN if w['id'] == wh_id][0]['keeper']],
            created_at=ts, effective_date=day,
        ))

    def candidate_rows(wh_id, need_cap=True):
        out = []
        for m in mapping_rows:
            if m['warehouse_id'] != wh_id or m['active'] != 1:
                continue
            if need_cap and row_event_count.get(m['id'], 0) >= 2:
                continue
            out.append(m)
        return out

    # transfers first (share ref_id pairs)
    overlap = []
    for i, w1 in enumerate(WAREHOUSE_PLAN):
        for w2 in WAREHOUSE_PLAN[i + 1:]:
            s2 = set(per_shed_combos[w2['id']])
            shared = [c for c in per_shed_combos[w1['id']] if c in s2]
            for combo in shared:
                m1 = next(m for m in mapping_rows if m['warehouse_id'] == w1['id'] and (m['fabric_id'], m['color_id']) == combo and m['active'] == 1)
                m2 = next(m for m in mapping_rows if m['warehouse_id'] == w2['id'] and (m['fabric_id'], m['color_id']) == combo and m['active'] == 1)
                if row_event_count.get(m1['id'], 0) < 2 and row_event_count.get(m2['id'], 0) < 2:
                    overlap.append((w1['id'], w2['id'], combo))
    rng.shuffle(overlap)
    t = 0
    for w1, w2, (fab, col) in overlap:
        if t >= 12:
            break
        ref = 'trf-%03d' % (t + 1)
        add_event(w1, fab, col, 'transfer_out', -rng.randint(3, 12), ref=ref, note='تحويل')
        add_event(w2, fab, col, 'transfer_in', rng.randint(3, 12), ref=ref, note='تحويل')
        t += 1
    assert t == 12, t

    # 10 plain events per shed: 4 in, 4 out, 2 adjustments
    for wh in WAREHOUSE_PLAN:
        for k in range(10):
            cands = candidate_rows(wh['id'])
            if not cands:
                cands = [m for m in mapping_rows if m['warehouse_id'] == wh['id'] and m['active'] == 1]
            m = cands[rng.randrange(len(cands))]
            if k < 4:
                add_event(wh['id'], m['fabric_id'], m['color_id'], 'in', rng.randint(2, 20))
            elif k < 8:
                add_event(wh['id'], m['fabric_id'], m['color_id'], 'out', -rng.randint(2, 20))
            else:
                add_event(wh['id'], m['fabric_id'], m['color_id'], 'adjustment', rng.randint(-12, 12))
    assert len(events) == 124, len(events)

    # ---- opening = closing - net ------------------------------------------
    net = {}
    for e in events:
        key = (e['warehouse_id'], e['fabric_id'], e['color_id'])
        net[key] = net.get(key, 0) + e['rolls_delta']
    stock_rows = []
    for m in mapping_rows:
        key = (m['warehouse_id'], m['fabric_id'], m['color_id'])
        closing = rolls[m['id']]
        n = net.get(key, 0)
        opening = closing - n
        assert opening >= 1, (m, closing, n)
        rolls_in = sum(e['rolls_delta'] for e in events if (e['warehouse_id'], e['fabric_id'], e['color_id']) == key and e['rolls_delta'] > 0)
        rolls_out = sum(-e['rolls_delta'] for e in events if (e['warehouse_id'], e['fabric_id'], e['color_id']) == key and e['rolls_delta'] < 0)
        assert opening + rolls_in - rolls_out == closing
        stock_rows.append(dict(
            warehouse_id=m['warehouse_id'], fabric_id=m['fabric_id'], color_id=m['color_id'],
            opening_rolls=opening, rolls_in=rolls_in, rolls_out=rolls_out, closing_rolls=closing,
        ))
    assert len(stock_rows) == 1296

    # ---- keeper codes ------------------------------------------------------
    keeper_codes = []
    fam_index = {}
    for c in colors:
        fam_index.setdefault(c['family'], []).append(c['id'])
    for cid, keeper, (family, idx), code, name, notes in SEED_KEEPER_CODES:
        keeper_codes.append(dict(
            id=cid, keeper_user_id=keeper, color_id=fam_index[family][idx - 1],
            custom_code=code, custom_name=name, notes=notes, last_updated='2026-10-20',
        ))
    assert len(keeper_codes) == 7

    # ---- write 0002_seed.sql ---------------------------------------------
    out = []
    out.append('-- migrations/0002_seed.sql — GENERATED by tools/make_seed_sql.py.')
    out.append('-- Never hand-edited. Every number is derived from the plan tables.')
    out.append('PRAGMA foreign_keys=OFF;')
    out.append('BEGIN TRANSACTION;')

    for wh in WAREHOUSE_PLAN:
        out.append('INSERT INTO warehouses (id, name_ar, name_en, keeper_user_id, allowed_grades, grade_label_ar, capacity_rolls, active) VALUES (%s);' % ','.join([
            q(wh['id']), q(wh['name_ar']), q(wh['name_en']), q(KEEPER_IDS[wh['keeper']]),
            q(wh['allowed_grades']), q(wh['grade_label_ar']), str(wh['capacity_rolls']), '1',
        ]))
    for f in fabrics:
        out.append('INSERT INTO fabrics (id, name_ar, name_en, meters_per_roll, unit_cost_per_roll, active) VALUES (%s);' % ','.join([
            q(f['id']), q(f['name_ar']), q(f['name_en']), str(f['meters_per_roll']), str(f['unit_cost_per_roll']), '1',
        ]))
    for c in colors:
        out.append('INSERT INTO colors (id, name_ar, name_en, hex, family, grade, active) VALUES (%s);' % ','.join([
            q(c['id']), q(c['name_ar']), q(c['name_en']), q(c['hex']), q(c['family']), q(c['grade']), '1',
        ]))
    for m in mapping_rows:
        out.append('INSERT INTO mappings (id, warehouse_id, fabric_id, color_id, min_rolls, max_rolls, lead_time_days, active) VALUES (%s);' % ','.join([
            q(m['id']), q(m['warehouse_id']), q(m['fabric_id']), q(m['color_id']),
            str(m['min_rolls']), str(m['max_rolls']), str(m['lead_time_days']), str(m['active']),
        ]))
    for s in stock_rows:
        out.append('INSERT INTO stock_current (warehouse_id, fabric_id, color_id, opening_rolls, rolls_in, rolls_out, closing_rolls) VALUES (%s);' % ','.join([
            q(s['warehouse_id']), q(s['fabric_id']), q(s['color_id']),
            str(s['opening_rolls']), str(s['rolls_in']), str(s['rolls_out']), str(s['closing_rolls']),
        ]))
    for e in events:
        out.append('INSERT INTO stock_events (id, warehouse_id, fabric_id, color_id, kind, rolls_delta, meters_delta, value_delta, ref_id, note, actor_user_id, created_at, effective_date) VALUES (%s);' % ','.join([
            q(e['id']), q(e['warehouse_id']), q(e['fabric_id']), q(e['color_id']), q(e['kind']),
            str(e['rolls_delta']), str(e['meters_delta']), str(e['value_delta']),
            q(e['ref_id']), q(e['note']), q(e['actor_user_id']), q(e['created_at']), q(e['effective_date']),
        ]))
    for k in keeper_codes:
        out.append('INSERT INTO keeper_color_codes (id, keeper_user_id, color_id, custom_code, custom_name, notes, last_updated) VALUES (%s);' % ','.join([
            q(k['id']), q(k['keeper_user_id']), q(k['color_id']), q(k['custom_code']),
            q(k['custom_name']), q(k['notes']), q(k['last_updated']),
        ]))
    for u in SEED_USERS:
        out.append('INSERT INTO users (id, username, password_hash, display_name_ar, display_name_en, role, warehouse_ids, active) VALUES (%s);' % ','.join([
            q(u['id']), q(u['username']), q(user_hash(u)), q(u['display_name_ar']),
            q(u['display_name_en']), q(u['role']), q(u['warehouse_ids']), '1',
        ]))
    out.append('INSERT INTO settings (key, value) VALUES (%s);' % ','.join([q('guide_version'), q(SEED_VERSION)]))
    out.append('INSERT INTO settings (key, value) VALUES (%s);' % ','.join([q('storage_mode'), q('cloudflare-d1')]))
    out.append('COMMIT;')

    sql_path = os.path.join(ROOT, 'migrations', '0002_seed.sql')
    with open(sql_path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out) + '\n')

    # ---- manifest (everything derived from the rows above) -----------------
    def shed_summary(wh):
        rows_w = [m for m in mapping_rows if m['warehouse_id'] == wh['id']]
        active_w = [m for m in rows_w if m['active'] == 1]
        arolls = sum(rolls[m['id']] for m in active_w)
        rrolls = sum(rolls[m['id']] for m in rows_w)
        util = round(arolls / wh['capacity_rolls'] * 100, 1) if wh['capacity_rolls'] else 0.0
        return dict(
            id=wh['id'], name_ar=wh['name_ar'], name_en=wh['name_en'],
            keeper=wh['keeper'],
            fabrics=len(set(m['fabric_id'] for m in active_w)),
            colors_mapped=len(rows_w),
            colors_active=len(active_w),
            active_rolls=arolls,
            raw_rolls=rrolls,
            capacity=wh['capacity_rolls'],
            util_pct=util,
        )

    sheds = [shed_summary(w) for w in WAREHOUSE_PLAN]
    mostafa = sum(s['active_rolls'] for s in sheds if s['keeper'] == 'keeper1')
    colleague = sum(s['active_rolls'] for s in sheds if s['keeper'] == 'keeper2')
    company = mostafa + colleague
    raw_total = sum(rolls[m['id']] for m in mapping_rows)

    w625 = next(s for s in sheds if s['id'] == 'wh-625')
    records = (len(WAREHOUSE_PLAN) + len(fabrics) + len(colors) + len(mapping_rows)
               + len(events) + len(stock_rows) + len(keeper_codes) + len(SEED_USERS))

    kinds = {}
    for e in events:
        kinds[e['kind']] = kinds.get(e['kind'], 0) + 1

    manifest = dict(
        seed_version=SEED_VERSION,
        generator='tools/make_seed_sql.py',
        counts=dict(
            warehouses=len(WAREHOUSE_PLAN), fabrics=len(fabrics), colors=len(colors),
            mappings=len(mapping_rows), inventory_rows=len(stock_rows),
            movements=len(events), keeper_codes=len(keeper_codes),
            users=len(SEED_USERS), records=records,
        ),
        color_grades={g: grade_counts[g] for g in ['A', 'B', 'C', 'D']},
        families=len(COLOR_FAMILIES),
        rolls=dict(
            mostafa_active=mostafa, keeper2_active=colleague, company_active=company,
            raw_total=raw_total, inactive_mapping_rows=len(inactive_rows),
            inactive_rolls=inactive_rolls,
        ),
        movements=dict(kinds=kinds, transfers=kinds.get('transfer_out', 0), total=len(events)),
        wh625=dict(
            fabrics=w625['fabrics'], mapped_colors=w625['colors_mapped'],
            active_colors=w625['colors_active'], active_rolls=w625['active_rolls'],
            raw_rolls=w625['raw_rolls'], capacity=w625['capacity'], util_pct=w625['util_pct'],
        ),
        sheds=sheds,
        sign_ins=[dict(username=u['username'], password=u['password'], who_en=u['who_en'], who_ar=u['who_ar'],
                       role=u['role'], scope_en=u['scope_en'], scope_ar=u['scope_ar'],
                       warehouse_ids=json.loads(u['warehouse_ids'])) for u in SEED_USERS],
    )
    with open(os.path.join(ROOT, 'seed_manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write('\n')

    # ---- print every derived number (rule: never invent; always derive) ----
    print('== seed manifest (derived) ==')
    print('counts:', json.dumps(manifest['counts'], ensure_ascii=False))
    print('color_grades:', json.dumps(manifest['color_grades']))
    print('families:', manifest['families'])
    print('rolls:', json.dumps(manifest['rolls']))
    print('movements:', json.dumps(manifest['movements']))
    print('wh-625:', json.dumps(manifest['wh625'], ensure_ascii=False))
    for s in sheds:
        print('shed %-12s fabrics=%-3d colors=%-3d active=%-3d rolls=%-6d raw=%-6d cap=%-6d util=%s%%' % (
            s['id'], s['fabrics'], s['colors_mapped'], s['colors_active'],
            s['active_rolls'], s['raw_rolls'], s['capacity'], s['util_pct']))
    print('records:', records)
    print('wrote migrations/0002_seed.sql and seed_manifest.json')


if __name__ == '__main__':
    main()
