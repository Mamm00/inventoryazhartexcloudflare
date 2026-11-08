// app/app.js — the SPA shell. Arabic-first, RTL. Rules enforced by tests/lint.js:
// no innerHTML for user data (mk() builds text nodes), no network call outside
// /api/, no alert(, no String.replaceAll, no <dialog>, every t() key exists.
// UI.* holds transient state only — server responses hydrate every screen.

import { t, nm } from './i18n.js';
import { can, viewsFor, PERMS } from './permissions.js';
import {
  closingRolls, totalMeters, totalValue, statusOf, reorderQty, utilization,
  fmtNum, fmtMeters, fmtMoney, fmtPct, formatDate, STATUS_KEYS,
} from './stock-math.js';

export const UI = {
  user: null,
  lang: 'ar',
  view: 'stock',
  openFabrics: new Set(),   // `${wh}:${fab}` — survives language flip & re-render
  openWh: new Set(),        // inventory warehouse accordion
  invMode: 'tree',
  colorsMode: 'grid',
  colorsTab: 'catalog',
  mastersTab: 'warehouses',
  reportsKind: 'byWarehouse',
  reportResult: null,
  dashboardTrend: 'week',
  state: {},                // per-view transient data cache
  lastServerSheet: null,
  pendingRow: null,
};

// ---- DOM builder (text nodes only) --------------------------------------

export function mk(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (sel) => document.querySelector(sel);
const L = () => UI.lang;

function tr(key, args) { return t(key, args, L()); }
function nameOf(obj) { return nm(obj, 'name'); }
function n(v) { return fmtNum(v, L()); }
function m(v) { return fmtMeters(v, L()); }
function money(v) { return fmtMoney(v, L()); }
function pct(v) { return fmtPct(v, L()); }
function dateS(v) { return v ? formatDate(String(v).slice(0, 10), L()) : '—'; }

// ---- API -----------------------------------------------------------------

async function apiGet(path) {
  if (!path.startsWith('/api/')) throw new Error('api: /api/ paths only');
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || tr('toast.forbidden'));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || tr('app.error'));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

export const api = {
  get: apiGet,
  /** commit() successor: idempotency key, awaits the DO, never optimistic. */
  async mutate(path, body) {
    if (!path.startsWith('/api/')) throw new Error('api: /api/ paths only');
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  },
  async patch(path, body) {
    if (!path.startsWith('/api/')) throw new Error('api: /api/ paths only');
    const res = await fetch(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  },
};

// ---- toast ---------------------------------------------------------------

export function toast(message, kind = '') {
  const area = $('#toast-area');
  if (!area) return;
  const el = mk('div', { class: `toast ${kind}` }, message);
  area.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

function errorBanner(message) {
  return mk('div', { class: 'card', id: 'error-banner', style: { borderColor: '#b02a2a' } },
    mk('strong', { text: tr('app.error') }), ' — ', message,
    ' ', mk('button', { class: 'btn secondary', onclick: () => render() }, tr('app.retry')));
}

// ---- shell ---------------------------------------------------------------

function renderShell() {
  $('#splash').hidden = true;
  $('#shell').hidden = false;
  const nav = $('#nav');
  nav.textContent = '';
  for (const view of viewsFor(UI.user)) {
    nav.appendChild(mk('a', {
      href: `#/${view}`,
      'data-view': view,
      class: UI.view === view ? 'active' : '',
      text: tr(`nav.${view}`),
    }));
  }
  const box = $('#user-box');
  box.textContent = '';
  const displayName = L() === 'ar'
    ? (UI.user.displayNameAr || UI.user.username)
    : (UI.user.displayNameEn || UI.user.username);
  box.appendChild(mk('div', { class: 'who' }, `${tr('app.signedInAs')}: ${displayName} · ${UI.user.role}`));
  const langRow = mk('div', { class: 'lang-row' });
  langRow.appendChild(mk('button', { onclick: () => setLang('ar'), text: 'العربية' }));
  langRow.appendChild(mk('button', { onclick: () => setLang('en'), text: 'English' }));
  box.appendChild(langRow);
  box.appendChild(mk('button', { onclick: doLogout, text: tr('app.logout') }));
}

export function setLang(lang) {
  UI.lang = lang;
  try { localStorage.setItem('frs_lang', lang); } catch { /* transient preference only */ }
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  return render();
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  UI.user = null;
  renderLogin();
}

// ---- login ---------------------------------------------------------------

function renderLogin() {
  $('#splash').hidden = true;
  $('#shell').hidden = false;
  const main = $('#main');
  main.textContent = '';
  $('#nav').textContent = '';
  const box = $('#user-box');
  box.textContent = '';
  const langRow = mk('div', { class: 'lang-row' });
  langRow.appendChild(mk('button', { onclick: () => setLang('ar'), text: 'العربية' }));
  langRow.appendChild(mk('button', { onclick: () => setLang('en'), text: 'English' }));
  box.appendChild(langRow);

  const wrap = mk('div', { class: 'login-wrap' });
  wrap.appendChild(mk('h1', { text: tr('login.title') }));
  const card = mk('div', { class: 'card' });
  const form = mk('form', {
    class: 'grid',
    onsubmit: (ev) => {
      ev.preventDefault();
      submitLogin(form);
    },
  });
  const userField = mk('label', { class: 'field' }, tr('login.username'),
    mk('input', { name: 'username', autocomplete: 'username', required: true }));
  const passField = mk('label', { class: 'field' }, tr('login.password'),
    mk('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }));
  form.appendChild(userField);
  form.appendChild(passField);
  form.appendChild(mk('div', {}, mk('button', { class: 'btn', type: 'submit', text: tr('login.submit') })));
  card.appendChild(form);
  const demo = mk('div', { class: 'login-demo' });
  demo.appendChild(mk('div', { text: tr('login.demo') }));
  const tbl = mk('table', { class: 'data' });
  tbl.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('login.username') }), mk('th', { text: tr('login.password') }),
    mk('th', { text: tr('app.role') }), mk('th', { text: tr('prof.scope') }))));
  const tb = mk('tbody');
  for (const row of DEMO_SIGN_INS) {
    tb.appendChild(mk('tr', {},
      mk('td', { dir: 'ltr', text: row.username }), mk('td', { dir: 'ltr', text: row.password }),
      mk('td', { text: L() === 'ar' ? row.who_ar : row.who_en }),
      mk('td', { text: L() === 'ar' ? row.scope_ar : row.scope_en })));
  }
  tbl.appendChild(tb);
  demo.appendChild(tbl);
  card.appendChild(demo);
  wrap.appendChild(card);
  main.appendChild(wrap);
}

const DEMO_SIGN_INS = [
  { username: 'admin', password: 'admin123', who_en: 'Admin', who_ar: 'مسؤول', scope_en: 'All ten sheds', scope_ar: 'كل المخازن العشرة' },
  { username: 'keeper1', password: 'mostafa123', who_en: 'Mostafa · Warehouse Keeper', who_ar: 'مصطفى · أمين مخزن', scope_en: 'His five sheds', scope_ar: 'مخازنه الخمسة' },
  { username: 'keeper2', password: 'keeper2123', who_en: 'Second keeper · Warehouse Keeper', who_ar: 'الأمين الثاني · أمين مخزن', scope_en: 'The other five sheds', scope_ar: 'المخازن الخمسة الأخرى' },
];

async function submitLogin(form) {
  const fd = new FormData(form);
  const res = await api.mutate('/api/auth/login', {
    username: fd.get('username'), password: fd.get('password'),
    turnstileToken: (typeof window !== 'undefined' && window.turnstileToken) || 'demo-token',
  });
  if (!res.ok) {
    const key = res.status === 429 ? 'login.locked'
      : res.status === 403 && res.data.error === 'TURNSTILE' ? 'login.turnstile' : 'login.failed';
    toast(tr(key), 'error');
    return;
  }
  UI.user = res.data.user;
  await route();
}

// ---- router --------------------------------------------------------------

const VIEWS = {
  readme: renderReadme, stock: renderStock, inventory: renderInventory,
  movements: renderMovements, colors: renderColors, cross: renderCross,
  dashboard: renderDashboard, reports: renderReports, masters: renderMasters,
  audit: renderAudit, settings: renderSettings, profile: renderProfile,
};

