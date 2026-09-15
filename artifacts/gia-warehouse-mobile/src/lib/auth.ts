import { customFetch, setAuthTokenGetter } from "@workspace/api-client-react";

export type AuthUser = {
  id: number;
  username: string;
  fullName: string;
  role: string;
};

const TOKEN_KEY = "gia-auth-token";
const USER_KEY = "gia-auth-user";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: AuthUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function installAuthFetch() {
  setAuthTokenGetter(() => getStoredToken());
}

export async function loginRequest(username: string, password: string) {
  return customFetch<{ token: string; user: AuthUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function fetchMe() {
  return customFetch<{ user: AuthUser }>("/api/auth/me");
}

export function isAdmin(role?: string | null) {
  return role === "owner" || role === "manager";
}

export function isWarehouseStaff(role?: string | null) {
  return role === "warehouse";
}
