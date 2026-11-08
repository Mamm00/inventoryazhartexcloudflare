#!/usr/bin/env python3
# tools/make_landing.py — generates app/landing.html (bilingual EN/AR landing
# page: numbers table, sign-in table, structure) and fills the README.md
# SEED-MANIFEST marker block. Every number comes from seed_manifest.json —
# nothing is typed by hand here.

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Parity keys: the landing page renders each of these twice (EN block, AR
# block). tests/site.test.js asserts both blocks carry the identical key set.
PARITY = {
    'title': ('Fabric Roll Stock', 'مخزون بكرات القماش'),
    'tagline': ('Fabric-roll stock management for an Egyptian fabric merchant', 'إدارة مخزون بكرات القماش للتاجر المصري'),
    'intro': ('Warehouse → Fabric type → Colour → Roll. A roll is counted; metres come from metres per roll.', 'المخزن → نوع القماش → اللون → البكرة. البكرة تُعدّ؛ والأمتار من أمتار البكرة.'),
    'numbers_h': ('Numbers (derived from the seed generator)', 'الأرقام (مصدرها مولّد البيانات)'),
    'signins_h': ('Seeded sign-ins', 'حسابات الدخول المزروعة'),
    'open_h': ('Open the app', 'افتح التطبيق'),
    'security_h': ('Security', 'الأمان'),
    'security_body': ('Server-side RBAC is enforced in every Pages Function and in the Durable Object; the browser copy of can() only hides buttons. The writable app requires Cloudflare and HTTPS; the offline snapshot is read-only.', 'يتم فرض صلاحيات RBAC على الخادم في كل Pages Function وفي Durable Object؛ ونسخة can() في المتصفح لإخفاء الأزرار فقط. التطبيق القابل للكتابة يتطلب Cloudflare و HTTPS؛ واللقطة غير المتصلة للقراءة فقط.'),
    'deploy_h': ('Deployment', 'النشر'),
    'deploy_body': ('GitHub → Cloudflare Pages Git integration. Build command: npm run build. Output: app/. The companion Worker provides Durable Objects, queues and cron.', 'GitHub → تكامل Cloudflare Pages مع Git. أمر البناء: npm run build. المخرجات: app/. والـ Worker المرافق يوفّر Durable Objects والطوابير والمهام المجدولة.'),
}

def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def build_landing(m):
    counts = m['counts']
    rolls = m['rolls']
    w625 = m['wh625']

    def parity_block(lang_idx, lang, dir_):
        items = []
        for key, vals in PARITY.items():
            tag = 'h1' if key == 'title' else 'h2' if key.endswith('_h') else 'p'
            items.append(f'<{tag} data-k="{key}">{esc(vals[lang_idx])}</{tag}>')
        return f'<section id="lang-{lang}" lang="{lang}" dir="{dir_}">' + '\n'.join(items) + '</section>'

    sign_rows = []
    for s in m['sign_ins']:
        who = s['who_ar'] + ' / ' + s['who_en']
        scope = s['scope_ar'] + ' / ' + s['scope_en']
        sign_rows.append(
            f'<tr><td dir="ltr">{esc(s["username"])}</td><td dir="ltr">{esc(s["password"])}</td>'
            f'<td>{esc(who)}</td><td>{esc(scope)}</td></tr>'
        )

    numbers = [
        ('warehouses', counts['warehouses']), ('fabrics', counts['fabrics']),
        ('colors', counts['colors']), ('mappings', counts['mappings']),
        ('inventory rows', counts['inventory_rows']), ('movements', counts['movements']),
        ('keeper codes', counts['keeper_codes']), ('records', counts['records']),
        ('rolls — Mostafa sheds', rolls['mostafa_active']),
        ('rolls — colleague sheds', rolls['keeper2_active']),
        ('rolls — shed cards total', rolls['company_active']),
        ('rolls — raw inventory total', rolls['raw_total']),
        ('deactivated mapping rows', rolls['inactive_mapping_rows']),
        ('rolls on deactivated mappings', rolls['inactive_rolls']),
        ('wh-625 mapped colours', w625['mapped_colors']),
        ('wh-625 active colours', w625['active_colors']),
        ('wh-625 rolls', w625['active_rolls']),
        ('wh-625 capacity', w625['capacity']),
        ('wh-625 utilisation %', w625['util_pct']),
    ]
    num_rows = '\n'.join(f'<tr><td>{esc(k)}</td><td dir="ltr">{v}</td></tr>' for k, v in numbers)

    shed_rows = []
    for s in m['sheds']:
        shed_rows.append(
            f'<tr><td>{esc(s["id"])}</td><td>{esc(s["name_ar"])} / {esc(s["name_en"])}</td>'
            f'<td dir="ltr">{s["active_rolls"]}</td><td dir="ltr">{s["capacity"]}</td>'
            f'<td dir="ltr">{s["util_pct"]}%</td></tr>'
        )

    return f'''<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fabric Roll Stock — مخزون بكرات القماش</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<style>
 body {{ font-family: 'Segoe UI', Tahoma, Arial, sans-serif; margin: 0; background: #f4f6fb; color: #1c2433; }}
 header {{ background: #163a7c; color: #fff; padding: 1.4rem 2rem; }}
 main {{ max-width: 940px; margin: 1.5rem auto 3rem; padding: 0 1.25rem; }}
 section {{ background: #fff; border: 1px solid #d9dfeb; border-radius: 12px; padding: 1.1rem 1.35rem; margin-bottom: 1.15rem; }}
 table {{ border-collapse: collapse; width: 100%; }}
 th, td {{ border: 1px solid #d9dfeb; padding: .34rem .6rem; text-align: start; font-size: .92rem; }}
 th {{ background: #e9eef8; }}
 h1 {{ margin: .2rem 0; }}
 h2 {{ color: #163a7c; margin-top: 1rem; }}
 .two {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1.15rem; }}
 a.btn {{ display: inline-block; background: #1f4fa3; color: #fff; padding: .55rem 1.15rem; border-radius: 9px; text-decoration: none; }}
 .foot {{ color: #5b6472; font-size: .85rem; text-align: center; padding: 1rem; }}
</style>
</head>
<body>
<header>
  <div>Fabric Roll Stock</div>
  <div>مخزون بكرات القماش</div>
</header>
<main>
  <div class="two">
    {parity_block(0, 'en', 'ltr')}
    {parity_block(1, 'ar', 'rtl')}
  </div>
  <section>
    <h2>Numbers / الأرقام — seed_manifest.json</h2>
    <table id="numbers-table"><thead><tr><th>Metric</th><th>Value</th></tr></thead>
    <tbody>{num_rows}</tbody></table>
  </section>
  <section>
    <h2>Shed map / خريطة المخازن</h2>
    <table id="shed-table"><thead><tr><th>id</th><th>name</th><th>rolls</th><th>capacity</th><th>util</th></tr></thead>
    <tbody>{chr(10).join(shed_rows)}</tbody></table>
  </section>
  <section>
    <h2>Seeded sign-ins / حسابات الدخول</h2>
    <table id="signins-table"><thead><tr><th>Username</th><th>Password</th><th>Who</th><th>Scope</th></tr></thead>
    <tbody>{chr(10).join(sign_rows)}</tbody></table>
  </section>
  <section>
    <h2>Open the app / افتح التطبيق</h2>
    <p><a class="btn" href="/index.html">app/index.html</a></p>
  </section>
</main>
<div class="foot">Generated by tools/make_landing.py from seed_manifest.json · الأرقام مولّدة من seed_manifest.json</div>
</body>
</html>
'''


def readme_block(m):
    counts = m['counts']
    rolls = m['rolls']
    w625 = m['wh625']
    lines = [
        '| Metric | Value |', '| --- | --- |',
        f'| Warehouses | {counts["warehouses"]} |',
        f'| Fabrics | {counts["fabrics"]} |',
        f'| Colours (A {m["color_grades"]["A"]} · B {m["color_grades"]["B"]} · C {m["color_grades"]["C"]} · D {m["color_grades"]["D"]}, {m["families"]} families) | {counts["colors"]} |',
        f'| Mapping rows | {counts["mappings"]} |',
        f'| Inventory rows | {counts["inventory_rows"]} |',
        f'| Movements (stock_events) | {counts["movements"]} |',
        f'| Keeper colour codes | {counts["keeper_codes"]} |',
        f'| Records (countRecords) | {counts["records"]} |',
        f'| Rolls — Mostafa sheds | {rolls["mostafa_active"]} |',
        f'| Rolls — colleague sheds | {rolls["keeper2_active"]} |',
        f'| Rolls — shed cards total | {rolls["company_active"]} |',
        f'| Rolls — raw inventory total | {rolls["raw_total"]} |',
        f'| Deactivated mapping rows / rolls | {rolls["inactive_mapping_rows"]} / {rolls["inactive_rolls"]} |',
        f'| wh-625 (1 fabric · {w625["mapped_colors"]} mapped · {w625["active_colors"]} active) | {w625["active_rolls"]} rolls / {w625["capacity"]} cap = {w625["util_pct"]}% |',
    ]
    return '\n'.join(lines)


def main():
    with open(os.path.join(ROOT, 'seed_manifest.json'), encoding='utf-8') as fh:
        m = json.load(fh)
    landing = build_landing(m)
    with open(os.path.join(ROOT, 'app', 'landing.html'), 'w', encoding='utf-8') as fh:
        fh.write(landing)

    readme_path = os.path.join(ROOT, 'README.md')
    with open(readme_path, encoding='utf-8') as fh:
        readme = fh.read()
    block = readme_block(m)
    pattern = re.compile(r'(<!-- SEED-MANIFEST:BEGIN -->)(.*?)(<!-- SEED-MANIFEST:END -->)', re.S)
    if pattern.search(readme):
        readme = pattern.sub(lambda mm: mm.group(1) + '\n' + block + '\n' + mm.group(3), readme)
    else:
        readme += '\n<!-- SEED-MANIFEST:BEGIN -->\n' + block + '\n<!-- SEED-MANIFEST:END -->\n'
    with open(readme_path, 'w', encoding='utf-8') as fh:
        fh.write(readme)
    print('make_landing: wrote app/landing.html and README.md numbers block')
    return 0


if __name__ == '__main__':
    sys.exit(main())
