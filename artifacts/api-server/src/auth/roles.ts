export const ROLES = ["owner", "manager", "warehouse", "kitchen", "cashier", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Minimum role required for write (mutation) endpoints by path prefix. */
export function canAccess(role: Role, method: string, path: string): boolean {
  if (role === "owner" || role === "manager") return true;

  const p = path.replace(/^\/api/, "") || "/";
  const write = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  if (role === "viewer") return !write;

  if (role === "warehouse") {
    if (write && p.includes("/backfill-legacy")) return false;
    // Opening balance is owner/manager only
    if (write && p.includes("/opening-balance")) return false;
    if (p.startsWith("/inventory") || p.startsWith("/purchases") || p.startsWith("/warehouse-archives") || p.startsWith("/day-archives")) {
      return true;
    }
    return !write && (p.startsWith("/dashboard") || p.startsWith("/recipes") || p.startsWith("/staff") || p.startsWith("/finance") || p.startsWith("/waste"));
  }

  if (role === "kitchen") {
    if (p.startsWith("/inventory/issue") || p.startsWith("/inventory/lots") || p.startsWith("/inventory/items") || p.startsWith("/waste") || p.includes("/movements") || p.includes("/transfers")) {
      return true;
    }
    if (p.startsWith("/recipes") || p.startsWith("/dashboard")) return !write;
    return !write && (p.startsWith("/inventory") || p.startsWith("/kitchen"));
  }

  if (role === "cashier") {
    // Capital register is owner/manager only (sensitive operational capital)
    if (write && p.includes("/capital")) return false;
    if (p.startsWith("/finance") || p.startsWith("/day-archives")) return true;
    return !write && (p.startsWith("/dashboard") || p.startsWith("/purchases") || p.startsWith("/recipes"));
  }

  return false;
}