export function currentRoute() {
  const raw = (window.location.hash || '#/stock').replace(/^#\/?/, '');
  return raw.split('?')[0] || 'stock';
}

export async function route() {
  const view = currentRoute();
  UI.view = VIEWS[view] ? view : 'stock';
  renderShell();
  await render();
}

export async function render() {
  const main = $('#main');
  if (!main) return;
  main.textContent = '';
  if (!UI.user) { renderLogin(); return; }
  renderShell();
  let view = UI.view;
  // A keeper never sees Settings; #/settings lands them on read-only My Profile.
  if (view === 'settings' && !can(UI.user, 'settings.write', null)) view = 'profile';
  try {
    await VIEWS[view](main);
  } catch (err) {
    main.appendChild(errorBanner(err && err.message ? err.message : tr('app.error')));
  }
}

// ---- 1. Guide (#readme) --------------------------------------------------

async function renderReadme(main) {
  const data = await api.get('/api/readme');
  const wrap = mk('div', { class: 'readme' });
  wrap.appendChild(mk('h1', { text: tr('rd.title') }));

  const meta = mk('div', { class: 'card' });
  meta.appendChild(mk('div', {}, `${tr('rd.version')}: `, mk('strong', { text: data.version })));
  meta.appendChild(mk('div', {}, `${tr('rd.storage')}: `, mk('strong', { text: tr('rd.storageValue') })));
  meta.appendChild(mk('div', {}, `${tr('rd.records')}: `, mk('strong', { text: n(data.recordCount) })));
  meta.appendChild(mk('p', { class: 'sub', text: tr('rd.securityBody') }));
  wrap.appendChild(meta);

  const steps = data.steps || [];
  wrap.appendChild(mk('h2', {}, `${tr('rd.howto')} (${steps.length})`));
  const stepList = mk('ol');
  for (const key of steps) stepList.appendChild(mk('li', { text: tr(key) }));
  wrap.appendChild(stepList);

  wrap.appendChild(mk('h2', { text: tr('rd.legend') }));
  const legend = mk('div', { class: 'card' });
  legend.appendChild(mk('div', {}, mk('span', { class: 'chip green', text: '●' }), ' ', tr('rd.legendGreen')));
  legend.appendChild(mk('div', {}, mk('span', { class: 'chip amber', text: '●' }), ' ', tr('rd.legendAmber')));
  legend.appendChild(mk('div', {}, mk('span', { class: 'chip red', text: '●' }), ' ', tr('rd.legendRed')));
  wrap.appendChild(legend);

  wrap.appendChild(mk('h2', { text: tr('rd.roleMatrix') }));
  const matrix = mk('table', { class: 'data' });
  matrix.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('rd.roleAction') }),
    ...data.roleMatrix.roles.map((r) => mk('th', { text: r })))));
  const mb = mk('tbody');
  for (const action of data.roleMatrix.actions) {
    const tr1 = mk('tr', {}, mk('td', { text: action }));
    for (const role of data.roleMatrix.roles) {
      const allowed = (data.roleMatrix.perms[action] || []).includes(role);
      tr1.appendChild(mk('td', { text: allowed ? tr('app.yes') : role === 'Admin' ? tr('app.yes') : tr('app.no') }));
    }
    mb.appendChild(tr1);
  }
  matrix.appendChild(mb);
  wrap.appendChild(matrix);

  wrap.appendChild(mk('h2', { text: tr('rd.formula') }));
  const fml = mk('table', { class: 'data' });
  const fb = mk('tbody');
  for (const key of ['fml.closing', 'fml.meters', 'fml.value', 'fml.status', 'fml.reorder', 'fml.util', 'fml.getStock']) {
    fb.appendChild(mk('tr', {}, mk('td', { class: 'formula-code', text: tr(key) })));
  }
  fml.appendChild(fb);
  wrap.appendChild(fml);

  wrap.appendChild(mk('h2', { text: tr('rd.dataModel') }));
  const dm = mk('table', { class: 'data' });
  const db = mk('tbody');
  for (const key of ['dm.warehouses', 'dm.fabrics', 'dm.colors', 'dm.mappings', 'dm.stock_events', 'dm.stock_current', 'dm.keeper_color_codes', 'dm.audit_log']) {
    db.appendChild(mk('tr', {}, mk('td', { text: tr(key) })));
  }
  dm.appendChild(db);
  wrap.appendChild(dm);

  wrap.appendChild(mk('h2', { text: tr('rd.deploy') }));
  const deployList = mk('ol');
  for (const step of DEPLOY_STEPS) deployList.appendChild(mk('li', { class: 'formula-code', text: step }));
  wrap.appendChild(deployList);

  wrap.appendChild(mk('h2', { text: tr('rd.troubleshoot') }));
  const trouble = mk('ul');
  for (const item of TROUBLE) trouble.appendChild(mk('li', { text: item }));
  wrap.appendChild(trouble);

  wrap.appendChild(mk('h2', { text: tr('rd.changelog') }));
  const changelog = mk('ul');
  for (const item of CHANGELOG) changelog.appendChild(mk('li', { text: item }));
  wrap.appendChild(changelog);

  wrap.appendChild(mk('h2', { text: tr('rd.shedMap') }));
  const map = mk('table', { class: 'data' });
  map.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('tbl.shed') }), mk('th', { text: tr('app.fabric') }),
    mk('th', { text: tr('app.rolls') }), mk('th', { text: tr('app.meters') }),
    mk('th', { text: tr('app.value') }), mk('th', { text: tr('tbl.util') }))));
  const mapBody = mk('tbody');
  for (const s of data.shedMap) {
    mapBody.appendChild(mk('tr', {},
      mk('td', { text: nameOf(s) }), mk('td', { text: n(s.fabric_types) }),
      mk('td', { text: n(s.rolls) }), mk('td', { text: m(s.meters) }),
      mk('td', { text: money(s.value) }), mk('td', { text: pct(s.utilization_pct) })));
  }
  map.appendChild(mapBody);
  wrap.appendChild(map);
  wrap.appendChild(mk('p', {}, `${data.scopeIsAll ? tr('app.total') : tr('tbl.myTotal')}: `,
    mk('strong', { text: n(data.shedMapTotal) }), ` ${tr('app.rolls')}`));
  main.appendChild(wrap);
}

const DEPLOY_STEPS = [
  'wrangler d1 create fabric-roll-stock && wrangler d1 migrations apply fabric-roll-stock --remote',
  'cd worker && wrangler deploy',
  'Connect the repo in Cloudflare Pages (build: npm run build, output: app)',
  'Bind DB / CACHE / EXPORTS / AUDIT_QUEUE / ANALYTICS / WAREHOUSE_LEDGER in Settings → Bindings',
];
const TROUBLE = [
  '403 on every route: session expired — sign in again; Access JWT must be configured for SSO.',
  'NEGATIVE_STOCK 409: the movement would drive closing below zero; the message names the shortfall.',
  'UNMAPPED 422: create an active mapping row for that (warehouse, fabric, colour) first.',
  'Pages build fails: run npm run build locally — migrations/0002_seed.sql must not be stale.',
];
const CHANGELOG = [
  'v1.2.0 — Cloudflare Pages rewrite: D1 + Durable Objects, server-side RBAC, twelve screens.',
  'v1.1.0 — keeper colour codes, Cross-View, diagnostics.',
  'v1.0.0 — initial roll stock model: Warehouse → Fabric → Colour → Roll.',
];

// ---- 2. Stock Overview (#stock) -----------------------------------------

async function renderStock(main) {
  const data = await api.get('/api/stock');
  main.appendChild(mk('h1', { text: tr('stock.title') }));
  main.appendChild(mk('p', {
    class: 'sub',
    text: tr('stock.headerTotal', { n: data.totals.shed_count }),
  }));
  const totals = mk('div', { class: 'stat-row' });
  totals.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: n(data.totals.rolls) }), mk('div', { class: 'l', text: tr('app.rolls') })));
  totals.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: m(data.totals.meters) }), mk('div', { class: 'l', text: tr('app.meters') })));
  totals.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: money(data.totals.value) }), mk('div', { class: 'l', text: tr('app.value') })));
  totals.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: n(data.totals.low_stock) }), mk('div', { class: 'l', text: tr('stock.lowStock') })));
  totals.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: n(data.totals.fabric_types) }), mk('div', { class: 'l', text: tr('stock.fabricTypes') })));
  main.appendChild(totals);

  const toolbar = mk('div', { class: 'toolbar' });
  toolbar.appendChild(mk('button', {
    class: 'btn secondary', text: tr('app.print'),
    onclick: () => openServerSheet(`/api/reports?kind=byWarehouse&format=print&lang=${L()}`),
  }));
  toolbar.appendChild(mk('button', {
    class: 'btn secondary', text: tr('csv.download'),
    onclick: () => openServerSheet('/api/reports?kind=byWarehouse&format=csv'),
  }));
  main.appendChild(toolbar);

  const grid = mk('div', { class: 'cards-grid' });
  for (const shed of data.sheds) {
    grid.appendChild(await shedCard(shed));
  }
  main.appendChild(grid);
}

