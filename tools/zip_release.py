#!/usr/bin/env python3
# tools/zip_release.py — three archives with .sha256 sidecars:
#   1. source  — repo minus node_modules, .git, .wrangler
#   2. pages   — app/, functions/, migrations/, worker/, wrangler.toml, DEPLOY.md
#   3. handover — repo + flattened deploy/ folder + FINAL.md
# Archives land in dist/ (gitignored — generated artifacts stay out of Git).

import hashlib
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')

EXCLUDE_DIRS = {'node_modules', '.git', '.wrangler', 'dist', '__pycache__', '.mypy_cache'}
EXCLUDE_FILES = {'.DS_Store'}

PAGES_KEEP = {'app', 'functions', 'migrations', 'worker', 'tools'}
PAGES_FILES = {'wrangler.toml', 'DEPLOY.md', 'package.json'}


def excluded(rel):
    parts = rel.split(os.sep)
    return any(p in EXCLUDE_DIRS for p in parts) or os.path.basename(rel) in EXCLUDE_FILES


def add_path(zf, abs_path, arc_root):
    if os.path.isdir(abs_path):
        for dirpath, dirnames, filenames in os.walk(abs_path):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for f in filenames:
                if f in EXCLUDE_FILES:
                    continue
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, ROOT)
                zf.write(full, os.path.join(arc_root, rel) if arc_root else rel)
    else:
        rel = os.path.relpath(abs_path, ROOT)
        zf.write(abs_path, os.path.join(arc_root, rel) if arc_root else os.path.basename(abs_path))


def zip_repo(zf, skip_top=()):
    for entry in sorted(os.listdir(ROOT)):
        if entry in EXCLUDE_DIRS or entry in skip_top:
            continue
        add_path(zf, os.path.join(ROOT, entry), '')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def make(name, builder):
    out = os.path.join(DIST, name)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        builder(zf)
    digest = sha256(out)
    with open(out + '.sha256', 'w') as fh:
        fh.write(f'{digest}  {name}\n')
    size = os.path.getsize(out)
    print(f'{name}  {size} bytes  sha256:{digest[:16]}')
    return out


def main():
    os.makedirs(DIST, exist_ok=True)

    def source(zf):
        zip_repo(zf)

    def pages(zf):
        for entry in sorted(os.listdir(ROOT)):
            if entry in PAGES_KEEP or entry in PAGES_FILES:
                add_path(zf, os.path.join(ROOT, entry), '')

    def handover(zf):
        zip_repo(zf)
        # flattened deploy/ folder: deployables at deploy/<name>
        for entry in sorted(os.listdir(ROOT)):
            if entry in PAGES_KEEP or entry in PAGES_FILES:
                src = os.path.join(ROOT, entry)
                if os.path.isdir(src):
                    add_path(zf, src, os.path.join('deploy', entry))
                else:
                    zf.write(src, os.path.join('deploy', entry))
        for extra in ('FINAL.md', 'DEPLOY.md', 'seed_manifest.json'):
            p = os.path.join(ROOT, extra)
            if os.path.exists(p):
                zf.write(p, extra)

    make('fabric-roll-stock-source.zip', source)
    make('fabric-roll-stock-pages.zip', pages)
    make('fabric-roll-stock-handover.zip', handover)
    print('archives written to dist/ with .sha256 sidecars')
    return 0


if __name__ == '__main__':
    sys.exit(main())
