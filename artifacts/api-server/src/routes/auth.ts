import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { isRole } from "../auth/roles";
import { verifyPassword } from "../auth/password";
import { findActiveUserByUsername } from "../auth/seed";
import { signToken } from "../auth/token";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Username and password required" });
    return;
  }

  const user = await findActiveUserByUsername(parsed.data.username.trim());
  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  if (!isRole(user.role)) {
    res.status(500).json({ error: "User role misconfigured" });
    return;
  }

  const authUser = {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
  };
  const token = signToken(authUser);
  res.json({
    token,
    user: authUser,
  });
});

router.get("/auth/me", requireAuth, (req, res): void => {
  res.json({ user: req.user });
});

router.post("/auth/logout", (_req, res): void => {
  res.json({ ok: true });
});

export default router;