async function shedCard(s, readOnly = false) {
  const card = mk('div', { class: 'card shed-card' });
  const head = mk('div', { class: 'shed-head' });
  head.appendChild(mk('div', {},
    mk('div', { class: 'shed-name', text: nameOf(s) }),
    mk('div', { class: 'keeper', text: `${tr('mas.keeper')}: ${s.keeper_user_id}` })));
  head.appendChild(mk('span', {
    class: `chip ${s.utilization_band}`,
    text: `${tr('stock.utilization')} ${pct(s.utilization_pct)}`,
  }));
  card.appendChild(head);

  const stats = mk('div', { class: 'stat-row' });
  stats.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: n(s.fabric_types) }), mk('div', { class: 'l', text: tr('stock.fabricTypes') })));
  stats.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: n(s.colors) }), mk('div', { class: 'l', text: tr('stock.colors') })));
  stats.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: n(s.rolls) }), mk('div', { class: 'l', text: tr('stock.rolls') })));
  stats.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: m(s.meters) }), mk('div', { class: 'l', text: tr('stock.meters') })));
  stats.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: money(s.value) }), mk('div', { class: 'l', text: tr('stock.value') })));
  stats.appendChild(mk('div', { class: 'stat' }, mk('div', { class: 'v', text: n(s.low_stock) }), mk('div', { class: 'l', text: tr('stock.lowStock') })));
  card.appendChild(stats);

  const util = utilization(s.rolls, s.capacity_rolls);
  const gauge = mk('div', { class: 'gauge' }, mk('i', {
    class: `g-${util.band}`,
    style: { width: `${Math.min(100, util.pct)}%` },
  }));
  card.appendChild(gauge);
  card.appendChild(mk('div', { class: 'util-line' },
    mk('span', {}, `${tr('stock.capacity')}: ${n(s.capacity_rolls)}`),
    mk('span', { text: util.pct > 100 ? tr('stock.overcapacity') : pct(util.pct) })));
  card.appendChild(mk('div', { class: 'util-line' },
    mk('span', {}, `${tr('stock.lastActivity')}: ${dateS(s.last_activity)}`)));

  const expandKey = `stock:${s.id}`;
  const expander = mk('button', {
    class: 'linkish',
    text: UI.openFabrics.has(expandKey) ? tr('stock.collapse') : tr('stock.expand'),
    onclick: async () => {
      if (UI.openFabrics.has(expandKey)) UI.openFabrics.delete(expandKey);
      else UI.openFabrics.add(expandKey);
      await render();
    },
  });
  card.appendChild(expander);

  if (UI.openFabrics.has(expandKey)) {
    const holder = mk('div', { style: { marginTop: '.55rem' } });
    const inv = await api.get(`/api/inventory?wh=${encodeURIComponent(s.id)}`);
    for (const fsum of inv.tree[0] ? inv.tree[0].fabrics : []) {
      holder.appendChild(mk('div', { class: 'bar-row' },
        mk('span', { class: 'bar-label', text: nameOf(fsum) }),
        mk('span', { class: 'bar-track' }, mk('i', {
          class: 'bar-fill',
          style: { width: `${Math.min(100, fsum.rolls / Math.max(1, s.rolls) * 100)}%` },
        })),
        mk('span', { class: 'bar-val', text: n(fsum.rolls) })));
      // colour strips for this fabric
      const strip = mk('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px', margin: '2px 0 8px' } });
      for (const row of inv.rows.filter((r) => r.fabric_id === fsum.fabric_id).slice(0, 24)) {
        strip.appendChild(mk('span', {
          class: 'swatch',
          title: `${nameOf({ name_ar: row.col_name_ar, name_en: row.col_name_en })} · ${n(row.closing_rolls)}`,
          style: { background: row.hex || '#ccc', width: '18px', height: '18px' },
        }));
      }
      holder.appendChild(strip);
    }
    card.appendChild(holder);
    if (readOnly) {
      card.appendChild(mk('div', { class: 'sub', text: tr('app.readOnly') }));
    }
  }
  return card;
}

// ---- 3. Inventory (#inventory) ------------------------------------------

async function renderInventory(main) {
  main.appendChild(mk('h1', { text: tr('inv.title') }));
  const toolbar = mk('div', { class: 'toolbar' });
  const treeBtn = mk('button', {
    class: UI.invMode === 'tree' ? 'btn' : 'btn secondary',
    text: tr('inv.tree'),
    onclick: () => { UI.invMode = 'tree'; render(); },
  });
  const flatBtn = mk('button', {
    class: UI.invMode === 'flat' ? 'btn' : 'btn secondary',
    text: tr('inv.flat'),
    onclick: () => { UI.invMode = 'flat'; render(); },
  });
  toolbar.appendChild(treeBtn);
  toolbar.appendChild(flatBtn);
  main.appendChild(toolbar);

  const data = await api.get('/api/inventory');
  if (UI.invMode === 'flat') {
    const allRows = [];
    for (const node of data.tree) {
      const inv = await api.get(`/api/inventory?wh=${encodeURIComponent(node.warehouse.id)}`);
      for (const r of inv.rows) allRows.push(r);
    }
    main.appendChild(rowsTable(allRows, true));
    return;
  }

  const acc = mk('div', { class: 'accordion' });
  for (const node of data.tree) {
    const wh = node.warehouse;
    const whOpen = UI.openWh.has(wh.id);
    acc.appendChild(mk('div', {
      class: 'fab-head',
      onclick: () => {
        if (whOpen) UI.openWh.delete(wh.id);
        else UI.openWh.add(wh.id);
        render();
      },
    },
      mk('span', { class: 'caret', text: whOpen ? '▾' : '◂' }),
      mk('strong', { text: nameOf(wh) }),
      mk('span', { class: 'chip', text: tr('colors.count', { n: node.fabrics.length }) })));

    if (whOpen) {
      const whBody = mk('div', { class: 'fab-body' });
      for (const fsum of node.fabrics) {
        const key = `${wh.id}:${fsum.fabric_id}`;
        const open = UI.openFabrics.has(key);
        whBody.appendChild(mk('div', {
          class: 'fab-head',
          onclick: (ev) => {
            ev.stopPropagation();
            if (open) UI.openFabrics.delete(key);
            else UI.openFabrics.add(key);
            render();
          },
        },
          mk('span', { class: 'caret', text: open ? '▾' : '◂' }),
          mk('span', { text: nameOf(fsum) }),
          mk('span', { class: 'chip', text: `${n(fsum.rolls)} ${tr('app.rolls')}` }),
          fsum.low > 0 ? mk('span', { class: 'chip amber', text: `${tr('status.low')} ${n(fsum.low)}` }) : null));
        if (open) {
          const inv = await api.get(`/api/inventory?wh=${encodeURIComponent(wh.id)}&fab=${encodeURIComponent(fsum.fabric_id)}`);
          whBody.appendChild(inv.rows.length
            ? rowsTable(inv.rows, false)
            : mk('p', { class: 'sub', text: tr('inv.noRows') }));
          whBody.appendChild(rowForm(wh.id, fsum.fabric_id, inv.rows));
        }
      }
      if (!node.fabrics.length) whBody.appendChild(mk('p', { class: 'sub', text: tr('inv.emptyShed') }));
      acc.appendChild(whBody);
    }
  }
  main.appendChild(acc);
}

function rowsTable(rows, withWh) {
  const table = mk('table', { class: 'data' });
  const head = mk('tr', {},
    mk('th', { text: tr('inv.color') }),
    withWh ? mk('th', { text: tr('inv.warehouse') }) : null,
    withWh ? mk('th', { text: tr('inv.fabric') }) : null,
    mk('th', { text: tr('inv.opening') }), mk('th', { text: tr('inv.in') }),
    mk('th', { text: tr('inv.out') }), mk('th', { text: tr('inv.closing') }),
    mk('th', { text: tr('app.meters') }), mk('th', { text: tr('app.value') }),
    mk('th', { text: tr('app.status') }), mk('th', { text: tr('inv.reorder') }));
  table.appendChild(mk('thead', {}, head));
  const tb = mk('tbody');
  for (const r of rows) {
    const tr1 = mk('tr', {
      class: `${r.status === 'low' ? 'low' : r.status === 'out' ? 'out' : ''} ${r.mapping_active ? '' : 'inactive'}`.trim(),
    },
      mk('td', {}, mk('span', { class: 'swatch', style: { background: r.hex || '#ccc' } }),
        nameOf({ name_ar: r.col_name_ar, name_en: r.col_name_en }),
        r.mapping_active ? null : ' ', r.mapping_active ? null : mk('span', { class: 'badge-warn', text: tr('status.invalid') })),
      withWh ? mk('td', { text: r.warehouse_id }) : null,
      withWh ? mk('td', { text: nameOf({ name_ar: r.fab_name_ar, name_en: r.fab_name_en }) }) : null,
      mk('td', { text: n(r.opening_rolls) }), mk('td', { text: n(r.rolls_in) }),
      mk('td', { text: n(r.rolls_out) }), mk('td', {}, mk('strong', { text: n(r.closing_rolls) })),
      mk('td', { text: m(r.meters) }), mk('td', { text: money(r.value) }),
      mk('td', {}, mk('span', { class: `chip ${r.status === 'low' ? 'amber' : r.status === 'out' ? 'red' : 'green'}`, text: tr(r.status_key) })),
      mk('td', { text: r.reorder > 0 ? n(r.reorder) : '' }));
    tb.appendChild(tr1);
  }
  table.appendChild(tb);
  return table;
}

