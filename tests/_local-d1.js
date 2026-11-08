// tests/_local-d1.js — a local D1-compatible adapter over better-sqlite3.
// Mirrors Cloudflare D1 semantics: prepare().bind().first()/all()/run()/raw(),
// batch(), exec(). Used by the test suites and tools/print_numbers.js so the
// same query layer (shared/server/db.js) runs unmodified in tests.

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params.map((p) => (p === undefined ? null : p));
    return this;
  }
  #run() {
    const stmt = this.db.prepare(this.sql);
    return stmt;
  }
  async first(col) {
    const stmt = this.#run();
    const row = stmt.get(...this.params);
    if (row === undefined) return null;
    if (col) return row[col] ?? null;
    return row;
  }
  async all() {
    const stmt = this.#run();
    const results = stmt.all(...this.params);
    return { results, success: true, meta: { changes: 0 } };
  }
  async run() {
    const stmt = this.#run();
    const info = stmt.run(...this.params);
    return {
      success: true,
      meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
      results: [],
    };
  }
  async raw() {
    const stmt = this.db.prepare(this.sql).raw();
    return stmt.all(...this.params);
  }
}

class LocalD1 {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    const out = [];
    const tx = this.db.transaction((stmts) => {
      for (const s of stmts) out.push(this.db.prepare(s.sql).run(...s.params));
    });
    tx(statements);
    return out.map((info) => ({ success: true, meta: { changes: info.changes }, results: [] }));
  }
  async exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
  async dump() {
    return this.db.export();
  }
}

/** Open a fresh local D1 at `file` (':memory:' allowed) and apply migrations. */
export function openLocalD1(file = ':memory:', { seed = true } = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  const d1 = new LocalD1(db);
  const migDir = path.join(ROOT, 'migrations');
  const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (!seed && f.includes('seed')) continue;
    db.exec(readFileSync(path.join(migDir, f), 'utf-8'));
  }
  return d1;
}

export { LocalD1 };
