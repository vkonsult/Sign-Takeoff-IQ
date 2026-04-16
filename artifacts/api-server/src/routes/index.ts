import express, { Router, type IRouter } from "express";
import healthRouter from "./health";
import uploadRouter from "./upload";
import jobsRouter from "./jobs";
import trainingRouter from "./training";
import adminRouter from "./admin";
import activityRouter from "./activity";
import vocabularyRouter from "./vocabulary";
import filesRouter from "./files";
import { requireAuth } from "../middlewares/authMiddleware";
import { LOGOS_DIR } from "../lib/storage";

const router: IRouter = Router();

router.use(healthRouter);

// Serve org logos without auth — images are referenced in <img> tags
router.use("/logos", express.static(LOGOS_DIR));

router.use(requireAuth);
router.use(uploadRouter);
router.use(jobsRouter);
router.use(trainingRouter);
router.use(adminRouter);
router.use(activityRouter);
router.use(vocabularyRouter);
router.use(filesRouter);

export default router;
