/**
 * Ensure at least one owner user exists on first boot.
 * Production requires AUTH_ADMIN_PASSWORD — never uses a hardcoded default there.
 */

import { eq } from "drizzle-orm";
import { db, appUsersTable } from "@workspace/db";
import { hashPassword } from "./password";
import { logger } from "../lib/logger";

export async function seedDefaultAdmin(): Promise<void> {
  const existing = await db.select({ id: appUsersTable.id }).from(appUsersTable).limit(1);
  if (existing.length) return;

  const username = (process.env.AUTH_ADMIN_USER || "admin").trim() || "admin";
  const fullName = process.env.AUTH_ADMIN_NAME || "Owner";
  const isProd = process.env.NODE_ENV === "production";
  const passwordFromEnv = process.env.AUTH_ADMIN_PASSWORD?.trim();

  if (isProd && !passwordFromEnv) {
    throw new Error(
      "AUTH_ADMIN_PASSWORD is required in production when seeding the first admin user. Refusing to use a default password.",
    );
  }

  const password = passwordFromEnv || "admin123";
  if (!passwordFromEnv) {
    logger.warn(
      { username },
      "Seeded development admin with default password — set AUTH_ADMIN_PASSWORD before any shared/production deploy",
    );
  } else {
    logger.warn({ username }, "Seeded first admin user from AUTH_ADMIN_* env (change password after first login)");
  }

  await db.insert(appUsersTable).values({
    username,
    passwordHash: hashPassword(password),
    fullName,
    role: "owner",
    active: "yes",
  });
}

export async function findActiveUserByUsername(username: string) {
  const rows = await db.select().from(appUsersTable).where(eq(appUsersTable.username, username)).limit(1);
  const user = rows[0];
  if (!user || user.active !== "yes") return null;
  return user;
}
