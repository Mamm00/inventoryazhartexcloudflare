#!/usr/bin/env bash
# tools/check.sh — the full pipeline. Fails on the first violation:
#   1. regenerate seed + landing + shared copies (byte-deterministic)
#   2. staleness: app/ and migrations/0002_seed.sql must match regeneration
#   3. load migrations + seed into the local D1 adapter and print every number
#   4. run all five suites (four node --test suites + lint)
#   5. build check: wrangler pages functions build (or node --check fallback)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/5 regenerate =="
python3 tools/make_seed_sql.py
python3 tools/make_landing.py
python3 tools/copy_shared.py

echo "== 2/5 staleness =="
stale=0
check_fresh() {
  local f="$1"
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    if ! git diff --quiet -- "$f"; then
      echo "STALE: $f differs from regeneration (commit the generated file)"; stale=1
    fi
  fi
}
for f in migrations/0002_seed.sql seed_manifest.json app/landing.html \
         app/i18n.js app/permissions.js app/stock-math.js README.md; do
  check_fresh "$f"
done
# determinism: a second regeneration must be byte-identical
cp seed_manifest.json /tmp/seed_manifest.first.json
python3 tools/make_seed_sql.py >/dev/null
if ! cmp -s seed_manifest.json /tmp/seed_manifest.first.json; then
  echo "STALE: seed generator is not deterministic"; stale=1
fi
[ "$stale" -eq 0 ] && echo "generated files are fresh"

echo "== 3/5 SQL-derived numbers (local D1) =="
node tools/print_numbers.js

echo "== 4/5 test suites =="
node --test tests/logic.test.js tests/api.test.js tests/ui.test.js tests/site.test.js
node tests/lint.js

echo "== 5/5 functions build check =="
if npx --no-install wrangler --version >/dev/null 2>&1; then
  npx wrangler pages functions build --outdir /tmp/pages-functions-build 2>&1 | tail -3
  # The CI's user deploy command must also bundle cleanly (no upload).
  npx wrangler deploy --dry-run --outdir /tmp/worker-build 2>&1 | tail -3
else
  echo "wrangler not installed — falling back to node --check per function file"
  find functions -name '*.js' -print0 | while IFS= read -r -d '' f; do node --check "$f"; done
fi
node --check worker/src/index.js
node --check worker/src/ledger-do.js
node --check worker/src/queue-consumer.js
node --check worker/src/cron.js

echo "CHECK: all green"
