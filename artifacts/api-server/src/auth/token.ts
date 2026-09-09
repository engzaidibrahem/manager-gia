import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "./roles";

export type AuthUser = {
  id: number;
  username: string;
  fullName: string;
  role: Role;
};

function secret(): string {
  return process.env.AUTH_SECRET || process.env.DATABASE_URL || "gia-dev-secret-change-me";
}

/** Compact signed token: base64url(payload).base64url(sig) */
export function signToken(user: AuthUser, ttlSeconds = 60 * 60 * 24 * 7): string {
  const payload = {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string): AuthUser | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AuthUser & { exp?: number };
    if (!payload?.id || !payload.username || !payload.role) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      id: payload.id,
      username: payload.username,
      fullName: payload.fullName || payload.username,
      role: payload.role,
    };
  } catch {
    return null;
  }
}