function rowForm(whId, fabId, rows) {
  const wrap = mk('div', { class: 'card', style: { marginTop: '.55rem' } });
  wrap.appendChild(mk('h3', { text: tr('inv.addRow') }));
  const form = mk('form', {
    class: 'grid',
    onsubmit: async (ev) => {
      ev.preventDefault();
      await saveRowForm(form, whId, fabId, rows);
    },
  });
  const colorSel = mk('select', { name: 'colorId' });
  for (const r of rows) {
    colorSel.appendChild(mk('option', {
      value: r.color_id,
      text: nameOf({ name_ar: r.col_name_ar, name_en: r.col_name_en }),
    }));
  }
  form.appendChild(mk('label', { class: 'field' }, tr('inv.color'), colorSel));
  form.appendChild(mk('label', { class: 'field' }, tr('inv.in'), mk('input', { name: 'rollsIn', type: 'number', min: '0', step: '1', value: '0' })));
  form.appendChild(mk('label', { class: 'field' }, tr('inv.out'), mk('input', { name: 'rollsOut', type: 'number', min: '0', step: '1', value: '0' })));
  form.appendChild(mk('label', { class: 'field' }, tr('inv.min'), mk('input', { name: 'minRolls', type: 'number', min: '0', step: '1', value: '0' })));
  form.appendChild(mk('label', { class: 'field' }, tr('inv.max'), mk('input', { name: 'maxRolls', type: 'number', min: '0', step: '1', value: '0' })));
  form.appendChild(mk('div', {}, mk('button', { class: 'btn', type: 'submit', text: tr('app.save') })));

  const preview = mk('div', { class: 'preview-box' });
  const updatePreview = () => {
    const fd = new FormData(form);
    const row = rows.find((r) => r.color_id === fd.get('colorId')) || rows[0];
    if (!row) { preview.textContent = tr('inv.noRows'); return; }
    const closing = closingRolls(row.closing_rolls, Number(fd.get('rollsIn') || 0), -Number(fd.get('rollsOut') || 0));
    const meters = totalMeters(closing, row.meters_per_roll || 0);
    const value = totalValue(closing, row.unit_cost_per_roll || 0);
    const st = statusOf(closing, Number(fd.get('minRolls') || 0), Number(fd.get('maxRolls') || 0));
    preview.textContent = '';
    preview.appendChild(mk('strong', { text: tr('inv.preview') }));
    preview.appendChild(mk('div', {}, `${tr('inv.closing')}: ${n(closing)}`));
    preview.appendChild(mk('div', {}, `${tr('app.meters')}: ${m(meters)}`));
    preview.appendChild(mk('div', {}, `${tr('app.value')}: ${money(value)}`));
    preview.appendChild(mk('div', {}, `${tr('app.status')}: ${tr(STATUS_KEYS[st])}`));
    if (!row.mapping_active) preview.appendChild(mk('div', { class: 'badge-warn', text: tr('inv.invalidCombo') }));
  };
  form.addEventListener('input', updatePreview);
  form.addEventListener('change', updatePreview);
  wrap.appendChild(form);
  wrap.appendChild(preview);
  updatePreview();
  return wrap;
}

async function saveRowForm(form, whId, fabId, rows) {
  const fd = new FormData(form);
  const inN = Number(fd.get('rollsIn') || 0);
  const outN = Number(fd.get('rollsOut') || 0);
  const delta = inN - outN;
  const mapping = rows.find((r) => r.color_id === fd.get('colorId'));
  if (mapping) {
    const patch = await api.patch('/api/masters/mapping', {
      id: mapping.mapping_id || undefined,
      warehouse_id: whId, fabric_id: fabId, color_id: mapping.color_id,
      min_rolls: Number(fd.get('minRolls') || 0), max_rolls: Number(fd.get('maxRolls') || 0),
      lead_time_days: mapping.lead_time_days || 0, active: true,
    });
    if (!patch.ok) toast(patch.data.message || tr('toast.forbidden'), 'error');
  }
  if (delta !== 0 && mapping) {
    const res = await api.mutate('/api/movements', {
      kind: 'adjustment', warehouseId: whId, fabricId: fabId, colorId: mapping.colorId,
      rolls: delta, note: tr('inv.addRow'),
    });
    if (!res.ok) {
      if (res.status === 409) {
        toast(tr('toast.negativeStock', {
          after: res.data.after ?? '?', shortfall: res.data.shortfall ?? '?',
        }), 'error');
      } else if (res.status === 403) {
        toast(tr('toast.forbidden'), 'error');
      } else {
        toast(res.data.message || tr('toast.network'), 'error');
      }
      return;
    }
    toast(tr('app.saved'), 'ok');
    await render();
  }
}

// ---- 4. Movements (#movements) ------------------------------------------

async function renderMovements(main) {
  main.appendChild(mk('h1', { text: tr('mv.title') }));
  const data = await api.get('/api/movements');
  const inv = await api.get('/api/inventory');
  const allWh = await api.get('/api/masters/warehouses');

  const card = mk('div', { class: 'card' });
  const form = mk('form', {
    class: 'grid',
    onsubmit: async (ev) => {
      ev.preventDefault();
      await submitMovement(form);
    },
  });
  const kindSel = mk('select', { name: 'kind', onchange: () => toggleMovementFields(form) });
  for (const k of ['in', 'out', 'transfer', 'adjustment']) {
    kindSel.appendChild(mk('option', { value: k, text: tr(`mv.${k}`) }));
  }
  form.appendChild(mk('label', { class: 'field' }, tr('mv.kind'), kindSel));

  const whSel = mk('select', { name: 'warehouseId', onchange: () => refreshCombo(form, inv) });
  for (const node of inv.tree) {
    whSel.appendChild(mk('option', { value: node.warehouse.id, text: nameOf(node.warehouse) }));
  }
  form.appendChild(mk('label', { class: 'field' }, tr('mv.from'), whSel));

  // Destination list is deliberately unscoped.
  const toSel = mk('select', { name: 'toWarehouseId', class: 'js-to' });
  for (const w of allWh.rows) {
    toSel.appendChild(mk('option', { value: w.id, text: nameOf(w) }));
  }
  const toField = mk('label', { class: 'field js-to-field hidden' }, tr('mv.to'), toSel);
  form.appendChild(toField);

  const fabSel = mk('select', { name: 'fabricId', onchange: () => refreshColors(form, inv) });
  form.appendChild(mk('label', { class: 'field' }, tr('mv.fabric'), fabSel));
  const colorSel = mk('select', { name: 'colorId' });
  form.appendChild(mk('label', { class: 'field' }, tr('mv.color'), colorSel));
  refreshCombo(form, inv);

  form.appendChild(mk('label', { class: 'field' }, tr('mv.rolls'), mk('input', { name: 'rolls', type: 'number', step: '1', required: true })));
  form.appendChild(mk('label', { class: 'field' }, tr('mv.note'), mk('input', { name: 'note' })));
  form.appendChild(mk('label', { class: 'field' }, tr('app.date'), mk('input', { name: 'effectiveDate', type: 'date' })));
  form.appendChild(mk('div', {}, mk('button', { class: 'btn', type: 'submit', text: tr('mv.submit') })));
  card.appendChild(form);
  main.appendChild(card);
  toggleMovementFields(form);

  main.appendChild(mk('h2', { text: tr('mv.recent') }));
  const table = mk('table', { class: 'data' });
  table.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('app.date') }), mk('th', { text: tr('mv.kind') }),
    mk('th', { text: tr('app.warehouse') }), mk('th', { text: tr('app.fabric') }),
    mk('th', { text: tr('app.color') }), mk('th', { text: tr('mv.delta') }),
    mk('th', { text: tr('mv.actor') }), mk('th', { text: tr('mv.ref') }))));
  const tb = mk('tbody');
  for (const e of data.events) {
    tb.appendChild(mk('tr', {},
      mk('td', { text: dateS(e.effective_date) }),
      mk('td', { text: tr(`mv.${e.kind.startsWith('transfer') ? 'transfer' : e.kind}`) }),
      mk('td', { text: nameOf({ name_ar: e.wh_name_ar, name_en: e.wh_name_en }) }),
      mk('td', { text: nameOf({ name_ar: e.fab_name_ar, name_en: e.fab_name_en }) }),
      mk('td', {}, mk('span', { class: 'swatch', style: { background: e.hex || '#ccc' } }),
        nameOf({ name_ar: e.col_name_ar, name_en: e.col_name_en })),
      mk('td', { text: `${e.rolls_delta > 0 ? '+' : ''}${n(e.rolls_delta)}` }),
      mk('td', { text: e.actor_username || '—' }),
      mk('td', { class: 'formula-code', text: e.ref_id || '—' })));
  }
  table.appendChild(tb);
  main.appendChild(table);
}

function toggleMovementFields(form) {
  const kind = form.elements.kind.value;
  const toField = form.querySelector('.js-to-field');
  if (toField) toField.classList.toggle('hidden', kind !== 'transfer');
}

function refreshCombo(form, inv) {
  const whId = form.elements.warehouseId.value;
  const node = inv.tree.find((x) => x.warehouse.id === whId) || inv.tree[0];
  const fabSel = form.elements.fabricId;
  fabSel.textContent = '';
  for (const f of (node ? node.fabrics : [])) {
    fabSel.appendChild(mk('option', { value: f.fabric_id, text: nameOf(f) }));
  }
  refreshColors(form, inv);
}

