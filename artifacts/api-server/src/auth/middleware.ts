import type { NextFunction, Request, Response } from "express";
import { canAccess, type Role } from "./roles";
import { verifyToken, type AuthUser } from "./token";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)gia_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  req.user = user;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!roles.includes(req.user.role) && req.user.role !== "owner" && req.user.role !== "manager") {
      res.status(403).json({ error: "Forbidden for this role" });
      return;
    }
    next();
  };
}

/** Path-based permission check after auth. */
export function requirePermission(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const path = req.originalUrl.split("?")[0] || req.path;
  if (!canAccess(req.user.role, req.method, path)) {
    res.status(403).json({ error: "You do not have permission to perform this operation.", code: "UNAUTHORIZED_OPERATION" });
    return;
  }
  next();
}

/** Prefer authenticated user's display name as actor. */
export function actorFrom(req: Request, fallback?: string): string {
  if (req.user?.fullName) return req.user.fullName;
  if (req.user?.username) return req.user.username;
  return (fallback || "").trim() || "system";
}
