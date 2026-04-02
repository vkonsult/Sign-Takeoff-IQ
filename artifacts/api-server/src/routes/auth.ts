import { Router, type IRouter } from "express";
import crypto from "crypto";

const router: IRouter = Router();

const SUPER_ADMIN_GUEST_TOKEN = process.env.SUPER_ADMIN_GUEST_TOKEN;
const GUEST_JWT_SECRET = process.env.GUEST_JWT_SECRET ?? SUPER_ADMIN_GUEST_TOKEN ?? "";
const GUEST_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function signGuestToken(): string {
  const exp = Date.now() + GUEST_TOKEN_TTL_MS;
  const payload = `guest.${exp}`;
  const sig = crypto
    .createHmac("sha256", GUEST_JWT_SECRET)
    .update(payload)
    .digest("hex");
  return `${payload}.${sig}`;
}

export function verifyGuestToken(token: string): boolean {
  if (!GUEST_JWT_SECRET || !SUPER_ADMIN_GUEST_TOKEN) return false;
  if (!token.startsWith("guest.")) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [, expStr, sig] = parts as [string, string, string];
  const exp = parseInt(expStr, 10);
  if (isNaN(exp) || Date.now() > exp) return false;
  const payload = `guest.${expStr}`;
  const expected = crypto
    .createHmac("sha256", GUEST_JWT_SECRET)
    .update(payload)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
}

router.get("/auth/guest-available", (_req, res) => {
  res.json({ available: !!SUPER_ADMIN_GUEST_TOKEN });
});

router.post("/auth/guest", (_req, res) => {
  if (!SUPER_ADMIN_GUEST_TOKEN) {
    res.status(403).json({ error: "Guest access not enabled" });
    return;
  }
  res.json({ token: signGuestToken() });
});

export default router;
