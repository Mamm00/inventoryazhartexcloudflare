// worker/src/api-router.js — dispatches /api/* to the exact Pages Function
// modules in functions/api/** (same handler code, same shared RBAC middleware).
// This is what makes one `wrangler deploy` serve both the SPA (static assets)
// and the API on the Workers Builds CI that runs `npx wrangler deploy`.
//
// Route order matters only for params; every mutating handler still goes
// through guard() server-side — this router adds no authority of its own.

import { onRequest as middleware } from '../../functions/api/_middleware.js';

import { onRequestPost as loginPost } from '../../functions/api/auth/login.js';
import { onRequestPost as setupPost } from '../../functions/api/auth/setup.js';
import { onRequestPost as logoutPost } from '../../functions/api/auth/logout.js';
import { onRequestGet as meGet } from '../../functions/api/auth/me.js';
import { onRequestGet as healthGet } from '../../functions/api/health.js';
import { onRequestGet as stockGet } from '../../functions/api/stock/index.js';
import { onRequestGet as inventoryGet } from '../../functions/api/inventory/index.js';
import { onRequestGet as movementsGet, onRequestPost as movementsPost } from '../../functions/api/movements/index.js';
import { onRequestGet as colorsGet, onRequestPost as colorsPost } from '../../functions/api/colors/index.js';
import { onRequestGet as codesGet, onRequestPost as codesPost } from '../../functions/api/colors/codes.js';
import { onRequestPost as codesImportPost } from '../../functions/api/colors/codes/import.js';
import { onRequestPost as colorsLoadPost } from '../../functions/api/colors/load.js';
import { onRequestDelete as colorDelete, onRequestPatch as colorPatch } from '../../functions/api/colors/[id].js';
import { onRequestGet as crossGet } from '../../functions/api/cross/index.js';
import { onRequestGet as dashboardGet } from '../../functions/api/dashboard/index.js';
import { onRequestGet as reportsGet } from '../../functions/api/reports/index.js';
import { onRequestGet as mastersWhGet, onRequestPatch as mastersWhPatch } from '../../functions/api/masters/warehouses.js';
import { onRequestGet as mastersFabGet, onRequestPost as mastersFabPost, onRequestPatch as mastersFabPatch, onRequestDelete as mastersFabDelete } from '../../functions/api/masters/fabrics.js';
import { onRequestGet as mastersColGet, onRequestPost as mastersColPost, onRequestDelete as mastersColDelete } from '../../functions/api/masters/colors.js';
import { onRequestGet as mastersMapGet, onRequestPost as mastersMapPost, onRequestPatch as mastersMapPatch } from '../../functions/api/masters/mapping.js';
import { onRequestGet as diagGet } from '../../functions/api/masters/diagnostics.js';
import { onRequestGet as auditGet } from '../../functions/api/audit/index.js';
import { onRequestGet as settingsGet, onRequestPatch as settingsPatch } from '../../functions/api/settings/index.js';
import { onRequestGet as profileGet } from '../../functions/api/profile/index.js';
import { onRequestGet as readmeGet } from '../../functions/api/readme/index.js';
import { onRequestGet as offlineGet } from '../../functions/api/export/offline.js';

const ROUTES = [
  ['POST', '/api/auth/login', loginPost],
  ['POST', '/api/auth/setup', setupPost],
  ['POST', '/api/auth/logout', logoutPost],
  ['GET', '/api/auth/me', meGet],
  ['GET', '/api/health', healthGet],
  ['GET', '/api/stock', stockGet],
  ['GET', '/api/inventory', inventoryGet],
  ['GET', '/api/movements', movementsGet],
  ['POST', '/api/movements', movementsPost],
  ['GET', '/api/colors', colorsGet],
  ['POST', '/api/colors', colorsPost],
  ['GET', '/api/colors/codes', codesGet],
  ['POST', '/api/colors/codes', codesPost],
  ['POST', '/api/colors/codes/import', codesImportPost],
  ['POST', '/api/colors/load', colorsLoadPost],
  ['DELETE', '/api/colors/:id', colorDelete],
  ['PATCH', '/api/colors/:id', colorPatch],
  ['GET', '/api/cross', crossGet],
  ['GET', '/api/dashboard', dashboardGet],
  ['GET', '/api/reports', reportsGet],
  ['GET', '/api/masters/warehouses', mastersWhGet],
  ['PATCH', '/api/masters/warehouses', mastersWhPatch],
  ['GET', '/api/masters/fabrics', mastersFabGet],
  ['POST', '/api/masters/fabrics', mastersFabPost],
  ['PATCH', '/api/masters/fabrics', mastersFabPatch],
  ['DELETE', '/api/masters/fabrics', mastersFabDelete],
  ['GET', '/api/masters/colors', mastersColGet],
  ['POST', '/api/masters/colors', mastersColPost],
  ['DELETE', '/api/masters/colors', mastersColDelete],
  ['GET', '/api/masters/mapping', mastersMapGet],
  ['POST', '/api/masters/mapping', mastersMapPost],
  ['PATCH', '/api/masters/mapping', mastersMapPatch],
  ['GET', '/api/masters/diagnostics', diagGet],
  ['GET', '/api/audit', auditGet],
  ['GET', '/api/settings', settingsGet],
  ['PATCH', '/api/settings', settingsPatch],
  ['GET', '/api/profile', profileGet],
  ['GET', '/api/readme', readmeGet],
  ['GET', '/api/export/offline', offlineGet],
];

function match(routePath, path) {
  const rp = routePath.split('/');
  const pp = path.split('/');
  if (rp.length !== pp.length) return null;
  const params = {};
  for (let i = 0; i < rp.length; i += 1) {
    if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(pp[i]);
    else if (rp[i] !== pp[i]) return null;
  }
  return params;
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/$/, '') || '/';

  const context = { env, request, params: {}, data: {}, waitUntil: () => {} };
  return middleware(context, async () => {
    for (const [m, routePath, handler] of ROUTES) {
      if (m !== method && !(method === 'HEAD' && m === 'GET')) continue;
      const params = match(routePath, path);
      if (!params) continue;
      context.params = params;
      return handler(context);
    }
    return new Response(JSON.stringify({ error: 'NOT_FOUND', path }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });
}
