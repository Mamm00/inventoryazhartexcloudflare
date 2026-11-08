#!/usr/bin/env python3
"""make_seed_module.py — generate shared/seed-sql.js: the migration SQL
embedded as JS string constants, so the app can initialize an empty database
itself (POST /api/auth/setup, first-run only). The SQL stays single-sourced
from migrations/*.sql — edit those, never this output."""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "shared" / "seed-sql.js"

FILES = [
    ("0001_schema.sql", "SCHEMA_SQL"),
    ("0002_seed.sql", "SEED_SQL"),
    ("0003_indexes.sql", "INDEXES_SQL"),
]

parts = [
    "// tools/make_seed_module.py — GENERATED from migrations/*.sql. Do not edit.\n"
]
for name, var in FILES:
    text = (ROOT / "migrations" / name).read_text(encoding="utf-8")
    parts.append(f"export const {var} = {json.dumps(text, ensure_ascii=False)};\n")

OUT.write_text("".join(parts), encoding="utf-8")
print(f"seed-sql.js written ({OUT.stat().st_size} bytes)")
