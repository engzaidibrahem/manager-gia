/** Presentation-layer labels — never rewrite DB enums. */

export function displayCategory(value: string | null | undefined, lang: 'id' | 'ar'): string {
  const v = (value ?? '').trim();
  if (!v) return lang === 'id' ? 'Tidak dikategorikan' : 'غير مصنف';
  const key = v.toLowerCase();
  const map: Record<string, [string, string]> = {
    umum: ['Umum', 'عام'],
    general: ['Umum', 'عام'],
    other: ['Lainnya', 'أخرى'],
    bahan: ['Bahan', 'مواد'],
    daging: ['Daging', 'لحوم'],
    biaya: ['Biaya', 'تكاليف'],
    office: ['Kantor', 'مكتبية'],
    menu: ['Menu', 'قائمة'],
    qa: ['QA', 'اختبار'],
  };
  if (map[key]) return lang === 'id' ? map[key][0] : map[key][1];
  // Legacy import noise
  if (/أصناف مضافة|dari gerakan|from movement/i.test(v)) {
    return lang === 'id' ? 'Tidak dikategorikan' : 'غير مصنف';
  }
  return v;
}

export function displayUnit(value: string | null | undefined, lang: 'id' | 'ar'): string {
  const v = (value ?? '').trim();
  if (!v) return lang === 'id' ? 'unit' : 'وحدة';
  if (/كما ورد|as in|inventory|الجرد/i.test(v)) return lang === 'id' ? 'unit' : 'وحدة';
  const key = v.toLowerCase();
  const map: Record<string, [string, string]> = {
    kg: ['kg', 'كغ'],
    g: ['g', 'غ'],
    l: ['L', 'لتر'],
    ml: ['ml', 'مل'],
    pcs: ['pcs', 'قطعة'],
    piece: ['pcs', 'قطعة'],
    box: ['box', 'علبة'],
    pack: ['pack', 'عبوة'],
    service: ['jasa', 'خدمة'],
  };
  if (map[key]) return lang === 'id' ? map[key][0] : map[key][1];
  return v;
}

export function displayDestination(value: string | null | undefined, lang: 'id' | 'ar'): string {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'warehouse' || v === 'kitchen') return lang === 'id' ? 'Gudang' : 'المستودع';
  if (v === 'none') return lang === 'id' ? 'Pembelian biasa' : 'شراء عادي';
  return value || '—';
}

export function displayLocation(value: string | null | undefined, lang: 'id' | 'ar'): string {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'warehouse') return lang === 'id' ? 'Gudang' : 'المستودع';
  if (v === 'kitchen') return lang === 'id' ? 'Dapur' : 'المطبخ';
  return value || '—';
}

export function displayMovementType(value: string | null | undefined, lang: 'id' | 'ar'): string {
  const v = (value ?? '').trim().toLowerCase();
  const map: Record<string, [string, string]> = {
    transfer: ['Transfer ke dapur', 'تحويل للمطبخ'],
    receive: ['Penerimaan', 'استلام'],
    receipt: ['Penerimaan', 'استلام'],
    waste: ['Limbah', 'هدر'],
    adjustment: ['Penyesuaian', 'تعديل'],
    issue: ['Keluar ke dapur', 'إخراج للمطبخ'],
    opening_balance: ['Saldo awal', 'رصيد افتتاح'],
    legacy_backfill: ['Koreksi lama', 'تصحيح قديم'],
  };
  if (map[v]) return lang === 'id' ? map[v][0] : map[v][1];
  return value || '—';
}

export function displayActor(value: string | null | undefined, lang: 'id' | 'ar'): string {
  const v = (value ?? '').trim().toLowerCase();
  const map: Record<string, [string, string]> = {
    manager: ['Manajer', 'المدير'],
    owner: ['Pemilik', 'المالك'],
    admin: ['Admin', 'المسؤول'],
    warehouse: ['Gudang', 'المستودع'],
    kitchen: ['Dapur', 'المطبخ'],
  };
  if (map[v]) return lang === 'id' ? map[v][0] : map[v][1];
  return value || '—';
}
