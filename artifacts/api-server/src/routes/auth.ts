import { Router, type IRouter } from "express";

const router: IRouter = Router();

const SUPER_ADMIN_GUEST_TOKEN = process.env.SUPER_ADMIN_GUEST_TOKEN;

router.get("/auth/guest-available", (_req, res) => {
  res.json({ available: !!SUPER_ADMIN_GUEST_TOKEN });
});

export default router;