async function refreshColors(form, inv) {
  const whId = form.elements.warehouseId.value;
  const fabId = form.elements.fabricId.value;
  const colorSel = form.elements.colorId;
  colorSel.textContent = '';
  try {
    const rows = await api.get(`/api/inventory?wh=${encodeURIComponent(whId)}&fab=${encodeURIComponent(fabId)}`);
    for (const r of rows.rows) {
      colorSel.appendChild(mk('option', {
        value: r.color_id,
        text: nameOf({ name_ar: r.col_name_ar, name_en: r.col_name_en }),
      }));
    }
  } catch { /* keep empty */ }
}

async function submitMovement(form) {
  const fd = new FormData(form);
  const kind = fd.get('kind');
  const body = {
    kind,
    warehouseId: fd.get('warehouseId'),
    fabricId: fd.get('fabricId'),
    colorId: fd.get('colorId'),
    rolls: Number(fd.get('rolls')),
    note: fd.get('note') || null,
    effectiveDate: fd.get('effectiveDate') || undefined,
    toWarehouseId: fd.get('toWarehouseId'),
    fromWarehouseId: fd.get('warehouseId'),
  };
  const res = await api.mutate('/api/movements', body);
  if (!res.ok) {
    if (res.status === 409 && res.data.error === 'NEGATIVE_STOCK') {
      toast(tr('toast.negativeStock', {
        after: res.data.after ?? '?', shortfall: res.data.shortfall ?? '?',
      }), 'error');
    } else if (res.status === 403) {
      toast(tr('toast.forbidden'), 'error');
    } else if (res.data.error === 'UNMAPPED') {
      toast(tr('mv.unmapped'), 'error');
    } else {
      toast(res.data.message || tr('toast.network'), 'error');
    }
    return;
  }
  toast(tr('mv.created'), 'ok');
  await render();
}

// ---- 5. Colors Catalog (#colors) ----------------------------------------

async function renderColors(main) {
  main.appendChild(mk('h1', { text: tr('colors.title') }));
  const data = await api.get('/api/colors');

  const tabs = mk('div', { class: 'tabs' });
  tabs.appendChild(mk('button', {
    class: UI.colorsTab === 'catalog' ? 'active' : '',
    text: tr('mas.colors'),
    onclick: () => { UI.colorsTab = 'catalog'; render(); },
  }));
  tabs.appendChild(mk('button', {
    class: UI.colorsTab === 'codes' ? 'active' : '',
    text: tr('colors.codes'),
    onclick: () => { UI.colorsTab = 'codes'; render(); },
  }));
  main.appendChild(tabs);

  if (UI.colorsTab === 'codes') {
    const table = mk('table', { class: 'data' });
    table.appendChild(mk('thead', {}, mk('tr', {},
      mk('th', { text: tr('app.color') }), mk('th', { text: tr('colors.customCode') }),
      mk('th', { text: tr('colors.customName') }), mk('th', { text: tr('app.notes') }),
      mk('th', { text: tr('app.updated') }))));
    const tb = mk('tbody');
    for (const c of data.codes) {
      tb.appendChild(mk('tr', {},
        mk('td', {}, mk('span', { class: 'swatch', style: { background: c.hex || '#ccc' } }),
          nameOf({ name_ar: c.col_name_ar, name_en: c.col_name_en })),
        mk('td', { class: 'formula-code', text: c.custom_code || '' }),
        mk('td', { text: c.custom_name || '' }),
        mk('td', { text: c.notes || '' }),
        mk('td', { text: dateS(c.last_updated) })));
    }
    table.appendChild(tb);
    main.appendChild(table);
    main.appendChild(codeForm(data.colors));
    return;
  }

  const toolbar = mk('div', { class: 'toolbar' });
  toolbar.appendChild(mk('button', {
    class: UI.colorsMode === 'grid' ? 'btn secondary' : 'btn secondary',
    text: tr('colors.grid'),
    onclick: () => { UI.colorsMode = 'grid'; render(); },
  }));
  toolbar.appendChild(mk('button', {
    class: 'btn secondary', text: tr('colors.table'),
    onclick: () => { UI.colorsMode = 'table'; render(); },
  }));
  const familySel = mk('select', {
    onchange: (ev) => { UI.state.colorFamily = ev.target.value; render(); },
  });
  familySel.appendChild(mk('option', { value: '', text: tr('app.all') }));
  const families = [...new Set(data.colors.map((c) => c.family))].sort();
  for (const f of families) {
    familySel.appendChild(mk('option', { value: f, text: f, selected: UI.state.colorFamily === f }));
  }
  toolbar.appendChild(familySel);
  toolbar.appendChild(mk('div', { class: 'spacer' }));
  toolbar.appendChild(mk('button', {
    class: 'btn',
    text: tr('colors.loadCatalog'),
    onclick: async () => {
      const res = await api.mutate('/api/colors/load', {});
      if (res.ok) toast(tr('colors.loaded', { added: res.data.added, skipped: res.data.skipped }), 'ok');
      else toast(res.data.message || tr('toast.forbidden'), 'error');
      await render();
    },
  }));
  toolbar.appendChild(mk('button', {
    class: 'btn secondary', text: tr('colors.add'),
    onclick: () => { UI.state.showAddColor = !UI.state.showAddColor; render(); },
  }));
  main.appendChild(toolbar);

  if (can(UI.user, 'color.add', null) && UI.state.showAddColor) {
    main.appendChild(addColorForm());
  }
  if (!can(UI.user, 'color.delete', null)) {
    main.appendChild(mk('p', { class: 'sub', text: tr('colors.deleteAdminOnly') }));
  }

  const filtered = data.colors.filter((c) => !UI.state.colorFamily || c.family === UI.state.colorFamily);
  if (UI.colorsMode === 'grid') {
    const grid = mk('div', { class: 'color-grid' });
    for (const c of filtered) {
      const cell = mk('div', { class: 'color-cell' });
      cell.appendChild(mk('div', { class: 'hexchip', style: { background: c.hex || '#ccc' } }));
      cell.appendChild(mk('strong', { text: nameOf(c) }));
      cell.appendChild(mk('div', { class: 'sub' }, `${c.family} · ${tr('colors.grade')} ${c.grade}`));
      cell.appendChild(mk('div', { class: 'chip', text: tr('colors.usage', { n: c.usage_count }) }));
      grid.appendChild(cell);
    }
    main.appendChild(grid);
  } else {
    const table = mk('table', { class: 'data' });
    table.appendChild(mk('thead', {}, mk('tr', {},
      mk('th', { text: tr('colors.hex') }), mk('th', { text: tr('app.nameAr') }),
      mk('th', { text: tr('app.nameEn') }), mk('th', { text: tr('colors.family') }),
      mk('th', { text: tr('colors.grade') }), mk('th', { text: tr('colors.usage', { n: '' }).replace('{n}', '').trim() }),
      mk('th', { text: tr('tbl.keeperCode') }))));
    const tb = mk('tbody');
    const codeByColor = new Map((data.codes || []).map((c) => [c.color_id, c.custom_code]));
    for (const c of filtered) {
      tb.appendChild(mk('tr', {},
        mk('td', {}, mk('span', { class: 'swatch', style: { background: c.hex || '#ccc' } }), c.hex || ''),
        mk('td', { text: c.name_ar }), mk('td', { text: c.name_en || '' }),
        mk('td', { text: c.family }), mk('td', { text: c.grade }),
        mk('td', { text: n(c.usage_count) }),
        mk('td', { class: 'formula-code', text: codeByColor.get(c.id) || '' })));
    }
    table.appendChild(tb);
    main.appendChild(table);
  }
}

function addColorForm() {
  const form = mk('form', {
    class: 'grid card',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const res = await api.mutate('/api/colors', {
        name_ar: fd.get('name_ar'), name_en: fd.get('name_en'),
        family: fd.get('family'), grade: fd.get('grade'), hex: fd.get('hex'),
      });
      if (res.ok) { toast(tr('app.saved'), 'ok'); UI.state.showAddColor = false; await render(); }
      else toast(res.data.message || tr('toast.forbidden'), 'error');
    },
  });
  form.appendChild(mk('label', { class: 'field' }, tr('app.nameAr'), mk('input', { name: 'name_ar', required: true })));
  form.appendChild(mk('label', { class: 'field' }, tr('app.nameEn'), mk('input', { name: 'name_en' })));
  form.appendChild(mk('label', { class: 'field' }, tr('colors.family'), mk('input', { name: 'family', value: 'misc' })));
  form.appendChild(mk('label', { class: 'field' }, tr('colors.grade'), mk('input', { name: 'grade', value: 'A' })));
  form.appendChild(mk('label', { class: 'field' }, tr('colors.hex'), mk('input', { name: 'hex', value: '#888888' })));
  form.appendChild(mk('div', {}, mk('button', { class: 'btn', type: 'submit', text: tr('app.save') })));
  return form;
}

