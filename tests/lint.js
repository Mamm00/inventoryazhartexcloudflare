#!/usr/bin/env node
// tests/lint.js — static rules for the SPA shell:
//   1. no innerHTML for user data
//   2. no network call outside /api/
//   3. no alert(
//   4. every t()/tr() literal key exists in the dictionary
//   5. no String.replaceAll
//   6. no <dialog>
//   7. no external origin in the CSP

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { I18N_RAW } from '../shared/i18n.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP = path.join(ROOT, 'app');

let failures = 0;
const fail = (file, rule, line, detail) => {
  failures += 1;
  console.error(`FAIL [${rule}] ${file}:${line} — ${detail}`);
};

const jsFiles = readdirSync(APP).filter((f) => f.endsWith('.js') && f !== 'i18n.js' && f !== 'permissions.js' && f !== 'stock-math.js');
const htmlFiles = readdirSync(APP).filter((f) => f.endsWith('.html'));

for (const f of jsFiles) {
  const src = readFileSync(path.join(APP, f), 'utf-8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, ''); // ignore line comments
    if (/\.innerHTML\b/.test(code)) fail(f, 'no-innerHTML', i + 1, line.trim());
    if (/\balert\s*\(/.test(code)) fail(f, 'no-alert', i + 1, line.trim());
    if (/\.replaceAll\s*\(/.test(code)) fail(f, 'no-replaceAll', i + 1, line.trim());
    if (/<dialog\b/i.test(code)) fail(f, 'no-dialog', i + 1, line.trim());

    // network calls: fetch( and window.open( must target /api/
    const fetchCall = line.match(/fetch\s*\(\s*([^,)]+)/);
    if (fetchCall) {
      const arg = fetchCall[1].trim();
      if (arg.startsWith("'") || arg.startsWith('"') || arg.startsWith('`')) {
        if (!/^['"`]\/api\//.test(arg)) fail(f, 'api-only-network', i + 1, line.trim());
      } else if (arg === 'path') {
        // helper indirection — the same file must guard the prefix
        if (!src.includes("startsWith('/api/')")) {
          fail(f, 'api-only-network', i + 1, 'fetch(path) without an /api/ guard in this file');
        }
      } else {
        fail(f, 'api-only-network', i + 1, `unvetted fetch argument ${arg}`);
      }
    }
    const openCall = line.match(/window\.open\s*\(\s*([^,)]+)/);
    if (openCall) {
      const arg = openCall[1].trim();
      if ((arg.startsWith("'") || arg.startsWith('"') || arg.startsWith('`')) && !/^['"`]\/api\//.test(arg)) {
        fail(f, 'api-only-network', i + 1, line.trim());
      }
    }

    // t()/tr() literal keys must exist
    for (const m of line.matchAll(/\b(?:t|tr)\(\s*'([^']+)'/g)) {
      if (!I18N_RAW[m[1]]) fail(f, 'missing-i18n-key', i + 1, `key '${m[1]}'`);
    }
    for (const m of line.matchAll(/\b(?:t|tr)\(\s*"([^"]+)"/g)) {
      if (!I18N_RAW[m[1]]) fail(f, 'missing-i18n-key', i + 1, `key "${m[1]}"`);
    }
    // template-literal keys must start with a known key prefix (dynamic tail)
    for (const m of line.matchAll(/\b(?:t|tr)\(\s*`([^`]+)`/g)) {
      const prefix = m[1].split('${')[0];
      const anyKey = Object.keys(I18N_RAW).some((k) => k.startsWith(prefix));
      if (!anyKey) fail(f, 'missing-i18n-key', i + 1, `template key \`${m[1]}\``);
    }
  });
}

for (const f of htmlFiles) {
  const src = readFileSync(path.join(APP, f), 'utf-8');
  src.split('\n').forEach((line, i) => {
    if (/\.innerHTML\b/.test(line)) fail(f, 'no-innerHTML', i + 1, line.trim());
    if (/\balert\s*\(/.test(line)) fail(f, 'no-alert', i + 1, line.trim());
    if (/<dialog\b/i.test(line)) fail(f, 'no-dialog', i + 1, line.trim());
  });
}

// CSP: _headers must not allow external origins.
const headers = readFileSync(path.join(APP, '_headers'), 'utf-8');
const cspLine = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'));
if (!cspLine) {
  fail('_headers', 'csp', 0, 'no Content-Security-Policy header');
} else {
  const externals = cspLine.match(/https?:\/\/[^\s;]+/g) || [];
  if (externals.length) fail('_headers', 'csp', 0, `external origin in CSP: ${externals.join(', ')}`);
  if (!cspLine.includes("default-src 'self'")) fail('_headers', 'csp', 0, 'missing default-src self');
}

if (failures) {
  console.error(`lint: ${failures} violation(s)`);
  process.exit(1);
}
console.log(`lint: clean (${jsFiles.length} JS files, ${htmlFiles.length} HTML files, ${Object.keys(I18N_RAW).length} i18n keys)`);
