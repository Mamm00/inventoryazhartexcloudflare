#!/usr/bin/env python3
# tools/copy_shared.py — copies the pure shared modules into app/ so the SPA
# can import them as ES modules. The copies are committed; tools/check.sh fails
# if they are stale.

import filecmp
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ['i18n.js', 'permissions.js', 'stock-math.js']

def main():
    stale = []
    for f in FILES:
        src = os.path.join(ROOT, 'shared', f)
        dst = os.path.join(ROOT, 'app', f)
        if not os.path.exists(dst) or not filecmp.cmp(src, dst, shallow=False):
            shutil.copyfile(src, dst)
            stale.append(f)
    print('copy_shared:', ', '.join(stale) if stale else 'all copies fresh')
    return 0

if __name__ == '__main__':
    sys.exit(main())