function codeForm(colors) {
  const form = mk('form', {
    class: 'grid card',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      const res = await api.mutate('/api/colors/codes', {
        colorId: fd.get('colorId'),
        customCode: fd.get('customCode'),
        customName: fd.get('customName'),
        notes: fd.get('notes'),
      });
      if (res.ok) { toast(tr('app.saved'), 'ok'); await render(); }
      else toast(res.data.message || tr('toast.forbidden'), 'error');
    },
  });
  form.appendChild(mk('h3', { text: tr('colors.codes') }));
  const sel = mk('select', { name: 'colorId' });
  for (const c of colors) sel.appendChild(mk('option', { value: c.id, text: nameOf(c) }));
  form.appendChild(mk('label', { class: 'field' }, tr('app.color'), sel));
  form.appendChild(mk('label', { class: 'field' }, tr('colors.customCode'), mk('input', { name: 'customCode' })));
  form.appendChild(mk('label', { class: 'field' }, tr('colors.customName'), mk('input', { name: 'customName' })));
  form.appendChild(mk('label', { class: 'field' }, tr('app.notes'), mk('input', { name: 'notes' })));
  form.appendChild(mk('div', {}, mk('button', { class: 'btn', type: 'submit', text: tr('app.save') })));
  return form;
}

// ---- 6. Cross-View (#cross) ---------------------------------------------

async function renderCross(main) {
  main.appendChild(mk('h1', { text: tr('cross.title') }));
  const data = await api.get('/api/cross');
  if (!data.sheds.length) {
    main.appendChild(mk('p', { class: 'sub', text: tr('cross.adminEmpty') }));
    return;
  }
  const ownerName = data.owner
    ? (L() === 'ar' ? (data.owner.display_name_ar || data.owner.username) : (data.owner.display_name_en || data.owner.username))
    : '';
  main.appendChild(mk('div', { class: 'card', style: { background: '#fff3d9', borderColor: '#b8860b' } },
    mk('strong', { text: tr('cross.banner', { name: ownerName }) })));
  const grid = mk('div', { class: 'cards-grid' });
  for (const shed of data.sheds) {
    grid.appendChild(await shedCard(shed, true));
  }
  main.appendChild(grid);
  main.appendChild(mk('p', { class: 'sub', text: tr('app.readOnly') }));
}

// ---- 7. Dashboard (#dashboard) ------------------------------------------

async function renderDashboard(main) {
  main.appendChild(mk('h1', { text: tr('dash.title') }));
  const data = await api.get(`/api/dashboard?trend=${UI.dashboardTrend}`);

  const kpis = mk('div', { class: 'kpi-row' });
  kpis.appendChild(mk('div', { class: 'kpi' }, mk('div', { class: 'v', text: n(data.kpis.rolls) }), mk('div', { class: 'l', text: tr('dash.kpiRolls') })));
  kpis.appendChild(mk('div', { class: 'kpi' }, mk('div', { class: 'v', text: m(data.kpis.meters) }), mk('div', { class: 'l', text: tr('dash.kpiMeters') })));
  kpis.appendChild(mk('div', { class: 'kpi' }, mk('div', { class: 'v', text: money(data.kpis.value) }), mk('div', { class: 'l', text: tr('dash.kpiValue') })));
  kpis.appendChild(mk('div', { class: 'kpi' }, mk('div', { class: 'v', text: n(data.kpis.low) }), mk('div', { class: 'l', text: tr('dash.kpiLow') })));
  main.appendChild(kpis);

  main.appendChild(mk('h2', { text: tr('dash.rollsByShed') }));
  const maxRolls = Math.max(1, ...data.byShed.map((s) => s.rolls));
  for (const s of data.byShed) {
    main.appendChild(mk('div', { class: 'bar-row' },
      mk('span', { class: 'bar-label', text: nameOf(s) }),
      mk('span', { class: 'bar-track' }, mk('i', { class: 'bar-fill', style: { width: `${s.rolls / maxRolls * 100}%` } })),
      mk('span', { class: 'bar-val', text: n(s.rolls) })));
  }

  main.appendChild(mk('h2', { text: tr('dash.fabricMix') }));
  const maxMix = Math.max(1, ...data.mix.map((f) => f.rolls));
  for (const f of data.mix) {
    main.appendChild(mk('div', { class: 'bar-row' },
      mk('span', { class: 'bar-label', text: nameOf(f) }),
      mk('span', { class: 'bar-track' }, mk('i', { class: 'bar-fill', style: { width: `${f.rolls / maxMix * 100}%`, background: '#b8860b' } })),
      mk('span', { class: 'bar-val', text: n(f.rolls) })));
  }

  main.appendChild(mk('h2', { text: tr('dash.gradeDonut') }));
  const totalGrade = Math.max(1, data.grades.reduce((a, g) => a + g.rolls, 0));
  const legend = mk('div', { class: 'donut-legend' });
  const palette = { A: '#2e8b57', B: '#1f4fa3', C: '#b8860b', D: '#b02a2a' };
  for (const g of data.grades) {
    legend.appendChild(mk('span', {},
      mk('span', { class: 'swatch', style: { background: palette[g.grade] || '#888' } }),
      ` ${tr('colors.grade')} ${g.grade}: ${n(g.rolls)} (${pct(g.rolls / totalGrade * 100)})`));
  }
  main.appendChild(legend);

  main.appendChild(mk('h2', { text: tr('dash.trend') }));
  const trendBar = mk('div', { class: 'toolbar' });
  for (const g of ['day', 'week', 'month']) {
    trendBar.appendChild(mk('button', {
      class: UI.dashboardTrend === g ? 'btn' : 'btn secondary',
      text: tr(`dash.${g}`),
      onclick: () => { UI.dashboardTrend = g; render(); },
    }));
  }
  main.appendChild(trendBar);
  const maxTrend = Math.max(1, ...data.trend.map((p) => p.closing));
  for (const p of data.trend) {
    main.appendChild(mk('div', { class: 'bar-row' },
      mk('span', { class: 'bar-label formula-code', text: p.bucket }),
      mk('span', { class: 'bar-track' }, mk('i', { class: 'bar-fill', style: { width: `${p.closing / maxTrend * 100}%`, background: '#2e8b57' } })),
      mk('span', { class: 'bar-val', text: n(p.closing) })));
  }

  main.appendChild(mk('h2', { text: tr('dash.topMovers') }));
  const mv = mk('table', { class: 'data' });
  mv.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('app.warehouse') }), mk('th', { text: tr('app.fabric') }),
    mk('th', { text: tr('app.color') }), mk('th', { text: tr('mv.delta') }))));
  const mvb = mk('tbody');
  for (const r of data.topMovers) {
    mvb.appendChild(mk('tr', {},
      mk('td', { text: nameOf({ name_ar: r.wh_name_ar, name_en: r.wh_name_en }) }),
      mk('td', { text: nameOf({ name_ar: r.fab_name_ar, name_en: r.fab_name_en }) }),
      mk('td', {}, mk('span', { class: 'swatch', style: { background: r.hex || '#ccc' } }),
        nameOf({ name_ar: r.col_name_ar, name_en: r.col_name_en })),
      mk('td', { text: n(r.rolled) })));
  }
  mv.appendChild(mvb);
  main.appendChild(mv);

  main.appendChild(mk('h2', { text: tr('dash.reorderNow') }));
  if (!data.reorder.length) {
    main.appendChild(mk('p', { class: 'sub', text: tr('dash.reorderEmpty') }));
  } else {
    const rt = mk('table', { class: 'data' });
    rt.appendChild(mk('thead', {}, mk('tr', {},
      mk('th', { text: tr('app.warehouse') }), mk('th', { text: tr('app.fabric') }),
      mk('th', { text: tr('app.color') }), mk('th', { text: tr('inv.closing') }),
      mk('th', { text: tr('inv.min') }), mk('th', { text: tr('inv.reorder') }))));
    const rtb = mk('tbody');
    for (const r of data.reorder) {
      rtb.appendChild(mk('tr', { class: 'low' },
        mk('td', { text: nameOf({ name_ar: r.wh_name_ar, name_en: r.wh_name_en }) }),
        mk('td', { text: nameOf({ name_ar: r.fab_name_ar, name_en: r.fab_name_en }) }),
        mk('td', {}, mk('span', { class: 'swatch', style: { background: r.hex || '#ccc' } }),
          nameOf({ name_ar: r.col_name_ar, name_en: r.col_name_en })),
        mk('td', { text: n(r.closing_rolls) }),
        mk('td', { text: n(r.min_rolls) }),
        mk('td', {}, mk('strong', { text: n(r.reorder_qty) }))));
    }
    rt.appendChild(rtb);
    main.appendChild(rt);
  }
}

// ---- 8. Reports (#reports) ----------------------------------------------

