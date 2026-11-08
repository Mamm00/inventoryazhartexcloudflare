// tests/_harness.js — shared test harness: local D1 (better-sqlite3) with the
// real migrations + seed, a mock env (KV, audit queue, memory), mock context
// builders and a serialising Durable-Object state (blockConcurrencyWhile).

import { openLocalD1 } from './_local-d1.js';

export function memoryKV() {
  const store = new Map();
  return {
    async get(key, opts) {
      const hit = store.get(key);
      if (hit === undefined) return null;
      return opts && opts.type === 'json' ? JSON.parse(hit) : hit;
    },
    async put(key, value, opts) {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      };
    },
  };
}

export function makeEnv(db, extra = {}) {
  return {
    DB: db,
    CACHE: memoryKV(),
    AUDIT_QUEUE: {
      sent: [],
      async send(msg) { this.sent.push(msg); },
    },
    __mem: new Map(),
    ...extra,
  };
}

/** Fresh seeded DB + env (extra env props merged, e.g. TURNSTILE_SECRET). */
export function freshDb(extra = {}) {
  const db = openLocalD1();
  return { db, env: makeEnv(db, extra) };
}

export function req(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : null,
  });
}

export function ctx(env, user, request, params = {}) {
  return { env, user, request, params };
}

export const USERS = {
  admin: {
    id: 'u-admin', username: 'admin', role: 'Admin', warehouseIds: [],
    displayNameAr: 'المسؤول', displayNameEn: 'Admin', auth: 'session',
  },
  keeper1: {
    id: 'u-keeper1', username: 'keeper1', role: 'WarehouseKeeper',
    warehouseIds: ['wh-alwa', 'wh-leon', 'wh-azouz', 'wh-zibda', 'wh-showroom'],
    displayNameAr: 'مصطفى', displayNameEn: 'Mostafa', auth: 'session',
  },
  keeper2: {
    id: 'u-keeper2', username: 'keeper2', role: 'WarehouseKeeper',
    warehouseIds: ['wh-625', 'wh-magdy', 'wh-wahman', 'wh-lycra', 'wh-kashry'],
    displayNameAr: 'المسؤول الثاني', displayNameEn: 'Second keeper', auth: 'session',
  },
};

/**
 * Serialising DO state: blockConcurrencyWhile chains calls like the real
 * Durable Object does — concurrency tests then observe true serialisation.
 */
export function serialState() {
  let chain = Promise.resolve();
  return {
    blockConcurrencyWhile(fn) {
      const run = chain.then(() => fn());
      chain = run.catch(() => {});
      return run;
    },
  };
}

export function doEnv(env) {
  // The DO body uses the same env (DB + AUDIT_QUEUE).
  return env;
}
