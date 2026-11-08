// shared/catalog.js — the ★ Load catalog source rows. Loading is idempotent
// (INSERT OR IGNORE): existing ids are skipped. This is the only catalogue
// content the loader knows about; it is intentionally a static, reviewable list.

export const CATALOG_ROWS = [
  { id: 'col-cat-01', name_ar: 'أزرق ملكي', name_en: 'Royal Blue', hex: '#1f4fa3', family: 'blue', grade: 'A' },
  { id: 'col-cat-02', name_ar: 'أزرق سماوي', name_en: 'Sky Blue', hex: '#6fb7e8', family: 'blue', grade: 'A' },
  { id: 'col-cat-03', name_ar: 'أخضر زمردي', name_en: 'Emerald', hex: '#2e8b57', family: 'green', grade: 'A' },
  { id: 'col-cat-04', name_ar: 'أحمر قرمزي', name_en: 'Crimson', hex: '#b02a2a', family: 'red', grade: 'A' },
  { id: 'col-cat-05', name_ar: 'بيج فاتح', name_en: 'Light Beige', hex: '#d9c9a8', family: 'beige', grade: 'B' },
  { id: 'col-cat-06', name_ar: 'بني شوكولاتة', name_en: 'Chocolate', hex: '#6b4a2f', family: 'brown', grade: 'B' },
  { id: 'col-cat-07', name_ar: 'رمادي فضي', name_en: 'Silver Grey', hex: '#a9a9a9', family: 'grey', grade: 'B' },
  { id: 'col-cat-08', name_ar: 'وردي هادئ', name_en: 'Soft Pink', hex: '#db7093', family: 'pink', grade: 'C' },
  { id: 'col-cat-09', name_ar: 'بنفسجي', name_en: 'Violet', hex: '#7b4fa0', family: 'purple', grade: 'C' },
  { id: 'col-cat-10', name_ar: 'أصفر ذهبي', name_en: 'Golden Yellow', hex: '#dec43c', family: 'yellow', grade: 'C' },
  { id: 'col-cat-11', name_ar: 'برتقالي', name_en: 'Orange', hex: '#e2822e', family: 'orange', grade: 'D' },
  { id: 'col-cat-12', name_ar: 'أسود فحمي', name_en: 'Charcoal', hex: '#202024', family: 'black', grade: 'D' },
];