async function renderReports(main) {
  main.appendChild(mk('h1', { text: tr('rep.title') }));
  const card = mk('div', { class: 'card' });
  const form = mk('form', {
    class: 'grid',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fd = new FormData(form);
      UI.reportsKind = fd.get('kind');
      UI.reportResult = await api.get(
        `/api/reports?kind=${encodeURIComponent(fd.get('kind'))}&from=${encodeURIComponent(fd.get('from') || '')}&to=${encodeURIComponent(fd.get('to') || '')}`
      );
      render();
    },
  });
  const kindSel = mk('select', { name: 'kind' });
  for (const k of ['byWarehouse', 'byFabric', 'byGrade', 'byDate']) {
    kindSel.appendChild(mk('option', { value: k, text: tr(`rep.${k}`), selected: UI.reportsKind === k }));
  }
  form.appendChild(mk('label', { class: 'field' }, tr('rep.kind'), kindSel));
  form.appendChild(mk('label', { class: 'field' }, tr('rep.from'), mk('input', { name: 'from', type: 'date' })));
  form.appendChild(mk('label', { class: 'field' }, tr('rep.to'), mk('input', { name: 'to', type: 'date' })));
  form.appendChild(mk('div', {}, mk('button', { class: 'btn', type: 'submit', text: tr('rep.run') })));
  card.appendChild(form);
  const toolbar = mk('div', { class: 'toolbar' });
  toolbar.appendChild(mk('button', {
    class: 'btn secondary', text: tr('csv.download'),
    onclick: () => openServerSheet(`/api/reports?kind=${UI.reportsKind}&format=csv`),
  }));
  toolbar.appendChild(mk('button', {
    class: 'btn secondary', text: tr('print.open'),
    onclick: () => openServerSheet(`/api/reports?kind=${UI.reportsKind}&format=print&lang=${L()}`),
  }));
  card.appendChild(toolbar);
  main.appendChild(card);

  if (UI.reportResult) {
    const rep = UI.reportResult;
    if (!rep.rows.length) {
      main.appendChild(mk('p', { class: 'sub', text: tr('rep.empty') }));
      return;
    }
    const table = mk('table', { class: 'data' });
    table.appendChild(mk('thead', {}, mk('tr', {},
      ...rep.columns.map((c) => mk('th', { text: c })))));
    const tb = mk('tbody');
    for (const row of rep.rows) {
      tb.appendChild(mk('tr', {}, ...row.map((c) => mk('td', { text: String(c ?? '') }))));
    }
    table.appendChild(tb);
    main.appendChild(mk('p', { class: 'sub' }, `${tr('app.rows', { n: rep.rows.length })} · ${tr('rep.generated')}: ${dateS(rep.generated)}`));
    main.appendChild(table);
  } else {
    main.appendChild(mk('p', { class: 'sub', text: tr('rep.letterhead') }));
  }
}

/** Print/CSV goes through the server sheet endpoint — never window.print(). */
function openServerSheet(path) {
  UI.lastServerSheet = path;
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(path, '_blank');
  }
}

// ---- 9. Masters (#masters) ----------------------------------------------

async function renderMasters(main) {
  main.appendChild(mk('h1', { text: tr('mas.title') }));
  const tabs = mk('div', { class: 'tabs' });
  for (const tab of ['warehouses', 'fabrics', 'colors', 'mapping']) {
    tabs.appendChild(mk('button', {
      class: UI.mastersTab === tab ? 'active' : '',
      text: tr(`mas.${tab}`),
      onclick: () => { UI.mastersTab = tab; render(); },
    }));
  }
  main.appendChild(tabs);
  if (!can(UI.user, 'color.delete', null)) {
    main.appendChild(mk('p', { class: 'sub', text: tr('mas.noDelete') }));
  }

  if (UI.mastersTab === 'warehouses') {
    const data = await api.get('/api/masters/warehouses');
    const table = mk('table', { class: 'data' });
    table.appendChild(mk('thead', {}, mk('tr', {},
      mk('th', { text: tr('app.warehouse') }), mk('th', { text: tr('mas.keeper') }),
      mk('th', { text: tr('mas.allowedGrades') }), mk('th', { text: tr('tbl.gradeLabel') }),
      mk('th', { text: tr('mas.capacity') }), mk('th', { text: tr('app.rolls') }))));
    const tb = mk('tbody');
    for (const r of data.rows) {
      tb.appendChild(mk('tr', {},
        mk('td', { text: nameOf(r) }), mk('td', { text: r.keeper_user_id }),
        mk('td', { text: r.allowed_grades }), mk('td', { text: r.grade_label_ar || '' }),
        mk('td', { text: n(r.capacity_rolls) }),
        mk('td', { text: n(r.summary ? r.summary.rolls : 0) })));
    }
    table.appendChild(tb);
    main.appendChild(table);
    return;
  }

  if (UI.mastersTab === 'fabrics') {
    const data = await api.get('/api/masters/fabrics');
    const table = mk('table', { class: 'data' });
    table.appendChild(mk('thead', {}, mk('tr', {},
      mk('th', { text: tr('app.nameAr') }), mk('th', { text: tr('app.nameEn') }),
      mk('th', { text: tr('tbl.metersPerRoll') }), mk('th', { text: tr('tbl.costPerRoll') }),
      mk('th', { text: tr('app.status') }))));
    const tb = mk('tbody');
    for (const r of data.rows) {
      tb.appendChild(mk('tr', {},
        mk('td', { text: r.name_ar }), mk('td', { text: r.name_en || '' }),
        mk('td', { text: n(r.meters_per_roll) }), mk('td', { text: money(r.unit_cost_per_roll) }),
        mk('td', { text: r.active ? tr('app.active') : tr('app.inactive') })));
    }
    table.appendChild(tb);
    main.appendChild(table);
    return;
  }

  if (UI.mastersTab === 'colors') {
    const data = await api.get('/api/masters/colors');
    const table = mk('table', { class: 'data' });
    table.appendChild(mk('thead', {}, mk('tr', {},
      mk('th', { text: tr('colors.hex') }), mk('th', { text: tr('app.nameAr') }),
      mk('th', { text: tr('colors.family') }), mk('th', { text: tr('colors.grade') }),
      mk('th', { text: tr('colors.usageCol') }))));
    const tb = mk('tbody');
    for (const r of data.rows) {
      tb.appendChild(mk('tr', {},
        mk('td', {}, mk('span', { class: 'swatch', style: { background: r.hex || '#ccc' } })),
        mk('td', { text: r.name_ar }), mk('td', { text: r.family }),
        mk('td', { text: r.grade }), mk('td', { text: n(r.usage_count) })));
    }
    table.appendChild(tb);
    main.appendChild(table);
    return;
  }

  // mapping tab + diagnostics
  const data = await api.get('/api/masters/mapping');
  const table = mk('table', { class: 'data' });
  table.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('app.warehouse') }), mk('th', { text: tr('app.fabric') }),
    mk('th', { text: tr('app.color') }), mk('th', { text: tr('inv.min') }),
    mk('th', { text: tr('inv.max') }), mk('th', { text: tr('inv.leadTime') }),
    mk('th', { text: tr('app.status') }))));
  const tb = mk('tbody');
  for (const r of data.rows.slice(0, 200)) {
    tb.appendChild(mk('tr', { class: r.active ? '' : 'inactive' },
      mk('td', { text: r.wh_name_ar || r.wh_name_en }),
      mk('td', { text: r.fab_name_ar || r.fab_name_en }),
      mk('td', {}, mk('span', { class: 'swatch', style: { background: r.hex || '#ccc' } }),
        r.col_name_ar || r.col_name_en),
      mk('td', { text: n(r.min_rolls) }), mk('td', { text: n(r.max_rolls) }),
      mk('td', { text: n(r.lead_time_days) }),
      mk('td', { text: r.active ? tr('app.active') : tr('app.inactive') })));
  }
  table.appendChild(tb);
  main.appendChild(mk('p', { class: 'sub' }, tr('app.rows', { n: data.rows.length })));
  main.appendChild(table);

  const diagBtn = mk('button', {
    class: 'btn secondary', text: tr('mas.diagnose'),
    onclick: async () => {
      const diag = await api.get('/api/masters/diagnostics');
      const box = mk('div', { class: 'card' });
      box.appendChild(mk('h3', { text: tr('mas.diagnose') }));
      if (!diag.summary.orphans && !diag.summary.duplicates && !diag.summary.unmapped
        && !diag.summary.negative && !diag.summary.missingTranslations) {
        box.appendChild(mk('p', { text: tr('diag.clean') }));
      }
      for (const [key, labelKey] of [
        ['orphans', 'diag.orphans'], ['duplicates', 'diag.duplicates'],
        ['unmapped', 'diag.unmapped'], ['negative', 'diag.negative'],
        ['missingTranslations', 'diag.missingTranslations'],
      ]) {
        const items = diag[key] || [];
        box.appendChild(mk('div', {}, `${tr(labelKey)}: `, mk('strong', { text: n(items.length) })));
        for (const item of items.slice(0, 8)) {
          box.appendChild(mk('div', { class: 'sub formula-code', text: JSON.stringify(item) }));
        }
      }
      main.appendChild(box);
    },
  });
  main.appendChild(diagBtn);
}

