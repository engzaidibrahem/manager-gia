/** Strict numeric parse — never invent conversions from mixed unit text. */
export function parseStrictNumeric(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t || Number.isNaN(Number(t))) return null;
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    return Number(t);
  }
  return null;
}
