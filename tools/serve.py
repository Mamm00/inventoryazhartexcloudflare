#!/usr/bin/env python3
# tools/serve.py — local read-only preview server for the SPA + seeded data.
# Serves app/ statically and answers the read-only /api endpoints from the
# local SQLite database (migrations + seed). Writable endpoints are refused
# with 403 and a note: writable mode requires Cloudflare and HTTPS.

import http.server
import json
import os
import re
import sqlite3
import sys
import urllib.parse
import hashlib
import hmac

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, 'app')
DB_PATH = os.path.join(ROOT, 'local-preview.db')
PORT = int(os.environ.get('PORT', '8788'))


def load_db():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    for f in sorted(os.listdir(os.path.join(ROOT, 'migrations'))):
        if f.endswith('.sql'):
            db.executescript(open(os.path.join(ROOT, 'migrations', f), encoding='utf-8').read())
    return db


def rows(db, sql, bind=()):
    return [dict(r) for r in db.execute(sql, bind).fetchall()]


def one(db, sql, bind=()):
    r = db.execute(sql, bind).fetchone()
    return dict(r) if r else None


class Handler(http.server.SimpleHTTPRequestHandler):
    db = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path.startswith('/api/'):
            return self.api_get(url)
        if url.path in ('/', ''):
            self.path = '/index.html'
        if url.path == '/landing.html' or self.path.endswith('.html') or self.path.endswith('.svg') \
                or self.path.endswith('.css') or self.path.endswith('.js'):
            return super().do_GET()
        # 404 bounce for unknown paths
        self.path = '/404.html'
        return super().do_GET()

    def do_POST(self):
        self.send_json({'error': 'READ_ONLY_PREVIEW', 'message': 'Writable mode requires Cloudflare and HTTPS'}, 403)

    def do_PATCH(self):
        self.do_POST()

    def do_DELETE(self):
        self.do_POST()

    # ---- read-only API (same shapes as the Pages Functions) ---------------

    def api_get(self, url):
        db = self.db
        path = url.path
        qs = urllib.parse.parse_qs(url.query)
        if path == '/api/health':
            return self.send_json({'ok': True, 'service': 'fabric-roll-stock', 'mode': 'local-preview'})
        if path == '/api/auth/me':
            return self.send_json({'user': PREVIEW_USER, 'scope': PREVIEW_USER['warehouseIds']})
        if path == '/api/stock':
            sheds = []
            for wid in PREVIEW_USER['warehouseIds']:
                sheds.append(self.warehouse_summary(wid))
            totals = {
                'rolls': sum(s['rolls'] for s in sheds),
                'meters': sum(s['meters'] for s in sheds),
                'value': sum(s['value'] for s in sheds),
                'low_stock': sum(s['low_stock'] for s in sheds),
                'fabric_types': len(rows(db, 'SELECT DISTINCT fabric_id FROM mappings WHERE active=1')),
                'shed_count': len(sheds),
            }
            return self.send_json({'sheds': sheds, 'totals': totals, 'scope': PREVIEW_USER['warehouseIds']})
        if path == '/api/inventory':
            wh = qs.get('wh', [None])[0]
            fab = qs.get('fab', [None])[0]
            wids = [wh] if wh else PREVIEW_USER['warehouseIds']
            tree = []
            for wid in wids:
                w = one(db, 'SELECT * FROM warehouses WHERE id=?', (wid,))
                fs = rows(db, 'SELECT DISTINCT fabric_id FROM mappings WHERE warehouse_id=? ORDER BY fabric_id', (wid,))
                tree.append({'warehouse': w, 'fabrics': [self.fabric_summary(wid, f['fabric_id']) for f in fs]})
            out_rows = []
            if wh:
                sql = '''SELECT m.warehouse_id, m.fabric_id, m.color_id, m.min_rolls, m.max_rolls, m.lead_time_days, m.active,
                    f.name_ar AS fab_name_ar, f.name_en AS fab_name_en, f.meters_per_roll, f.unit_cost_per_roll,
                    c.name_ar AS col_name_ar, c.name_en AS col_name_en, c.hex, c.family, c.grade,
                    COALESCE(s.opening_rolls,0) opening_rolls, COALESCE(s.rolls_in,0) rolls_in,
                    COALESCE(s.rolls_out,0) rolls_out, COALESCE(s.closing_rolls,0) closing_rolls
                    FROM mappings m JOIN fabrics f ON f.id=m.fabric_id JOIN colors c ON c.id=m.color_id
                    LEFT JOIN stock_current s ON s.warehouse_id=m.warehouse_id AND s.fabric_id=m.fabric_id AND s.color_id=m.color_id
                    WHERE m.warehouse_id=?'''
                bind = [wh]
                if fab:
                    sql += ' AND m.fabric_id=?'
                    bind.append(fab)
                for r in rows(db, sql + ' ORDER BY m.fabric_id, m.color_id', bind):
                    closing = r['closing_rolls']
                    st = 'out' if closing == 0 else 'low' if closing <= r['min_rolls'] else 'over' if r['max_rolls'] and closing >= r['max_rolls'] else 'ok'
                    out_rows.append({
                        **r,
                        'meters': closing * (r['meters_per_roll'] or 0),
                        'value': closing * (r['unit_cost_per_roll'] or 0),
                        'status': st,
                        'status_key': f'status.{st}',
                        'reorder': max(0, -(r['min_rolls'] - closing) // -1) if closing < r['min_rolls'] else 0,
                        'mapping_active': r['active'] == 1,
                        'valid': r['active'] == 1,
                    })
            return self.send_json({'tree': tree, 'rows': out_rows, 'scope': PREVIEW_USER['warehouseIds']})
        if path == '/api/readme':
            record_count = sum(one(db, f'SELECT COUNT(*) n FROM {t}')['n'] for t in
                               ['warehouses', 'fabrics', 'colors', 'mappings', 'stock_events', 'stock_current', 'keeper_color_codes', 'users'])
            shed_map = [self.warehouse_summary(wid) for wid in PREVIEW_USER['warehouseIds']]
            return self.send_json({
                'version': '1.2.0', 'storageMode': 'cloudflare-d1',
                'recordCount': record_count,
                'roleMatrix': {'actions': ['inventory.write'], 'perms': {}, 'roles': ['Admin', 'WarehouseKeeper', 'SalesManager']},
                'views': ['readme', 'stock', 'inventory', 'movements', 'colors', 'cross', 'dashboard', 'reports', 'masters', 'audit', 'settings'],
                'shedMap': shed_map,
                'shedMapTotal': sum(s['rolls'] for s in shed_map),
                'scopeIsAll': False,
                'steps': ['rd.step%d' % i for i in range(1, 9)],
            })
        return self.send_json({'error': 'NOT_IN_PREVIEW', 'message': 'This endpoint runs on Cloudflare Pages only'}, 404)

    def warehouse_summary(self, wid):
        db = self.db
        w = one(db, 'SELECT * FROM warehouses WHERE id=?', (wid,))
        agg = one(db, '''SELECT COUNT(DISTINCT m.fabric_id) fabric_types, COUNT(*) colors,
            COALESCE(SUM(s.closing_rolls),0) rolls
            FROM mappings m LEFT JOIN stock_current s ON s.warehouse_id=m.warehouse_id
            AND s.fabric_id=m.fabric_id AND s.color_id=m.color_id
            WHERE m.warehouse_id=? AND m.active=1''', (wid,))
        detail = rows(db, '''SELECT COALESCE(s.closing_rolls,0) closing_rolls, f.meters_per_roll, f.unit_cost_per_roll,
            m.min_rolls, m.max_rolls FROM mappings m JOIN fabrics f ON f.id=m.fabric_id
            LEFT JOIN stock_current s ON s.warehouse_id=m.warehouse_id AND s.fabric_id=m.fabric_id AND s.color_id=m.color_id
            WHERE m.warehouse_id=? AND m.active=1''', (wid,))
        meters = sum(r['closing_rolls'] * (r['meters_per_roll'] or 0) for r in detail)
        value = sum(r['closing_rolls'] * (r['unit_cost_per_roll'] or 0) for r in detail)
        low = sum(1 for r in detail if r['closing_rolls'] <= r['min_rolls'])
        cap = w['capacity_rolls'] or 0
        rolls = agg['rolls']
        util = (rolls / cap * 100) if cap else 0
        band = 'red' if util > 85 else 'amber' if util >= 50 else 'green'
        last = one(db, 'SELECT MAX(created_at) last_activity FROM stock_events WHERE warehouse_id=?', (wid,))
        return {
            'id': wid, 'name_ar': w['name_ar'], 'name_en': w['name_en'],
            'keeper_user_id': w['keeper_user_id'], 'allowed_grades': w['allowed_grades'],
            'grade_label_ar': w['grade_label_ar'], 'capacity_rolls': cap,
            'fabric_types': agg['fabric_types'], 'colors': agg['colors'],
            'rolls': rolls, 'meters': meters, 'value': value, 'low_stock': low,
            'utilization_pct': round(util, 1), 'utilization_band': band,
            'last_activity': last['last_activity'],
        }

    def fabric_summary(self, wid, fab):
        db = self.db
        f = one(db, 'SELECT * FROM fabrics WHERE id=?', (fab,))
        detail = rows(db, '''SELECT COALESCE(s.closing_rolls,0) closing_rolls, m.min_rolls, m.max_rolls
            FROM mappings m LEFT JOIN stock_current s ON s.warehouse_id=m.warehouse_id
            AND s.fabric_id=m.fabric_id AND s.color_id=m.color_id
            WHERE m.warehouse_id=? AND m.fabric_id=?''', (wid, fab))
        rolls = sum(r['closing_rolls'] for r in detail)
        return {
            'warehouse_id': wid, 'fabric_id': fab,
            'name_ar': f['name_ar'], 'name_en': f['name_en'],
            'meters_per_roll': f['meters_per_roll'], 'unit_cost_per_roll': f['unit_cost_per_roll'],
            'colors': len(detail), 'rolls': rolls,
            'meters': rolls * (f['meters_per_roll'] or 0),
            'value': rolls * (f['unit_cost_per_roll'] or 0),
            'low': sum(1 for r in detail if r['closing_rolls'] <= r['min_rolls']),
            'out': sum(1 for r in detail if r['closing_rolls'] == 0),
        }


# Read-only preview signs in as the admin account's view of the ten sheds.
PREVIEW_USER = {
    'id': 'u-admin', 'username': 'admin', 'role': 'Admin', 'warehouseIds': [
        'wh-alwa', 'wh-leon', 'wh-azouz', 'wh-zibda', 'wh-showroom',
        'wh-625', 'wh-magdy', 'wh-wahman', 'wh-lycra', 'wh-kashry',
    ],
    'displayNameAr': 'المسؤول', 'displayNameEn': 'Admin',
}


def main():
    Handler.db = load_db()
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'serving read-only preview on http://0.0.0.0:{PORT} (app/ + local SQLite seed)')
    server.serve_forever()


if __name__ == '__main__':
    main()