// ---- 10. Audit Log (#audit) ---------------------------------------------

async function renderAudit(main) {
  main.appendChild(mk('h1', { text: tr('audit.title') }));
  const data = await api.get('/api/audit');
  if (!data.rows.length) {
    main.appendChild(mk('p', { class: 'sub', text: tr('audit.empty') }));
    return;
  }
  const table = mk('table', { class: 'data' });
  table.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('audit.when') }), mk('th', { text: tr('audit.who') }),
    mk('th', { text: tr('audit.what') }), mk('th', { text: tr('audit.entity') }),
    mk('th', { text: tr('audit.before') }), mk('th', { text: tr('audit.after') }),
    mk('th', { text: tr('audit.result') }), mk('th', { text: tr('audit.ip') }))));
  const tb = mk('tbody');
  for (const r of data.rows) {
    tb.appendChild(mk('tr', {},
      mk('td', { text: dateS(r.created_at) }),
      mk('td', { text: r.actor_user_id || '—' }),
      mk('td', { text: r.action }),
      mk('td', { text: `${r.entity}:${r.entity_id}` }),
      mk('td', { class: 'formula-code', text: r.before_json || '' }),
      mk('td', { class: 'formula-code', text: r.after_json || '' }),
      mk('td', {}, mk('span', {
        class: `chip ${String(r.result).startsWith('Blocked') ? 'red' : 'green'}`,
        text: r.result,
      })),
      mk('td', { class: 'formula-code', text: r.ip || '' })));
  }
  table.appendChild(tb);
  main.appendChild(table);
}

// ---- 11. Settings (#settings) — Admin -----------------------------------

async function renderSettings(main) {
  if (!can(UI.user, 'settings.write', null)) {
    return renderProfile(main);
  }
  main.appendChild(mk('h1', { text: tr('set.title') }));
  const data = await api.get('/api/settings');

  main.appendChild(mk('h2', { text: tr('set.params') }));
  const params = mk('table', { class: 'data' });
  const pb = mk('tbody');
  for (const s of data.settings) {
    pb.appendChild(mk('tr', {}, mk('td', { text: s.key }), mk('td', { text: s.value })));
  }
  params.appendChild(pb);
  main.appendChild(params);
  main.appendChild(mk('p', { class: 'sub' }, `${tr('rd.records')}: `, mk('strong', { text: n(data.records) })));

  main.appendChild(mk('h2', { text: tr('set.users') }));
  main.appendChild(mk('p', { class: 'sub', text: tr('set.userRoleHelp') }));
  const users = mk('table', { class: 'data' });
  users.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('prof.username') }), mk('th', { text: tr('app.role') }),
    mk('th', { text: tr('prof.scope') }), mk('th', { text: tr('app.actions') }))));
  const ub = mk('tbody');
  for (const u of data.users) {
    const sel = mk('select', {},
      mk('option', { value: 'Admin', text: 'Admin', selected: u.role === 'Admin' }),
      mk('option', { value: 'WarehouseKeeper', text: 'WarehouseKeeper', selected: u.role === 'WarehouseKeeper' }),
      mk('option', { value: 'SalesManager', text: 'SalesManager', selected: u.role === 'SalesManager' }));
    ub.appendChild(mk('tr', {},
      mk('td', { text: u.username }),
      mk('td', {}, sel),
      mk('td', { class: 'formula-code', text: u.warehouse_ids }),
      mk('td', {}, mk('button', {
        class: 'btn secondary',
        text: tr('app.save'),
        onclick: async () => {
          const res = await api.patch('/api/settings', {
            userRole: { id: u.id, role: sel.value, warehouseIds: JSON.parse(u.warehouse_ids), active: u.active === 1 },
          });
          toast(res.ok ? tr('app.saved') : tr('toast.forbidden'), res.ok ? 'ok' : 'error');
          if (res.ok) await render();
        },
      }))));
  }
  users.appendChild(ub);
  main.appendChild(users);

  main.appendChild(mk('h2', { text: tr('set.backup') }));
  const backupRow = mk('div', { class: 'toolbar' });
  backupRow.appendChild(mk('button', {
    class: 'btn secondary', text: tr('set.downloadBackup'),
    onclick: () => openServerSheet('/api/settings?backup=1'),
  }));
  const fileInput = mk('input', { type: 'file', accept: 'application/json', id: 'restore-file' });
  backupRow.appendChild(mk('label', { class: 'field' }, tr('set.uploadRestore'), fileInput));
  backupRow.appendChild(mk('button', {
    class: 'btn',
    text: tr('set.restore'),
    onclick: async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const text = await file.text();
      const res = await api.patch('/api/settings', { restore: JSON.parse(text) });
      toast(res.ok ? tr('set.restored') : tr('toast.network'), res.ok ? 'ok' : 'error');
    },
  }));
  main.appendChild(backupRow);

  main.appendChild(mk('h2', { text: tr('set.danger') }));
  const danger = mk('div', { class: 'card', style: { borderColor: '#b02a2a' } });
  danger.appendChild(mk('p', { text: tr('set.confirmDanger') }));
  const dangerInput = mk('input', { placeholder: 'RESEED', style: { marginInlineEnd: '.55rem' } });
  danger.appendChild(dangerInput);
  danger.appendChild(mk('button', {
    class: 'btn danger',
    text: tr('set.reseeded'),
    onclick: async () => {
      if (dangerInput.value !== 'RESEED') { toast(tr('app.invalid'), 'error'); return; }
      const res = await api.patch('/api/settings', { resetMovements: true, confirm: 'RESEED' });
      toast(res.ok ? tr('set.reseeded') : tr('toast.forbidden'), res.ok ? 'ok' : 'error');
      if (res.ok) await render();
    },
  }));
  main.appendChild(danger);
}

// ---- 12. My Profile (#profile) ------------------------------------------

async function renderProfile(main) {
  main.appendChild(mk('h1', { text: tr('prof.title') }));
  const data = await api.get('/api/profile');
  const card = mk('div', { class: 'card' });
  card.appendChild(mk('div', {}, `${tr('prof.username')}: `, mk('strong', { text: data.user.username })));
  card.appendChild(mk('div', {}, `${tr('app.role')}: `, mk('strong', { text: data.user.role })));
  card.appendChild(mk('div', {},
    `${tr('app.user')}: `, mk('strong', {
      text: L() === 'ar'
        ? (data.user.displayNameAr || data.user.username)
        : (data.user.displayNameEn || data.user.username),
    })));
  card.appendChild(mk('p', { class: 'sub', text: tr('prof.readOnlyNote') }));
  main.appendChild(card);

  main.appendChild(mk('h2', { text: tr('prof.scope') }));
  const scopeTbl = mk('table', { class: 'data' });
  scopeTbl.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('tbl.shed') }), mk('th', { text: tr('mas.allowedGrades') }),
    mk('th', { text: tr('tbl.gradeLabel') }))));
  const sb = mk('tbody');
  for (const s of data.sheds) {
    sb.appendChild(mk('tr', {},
      mk('td', { text: nameOf(s) }),
      mk('td', { text: s.allowed_grades }),
      mk('td', { text: s.grade_label_ar || '' })));
  }
  scopeTbl.appendChild(sb);
  main.appendChild(scopeTbl);

  main.appendChild(mk('h2', { text: tr('prof.codes') }));
  const codesTbl = mk('table', { class: 'data' });
  codesTbl.appendChild(mk('thead', {}, mk('tr', {},
    mk('th', { text: tr('app.color') }), mk('th', { text: tr('colors.customCode') }),
    mk('th', { text: tr('colors.customName') }), mk('th', { text: tr('app.notes') }))));
  const cb = mk('tbody');
  for (const c of data.codes) {
    cb.appendChild(mk('tr', {},
      mk('td', {}, mk('span', { class: 'swatch', style: { background: c.hex || '#ccc' } }),
        nameOf({ name_ar: c.col_name_ar, name_en: c.col_name_en })),
      mk('td', { class: 'formula-code', text: c.custom_code || '' }),
      mk('td', { text: c.custom_name || '' }),
      mk('td', { text: c.notes || '' })));
  }
  codesTbl.appendChild(cb);
  main.appendChild(codesTbl);
}

// ---- boot ---------------------------------------------------------------

export async function boot() {
  try {
    const saved = localStorage.getItem('frs_lang');
    if (saved === 'en' || saved === 'ar') UI.lang = saved;
  } catch { /* transient preference only */ }
  document.documentElement.lang = UI.lang;
  document.documentElement.dir = UI.lang === 'ar' ? 'rtl' : 'ltr';

  try {
    const me = await api.get('/api/auth/me');
    UI.user = me.user;
    await route();
  } catch {
    renderLogin();
  }
}

export function setUser(user) {
  UI.user = user;
}

if (typeof window !== 'undefined') {
  window.App = { UI, boot, route, render, setLang, setUser, api, mk, currentRoute };
  if (!window.__TEST__) {
    window.addEventListener('hashchange', () => { if (UI.user) route(); });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
}
