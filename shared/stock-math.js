// shared/stock-math.js — pure functions. Used by the Durable Object, the Pages
// Functions, the SPA (build copy in app/), and the test suites. No I/O here.

// ---- core formulas -------------------------------------------------------

export function closingRolls(openingRolls, rollsIn, rollsOut) {
  return openingRolls + rollsIn - rollsOut;
}

export function totalMeters(closing, metersPerRoll) {
  return closing * metersPerRoll;
}

export function totalValue(closing, unitCostPerRoll) {
  return closing * unitCostPerRoll;
}

/** status: 0 → 'out' · ≤ min → 'low' · ≥ max → 'over' · else 'ok' */
export function statusOf(closing, minRolls, maxRolls) {
  if (closing === 0) return 'out';
  if (closing <= minRolls) return 'low';
  if (maxRolls > 0 && closing >= maxRolls) return 'over';
  return 'ok';
}

export const STATUS_KEYS = {
  out: 'status.out',
  low: 'status.low',
  over: 'status.over',
  ok: 'status.ok',
};

/** reorder = MAX(0, minRolls − closingRolls), rounded UP to a whole roll. */
export function reorderQty(closing, minRolls) {
  const q = Math.max(0, minRolls - closing);
  return Math.ceil(q);
}

/**
 * utilization = Σ closingRolls(shed) ÷ capacityRolls × 100.
 * Allowed to exceed 100 — that is overcapacity, not an error.
 * Band: <50 green · 50–85 amber · >85 red.
 */
export function utilization(closingSum, capacityRolls) {
  if (!capacityRolls) return { pct: 0, band: 'green' };
  const pct = (closingSum / capacityRolls) * 100;
  let band = 'green';
  if (pct > 85) band = 'red';
  else if (pct >= 50) band = 'amber';
  return { pct, band };
}

/** Independent recompute: opening + Σ event deltas (the spec's getStock). */
export function computeClosingFromEvents(opening, events) {
  return events.reduce((acc, e) => acc + e.rolls_delta, opening);
}

/**
 * A row that would drive closingRolls below zero is refused — never clipped.
 * Returns { ok, after, shortfall }.
 */
export function checkNonNegative(before, rollsDelta) {
  const after = before + rollsDelta;
  if (after < 0) {
    return { ok: false, after, shortfall: Math.abs(after) };
  }
  return { ok: true, after, shortfall: 0 };
}

// ---- formatters (Intl with manual fallback) ------------------------------
// Dates stored yyyy-mm-dd; Arabic month names in AR.

const AR_MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];
const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

function toArabicDigits(s) {
  return String(s).replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)]);
}

function group3(n) {
  const s = String(n);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function fmtNum(n, lang = 'en') {
  const v = Number(n) || 0;
  try {
    return new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US').format(v);
  } catch {
    return group3(Math.round(v));
  }
}

export function fmtMeters(m, lang = 'en') {
  const v = Number(m) || 0;
  let out;
  try {
    out = new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    out = group3(Math.floor(v)) + '.' + String(Math.round((v % 1) * 100)).padStart(2, '0');
  }
  return out + (lang === 'ar' ? ' م' : ' m');
}

export function fmtMoney(v, lang = 'en') {
  const n = Number(v) || 0;
  let out;
  try {
    out = new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    out = group3(Math.floor(n)) + '.' + String(Math.round((n % 1) * 100)).padStart(2, '0');
  }
  return lang === 'ar' ? out + ' ج.م' : 'EGP ' + out;
}

export function fmtPct(p, lang = 'en') {
  const v = Number(p) || 0;
  let out;
  try {
    out = new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(v);
  } catch {
    out = v.toFixed(1);
  }
  return out + '%';
}

/** formatDate('2026-11-08', 'ar') → '٨ نوفمبر ٢٠٢٦' (Arabic month names in AR). */
export function formatDate(isoDate, lang = 'en') {
  if (!isoDate) return '';
  const m = String(isoDate).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(isoDate);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (lang === 'ar') {
    return toArabicDigits(d) + ' ' + AR_MONTHS[mo] + ' ' + toArabicDigits(y);
  }
  const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d + ' ' + EN_MONTHS[mo] + ' ' + y;
}

export function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
